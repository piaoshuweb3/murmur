// execution/decimals.ts — dynamic token decimals (P0-3, the HARD GATE before live selling).
//
// Why this module exists: a SELL intent must name the raw token amount ("sell 2_500_000_000 base
// units"). The number of decimal places that converts human units ↔ raw units is a PER-MINT on-chain
// property. The v1 skeleton assumed 6 decimals everywhere (the USDC convention) — honest for shadow
// paper fills, silently WRONG for a 9-decimal token (a sell 10⁶× too small) or a 5-decimal one
// (10× too large). The 二次开发 doc's §10 risk #9 therefore says: no verified decimals ⇒ NO live sell.
// This module is that verification, and the gate is enforced in adapter.ts.
//
// Resolution order (first hit wins, then cached forever — decimals are immutable per mint):
//   Solana:  1. Helius JSON-RPC  getTokenSupply   (mainnet.helius-rpc.com, HELIUS_API_KEY)
//            2. generic RPC       getTokenSupply   (SOLANA_RPC_URL — any Solana endpoint works)
//            3. known-mints table (USDC / WSOL / a few watchlist staples — curated constants)
//   EVM:     1. eth_call decimals() selector (0x313ce567) against the chain's RPC
//   Fails SOFT: any transport error → next source → null. A null means "unverified" — the caller
//   (adapter) decides: live ⇒ hard-gate the sell; shadow ⇒ documented 6-dec fallback.
//
// Everything is offline-testable: fetchImpl and env are injectable, and the cache can be reset.

import type { Env } from "../config.js";
import { jupiterPrices } from "../meme/sources-helius.js";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;

/** Curated decimals for mints we ship with (kept tiny — it is a LAST resort, never the primary path). */
export const KNOWN_DECIMALS: Record<string, number> = {
  // Solana (keys quoted uniformly — some mints start with digits and some EVM addresses parse as hex numbers)
  "So11111111111111111111111111111111111111112": 9, // WSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6, // USDC (Solana)
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": 5, // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": 6, // PENGU
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": 6, // POPCAT
  "85VBFQZC9TZkfaptBWjvBWwvvNYAqX1a2nKETsoxiv2G": 6, // W (Wormhole)
  // Base / Ethereum — keys MUST be lowercase: evmDecimals() looks up `token.toLowerCase()`
  // (EVM addresses are case-insensitive; the checksummed display form must not become the table key)
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6, // USDC (Base)
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 6, // USDC (Ethereum)
  "0x532f27101965dd16442e59d40670faf5ebb142e4": 18, // BRETT (Base)
  "0x6982508145454ce325ddbe47a25d4ec3d2311933": 18, // PEPE (Ethereum)
};

// ----------------------------- per-isolate cache -----------------------------

const cache = new Map<string, { decimals: number; source: string }>();

const cacheKey = (chain: string, token: string): string => `${chain}:${token.toLowerCase()}`;

/** Test hook — clears the module cache so each test starts from a cold registry. */
export function resetDecimalsCache(): void {
  cache.clear();
}

export interface DecimalsInfo {
  decimals: number;
  source: string; // "helius" | "rpc" | "known" | "evm-rpc" — audit provenance
}

/** Cached lookup; returns null when the token's decimals are UNVERIFIED (the P0-3 gate condition). */
export async function getTokenDecimals(
  chain: string,
  token: string,
  env: Env,
  fetchImpl: FetchImpl = fetch,
): Promise<DecimalsInfo | null> {
  const key = cacheKey(chain, token);
  const hit = cache.get(key);
  if (hit) return hit;

  const resolved =
    chain === "solana"
      ? await solanaDecimals(token, env, fetchImpl)
      : await evmDecimals(chain, token, env, fetchImpl);
  if (resolved) cache.set(key, resolved);
  return resolved ?? null;
}

/** Human units → raw integer units as a string (the only conversion this module vouches for). */
export function toRawAmount(humanAmount: number, decimals: number): string {
  if (!Number.isFinite(humanAmount) || humanAmount < 0 || !Number.isInteger(decimals) || decimals < 0) {
    return "0";
  }
  return BigInt(Math.round(humanAmount * 10 ** decimals)).toString();
}

// ----------------------------- Solana -----------------------------

type SupplyValue = { decimals?: number; amount?: string; uiAmount?: number };

/**
 * One getTokenSupply JSON-RPC call against ANY Solana endpoint. Returns decimals, or null on any
 * failure/shape mismatch (fail-soft — the next source gets its turn).
 */
async function rpcGetTokenSupply(rpcUrl: string, mint: string, fetchImpl: FetchImpl): Promise<number | null> {
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [mint] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { value?: SupplyValue }; error?: unknown };
    const decimals = body.result?.value?.decimals;
    return typeof decimals === "number" && decimals >= 0 && decimals <= 255 ? decimals : null;
  } catch {
    return null;
  }
}

async function solanaDecimals(mint: string, env: Env, fetchImpl: FetchImpl): Promise<DecimalsInfo | null> {
  // 1) Helius (the P0-1 deep-scan key is usually already provisioned).
  const heliusKey = (env.HELIUS_API_KEY ?? "").trim();
  if (heliusKey) {
    const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}`;
    const decimals = await rpcGetTokenSupply(url, mint, fetchImpl);
    if (decimals != null) return { decimals, source: "helius" };
  }
  // 2) The execution RPC (SOLANA_RPC_URL — also what the signer broadcasts through).
  const rpc = (env.SOLANA_RPC_URL ?? "").trim();
  if (rpc) {
    const decimals = await rpcGetTokenSupply(rpc, mint, fetchImpl);
    if (decimals != null) return { decimals, source: "rpc" };
  }
  // 3) The curated table (last resort; constants above are the only entries it vouches for).
  const known = KNOWN_DECIMALS[mint];
  if (known != null) return { decimals: known, source: "known" };
  return null;
}

// ----------------------------- EVM -----------------------------

/** decimals() = 0x313ce567 (no args). Returns a 32-byte hex word we parse from the eth_call result. */
const EVM_DECIMALS_SELECTOR = "0x313ce567";

async function evmDecimals(chain: string, token: string, env: Env, fetchImpl: FetchImpl): Promise<DecimalsInfo | null> {
  if (chain !== "base" && chain !== "eth") return null;
  const known = KNOWN_DECIMALS[token.toLowerCase()];
  const rpc = (chain === "base" ? env.BASE_RPC_URL : env.ETH_RPC_URL ?? env.BASE_RPC_URL ?? "") ?? "";
  if (!rpc) {
    // No RPC wired: fall back to the curated table only (USDC etc.), else unverified.
    return known != null ? { decimals: known, source: "known" } : null;
  }
  try {
    const res = await fetchImpl(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: token, data: EVM_DECIMALS_SELECTOR }, "latest"],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`eth_call ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    const hex = body.result;
    if (typeof hex !== "string" || hex === "0x") throw new Error(body.error?.message ?? "empty eth_call result");
    const decimals = Number(BigInt(hex));
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("decimals out of range");
    return { decimals, source: "evm-rpc" };
  } catch {
    return known != null ? { decimals: known, source: "known" } : null;
  }
}

// ----------------------------- adapter-side sell sizing -----------------------------

export interface SellSizing {
  raw: string;
  provenance: string; // "ledger" | "decimals+price" | "usd-6dec-assumption" — lands in the audit trail
}

/**
 * Size a SELL from the USD notional when the exit ledger could not supply raw units. Requires BOTH
 * verified decimals AND a live price (the ledger's value estimate is USD-denominated). Returns null
 * when either is missing — the adapter turns a null into the P0-3 hard gate on the live path.
 */
export async function sizeSellFromUsd(
  chain: string,
  token: string,
  amountUsd: number,
  env: Env,
  fetchImpl: FetchImpl = fetch,
): Promise<SellSizing | null> {
  const info = await getTokenDecimals(chain, token, env, fetchImpl);
  if (!info) return null;
  if (chain === "solana") {
    const prices = await jupiterPrices([token], fetchImpl);
    const price = prices.get(token);
    if (price == null || !(price > 0)) return null;
    return { raw: toRawAmount(amountUsd / price, info.decimals), provenance: `decimals=${info.decimals}(${info.source})+jup-price` };
  }
  // EVM: DexScreener's aggregated pairs carry a priceUsd — the meme channel already uses this feed.
  const { fetchDexScreenerPairs } = await import("../meme/sources-dexscreener.js");
  const pairs = await fetchDexScreenerPairs([token], fetchImpl);
  const price = pairs.find((p) => p.token.toLowerCase() === token.toLowerCase() && (p.priceUsd ?? 0) > 0)?.priceUsd;
  if (price == null || !(price > 0)) return null;
  return { raw: toRawAmount(amountUsd / price, info.decimals), provenance: `decimals=${info.decimals}(${info.source})+dexscreener-price` };
}
