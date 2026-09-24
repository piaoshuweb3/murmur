// meme/sources-dexscreener.ts — the keyless aggregated-pairs provider (P0-1/P0-2 workhorse).
//
// DexScreener's public API needs NO key and covers Solana + Base + Ethereum in one shape, which
// makes it the zero-config way to satisfy P0-1's acceptance criterion ("topSignals 有真实 token")
// locally and in CI. Per token it reports: pool creation time (pairCreatedAt), pool liquidity,
// trailing 5m/1h volume, 1h price change and the current mark price — everything the detectors and
// the exit layer consume. It is ALSO the mark-price feed for the execution layer's exit rules
// (execution/exits.ts imports fetchDexScreenerPairs directly).
//
// Endpoints (public, ~300 req/min limit — one batched call per chain per tick keeps us ~30× under):
//   GET https://api.dexscreener.com/latest/dex/tokens/{mints}   — up to 30 comma-joined addresses
//   → { pairs: [ { chainId, pairAddress, baseToken:{address}, pairCreatedAt, priceUsd,
//                 liquidity:{usd}, volume:{ m5, h1 }, priceChange:{ h1 } } ] }
//
// Fail-soft contract (sources.ts): any error → [] with a console.warn, never a throw into the tick.

import type { MemeChain, MemeObservation } from "./types.js";
import type { Env } from "../config.js";
import type { MemeSourceProvider } from "./sources.js";

/** DexScreener chain slugs → our MemeChain names (anything else is ignored). */
const CHAIN_SLUGS: Record<string, MemeChain> = {
  solana: "solana",
  base: "base",
  ethereum: "eth",
};

/** API caps 30 addresses per call; the watchlist is chunked to stay within one request batch. */
const CHUNK = 30;
const TIMEOUT_MS = 8_000;

/** One normalised pair, shared with the exit layer's mark-price feed. */
export interface DexPair {
  chain: MemeChain;
  pairAddress: string;
  token: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  volume1hUsd: number | null;
  priceChange1hPct: number | null;
  pairCreatedAtMs: number | null;
}
export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetch + normalise the DexScreener pairs for a list of token addresses (up to 30 per chunk,
 * chunked automatically). Pairs on chains we don't track (e.g. pulsechain forks of an EVM token)
 * and malformed rows are DROPPED here, not left to the callers. Resolves [] on any failure — the
 * caller decides what "no data" means.
 */
export async function fetchDexScreenerPairs(
  tokens: string[],
  fetchImpl: FetchImpl = fetch,
): Promise<DexPair[]> {
  const clean = [...new Set(tokens.map((t) => t.trim()).filter(Boolean))];
  if (clean.length === 0) return [];

  const pairs: DexPair[] = [];
  for (let i = 0; i < clean.length; i += CHUNK) {
    const chunk = clean.slice(i, i + CHUNK);
    try {
      const res = await fetchImpl(
        `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!res.ok) throw new Error(`dexscreener ${res.status}`);
      const body = (await res.json()) as { pairs?: unknown };
      if (!Array.isArray(body.pairs)) continue;
      for (const raw of body.pairs) {
        const p = normalisePair(raw);
        if (p) pairs.push(p); // unknown chain / unusable row → dropped
      }
    } catch (e) {
      // Fail-soft per chunk: a flaky chunk degrades to fewer pairs, never breaks the tick.
      console.warn("[meme] dexscreener chunk failed (non-fatal):", (e as Error).message);
    }
  }
  return pairs;
}

/**
 * Map one raw API pair onto our shape. Returns null for rows we must NOT use: unknown chains
 * (a pulsechain fork of a watchlisted EVM token must never leak into, say, the solana set — the
 * LIVE API does return such rows) and rows without a usable base-token address.
 */
function normalisePair(raw: unknown): DexPair | null {
  const r = raw as {
    chainId?: string;
    pairAddress?: string;
    baseToken?: { address?: string };
    priceUsd?: string;
    liquidity?: { usd?: number };
    volume?: { m5?: number; h1?: number };
    priceChange?: { h1?: number };
    pairCreatedAt?: number;
  };
  const chain = CHAIN_SLUGS[(r.chainId ?? "").toLowerCase()];
  const token = (r.baseToken?.address ?? "").trim();
  if (!chain || !token) return null;
  const num = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return {
    chain,
    pairAddress: r.pairAddress ?? "",
    token,
    priceUsd: num(r.priceUsd),
    liquidityUsd: num(r.liquidity?.usd),
    volume5mUsd: num(r.volume?.m5),
    volume1hUsd: num(r.volume?.h1),
    priceChange1hPct: num(r.priceChange?.h1),
    pairCreatedAtMs: num(r.pairCreatedAt),
  };
}

/**
 * The DexScreener provider: watchlist-driven observations for one chain.
 *
 * Watchlist (env): MEME_WATCHLIST_SOLANA / _BASE / _ETH — comma-separated token addresses. A
 * watchlist is DELIBERATE: open-ended "scan everything" needs a paid indexer (P3) and would burn
 * the free rate limit; a curated list of 5–20 candidate mints per chain gives the detectors real,
 * fresh data within one batched call.
 */
export function makeDexScreenerProvider(env: Env, fetchImpl: FetchImpl = fetch): MemeSourceProvider {
  const watchlistFor = (chain: MemeChain): string[] => {
    const raw =
      chain === "solana" ? env.MEME_WATCHLIST_SOLANA
      : chain === "base" ? env.MEME_WATCHLIST_BASE
      : chain === "eth" ? env.MEME_WATCHLIST_ETH
      : ""; // "arc" has no DexScreener coverage
    return (raw ?? "")
      .split(",")
      .map((s) => s.trim().split("|")[0]) // "mint|pool" entries (helius syntax) use the mint part
      .filter(Boolean);
  };

  return async (chain, _window) => {
    const tokens = watchlistFor(chain);
    if (tokens.length === 0) return [];
    const requested = new Set(tokens.map((t) => t.toLowerCase()));
    // CRITICAL filter: the API returns pairs where a watchlist token appears as BASE *or QUOTE* —
    // without this gate, some unrelated token's $9 pool (with our token merely as the quote side)
    // lands in the observation set and the rug detector reads it as a real liquidity collapse.
    const pairs = (await fetchDexScreenerPairs(tokens, fetchImpl)).filter((p) =>
      requested.has(p.token.toLowerCase()),
    );

    // Keep, per token, the deepest pair (max liquidity) — meme tokens often span 3+ pools and the
    // deepest one is where real exit liquidity lives.
    const best = new Map<string, DexPair>();
    for (const p of pairs) {
      if (p.chain !== chain || !p.token) continue;
      const prev = best.get(p.token);
      if (!prev || (p.liquidityUsd ?? 0) > (prev.liquidityUsd ?? 0)) best.set(p.token, p);
    }

    const obs: MemeObservation[] = [];
    for (const p of best.values()) {
      obs.push({
        token: p.token,
        chain,
        poolCreatedAtMs: p.pairCreatedAtMs ?? undefined,
        initialLiquidityUsd: p.liquidityUsd ?? undefined,
        volume5mUsd: p.volume5mUsd ?? undefined,
        volume1hUsd: p.volume1hUsd ?? undefined,
        priceChangePct1h: p.priceChange1hPct ?? undefined,
        priceUsd: p.priceUsd ?? undefined,
      });
    }
    return obs;
  };
}
