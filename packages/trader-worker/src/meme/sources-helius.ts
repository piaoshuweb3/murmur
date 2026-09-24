// meme/sources-helius.ts — the Helius provider for Solana (P0-1, the spec's "Helius/Bitquery 二选一").
//
// The DEEP on-chain scan: where DexScreener aggregates UI-level pair data, Helius reads the chain
// itself. This provider uses both Helius surfaces:
//
//   1. Helius JSON-RPC (POST https://mainnet.helius-rpc.com/?api-key=…, supports BATCH arrays):
//        · getTokenSupply(mint)            → circulating supply + decimals (holder-share denominator)
//        · getTokenLargestAccounts(mint)   → top-20 balances → top10HolderShare (the RUG_RISK input)
//        · getSignaturesForAddress(pool)   → per-pool swap-rate timeline → volume PROXY
//          (sig counts in 1m/5m/1h × MEME_AVG_TRADE_USD — a proxy, not actual USD; the doc's
//           P1-3 price-oracle task replaces the constant with real marks)
//
//   2. Helius Enhanced Transactions API (GET https://api.helius.xyz/v0/addresses/{addr}/transactions):
//        · per PROGRAM (Raydium V4 / Pump.fun AMM …): parsed recent txs; type "CREATE" (or an
//          initialize-style description) = a brand-new pool → poolCreatedAtMs + the token mint,
//          feeding the launch-heat detector with REAL new-pool events.
//
//   3. Mark prices via the keyless Jupiter Price API (no Helius key needed; fails soft per mint).
//
// Everything is bounded and fail-soft: MAX_TOKENS caps the per-tick RPC fan-out, a 10 s timeout
// guards every fetch, and a failed limb is skipped with a warning — a degraded Helius must degrade
// the channel to neutral, never break the cron tick.

import type { MemeChain, MemeObservation } from "./types.js";
import type { Env } from "../config.js";
import type { MemeSourceProvider, MemeWindow } from "./sources.js";

// Defaults for the new-pool scan (overridable via MEME_HELIUS_PROGRAMS).
const DEFAULT_PROGRAMS = [
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium Liquidity Pool V4 (initialize2)
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // Pump.fun AMM (migrated pools)
];

const WSOL = "So11111111111111111111111111111111111111112";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const MAX_TOKENS = 10;          // per-tick cap on deep-scanned mints (bounds the RPC fan-out)
const SIG_SAMPLE = 300;         // signatures fetched per pool (≈ recent activity horizon)
const TIMEOUT_MS = 10_000;

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** One watchlist entry: "mint|pool" — the pool address is optional (holder data alone). */
export interface WatchEntry {
  mint: string;
  pool: string | null;
}

/** Parse MEME_WATCHLIST_SOLANA ("mint,mint|pool,mint|pool"). Malformed entries are skipped. */
export function parseSolanaWatchlist(raw: string | undefined): WatchEntry[] {
  const out: WatchEntry[] = [];
  for (const piece of (raw ?? "").split(",")) {
    const s = piece.trim();
    if (!s) continue;
    const [mint, pool] = s.split("|").map((p) => p.trim());
    if (mint) out.push({ mint, pool: pool || null });
  }
  return out.slice(0, MAX_TOKENS);
}

// ----------------------------- JSON-RPC (batched) -----------------------------

type RpcResult = { result?: { value?: unknown; uiAmount?: number; amount?: string; decimals?: number }; error?: unknown };

/**
 * One batched JSON-RPC call: N method invocations in a single HTTP round-trip. Returns the
 * per-request results IN ORDER (JSON-RPC batch semantics), or null on any transport failure.
 */
async function heliusRpcBatch(
  rpcUrl: string,
  calls: Array<{ method: string; params: unknown[] }>,
  fetchImpl: FetchImpl,
): Promise<RpcResult[] | null> {
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, ...c }))),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`helius rpc ${res.status}`);
    const body = (await res.json()) as RpcResult[];
    return Array.isArray(body) ? body : null;
  } catch (e) {
    console.warn("[meme] helius rpc batch failed (non-fatal):", (e as Error).message);
    return null;
  }
}

/** Top-10 holder share from getTokenLargestAccounts (top-20) + getTokenSupply. */
function top10ShareOf(supply: RpcResult | undefined, largest: RpcResult | undefined): number | undefined {
  const supplyValue = supply?.result?.value as { uiAmount?: number } | undefined;
  const supplyUi = supplyValue?.uiAmount;
  const accounts = largest?.result?.value as Array<{ uiAmount?: number }> | undefined;
  if (typeof supplyUi !== "number" || supplyUi <= 0 || !Array.isArray(accounts)) return undefined;
  const balances = accounts
    .map((a) => a.uiAmount ?? 0)
    .sort((a, b) => b - a)
    .slice(0, 10);
  const sum = balances.reduce((s, b) => s + b, 0);
  const share = sum / supplyUi;
  return Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : undefined;
}

/** Swap-count timeline → USD volume proxy (count × MEME_AVG_TRADE_USD) over 1m/5m/1h windows. */
function volumeProxyFromSignatures(
  sigs: RpcResult | undefined,
  now: number,
  avgTradeUsd: number,
): { v1m: number; v5m: number; v1h: number } | null {
  const arr = sigs?.result?.value;
  if (!Array.isArray(arr)) return null;
  let v1m = 0, v5m = 0, v1h = 0;
  for (const s of arr) {
    const bt = (s as { blockTime?: number }).blockTime;
    if (typeof bt !== "number") continue;
    const ageMs = now - bt * 1000;
    if (ageMs <= 60_000) v1m++;
    if (ageMs <= 300_000) v5m++;
    if (ageMs <= 3_600_000) v1h++;
  }
  return { v1m: v1m * avgTradeUsd, v5m: v5m * avgTradeUsd, v1h: v1h * avgTradeUsd };
}

// ----------------------------- Enhanced Transactions API -----------------------------

interface EnhancedTx {
  timestamp?: number;
  type?: string;
  description?: string;
  tokenTransfers?: Array<{ mint?: string; tokenAmount?: number }>;
}

/**
 * New-pool events from one program's parsed transaction feed: a "CREATE"-typed (or
 * initialize-described) tx whose token transfers carry a non-SOL/USDC mint = a pool that just came
 * into existence. Returns mint + creation time; liquidity at birth is unknown (the detectors treat
 * missing liquidity as "not scored yet" — launch heat counts the breadth limb).
 */
async function newPoolsFromProgram(
  apiKey: string,
  program: string,
  windowMs: number,
  now: number,
  fetchImpl: FetchImpl,
): Promise<Array<{ mint: string; createdAtMs: number }>> {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${program}/transactions?api-key=${encodeURIComponent(apiKey)}&limit=50`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`helius enhanced ${res.status}`);
    const txs = (await res.json()) as EnhancedTx[];
    if (!Array.isArray(txs)) return [];
    const out: Array<{ mint: string; createdAtMs: number }> = [];
    for (const tx of txs) {
      const created =
        tx.type === "CREATE" || /initialize|create/i.test(tx.description ?? "");
      if (!created || typeof tx.timestamp !== "number") continue;
      const createdAtMs = tx.timestamp * 1000;
      if (now - createdAtMs > windowMs) continue; // older than the launch window → not "new"
      const mint = (tx.tokenTransfers ?? []).map((t) => (t.mint ?? "").trim())
        .find((m) => m && m !== WSOL && m !== USDC_SOL);
      if (mint) out.push({ mint, createdAtMs });
    }
    return out;
  } catch (e) {
    console.warn("[meme] helius program scan failed (non-fatal):", (e as Error).message);
    return [];
  }
}

/** Keyless Jupiter Price v2 marks (batched ids) — the providers' shared price limb (also used by bitquery). */
export async function jupiterPrices(
  mints: string[],
  fetchImpl: FetchImpl,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (mints.length === 0) return out;
  try {
    const url = `https://lite-api.jup.ag/price/v2?ids=${encodeURIComponent(mints.join(","))}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`jupiter price ${res.status}`);
    const body = (await res.json()) as { data?: Record<string, { price?: string }> };
    for (const [mint, v] of Object.entries(body.data ?? {})) {
      const p = Number(v?.price);
      if (Number.isFinite(p) && p > 0) out.set(mint, p);
    }
  } catch (e) {
    console.warn("[meme] jupiter price failed (non-fatal):", (e as Error).message);
  }
  return out;
}

// ----------------------------- the provider -----------------------------

/**
 * The complete Helius provider (P0-1). Requires HELIUS_API_KEY; without it the provider returns []
 * (the null-provider behaviour) so an operator can enable the flag before the key arrives without
 * seeing errors. The injectable fetchImpl keeps the unit tests fully offline.
 */
export function makeHeliusProvider(env: Env, fetchImpl: FetchImpl = fetch): MemeSourceProvider {
  return async (chain: MemeChain, window: MemeWindow): Promise<MemeObservation[]> => {
    if (chain !== "solana") return []; // Helius is Solana-only by definition
    const apiKey = (env.HELIUS_API_KEY ?? "").trim();
    if (!apiKey) return [];

    const now = Date.now();
    const entries = parseSolanaWatchlist(env.MEME_WATCHLIST_SOLANA);
    const avgTradeUsd = Number(env.MEME_AVG_TRADE_USD ?? "250") || 250;

    // ---- Limb A: brand-new pools from the configured programs (Enhanced Transactions API). ----
    const programs = (env.MEME_HELIUS_PROGRAMS ?? DEFAULT_PROGRAMS.join(","))
      .split(",").map((s) => s.trim()).filter(Boolean);
    const obs: MemeObservation[] = [];
    const seenNew = new Set<string>();
    for (const program of programs) {
      const fresh = await newPoolsFromProgram(apiKey, program, window.newPoolWindowMs, now, fetchImpl);
      for (const f of fresh) {
        if (seenNew.has(f.mint)) continue;   // the same pool may surface on two programs
        seenNew.add(f.mint);
        obs.push({ token: f.mint, chain: "solana", poolCreatedAtMs: f.createdAtMs });
      }
    }

    // ---- Limb B: deep scan of the watchlist (batched RPC) — holders, supply, volume proxy. ----
    if (entries.length > 0) {
      const mints = entries.map((e) => e.mint);
      const pools = entries.filter((e) => e.pool).map((e) => e.pool as string);

      // Batch 1: supply + largest accounts for every watchlist mint (2 calls per mint, ONE request).
      const batch1: Array<{ method: string; params: unknown[] }> = [];
      for (const mint of mints) {
        batch1.push({ method: "getTokenSupply", params: [mint] });
        batch1.push({ method: "getTokenLargestAccounts", params: [mint] });
      }
      const res1 = await heliusRpcBatch(
        `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`,
        batch1,
        fetchImpl,
      );

      // Batch 2: signature timelines for every watchlist pool (ONE request).
      let sigs: (RpcResult | undefined)[] | null = null;
      if (pools.length > 0) {
        const res2 = await heliusRpcBatch(
          `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`,
          pools.map((p) => ({ method: "getSignaturesForAddress", params: [p, { limit: SIG_SAMPLE }] })),
          fetchImpl,
        );
        sigs = res2 ?? null;
      }

      const marks = await jupiterPrices(mints, fetchImpl);

      entries.forEach((entry, i) => {
        if (res1 == null) return; // transport died — the deep scan contributes nothing this tick
        const supply = res1[i * 2];
        const largest = res1[i * 2 + 1];
        const poolIdx = entry.pool ? pools.indexOf(entry.pool) : -1;
        const vol = poolIdx >= 0 ? volumeProxyFromSignatures(sigs?.[poolIdx], now, avgTradeUsd) : null;
        obs.push({
          token: entry.mint,
          chain: "solana",
          top10HolderShare: top10ShareOf(supply, largest),
          volume1mUsd: vol?.v1m,
          volume5mUsd: vol?.v5m,
          volume1hUsd: vol?.v1h,
          priceUsd: marks.get(entry.mint),
        });
      });
    }

    return obs;
  };
}
