// meme/sources-bitquery.ts — the Bitquery GraphQL provider (P0-1's keyed alternative to Helius).
//
// The spec's P0-1 says "Helius/Bitquery 二选一" — this is the second option, for operators who
// already run a Bitquery subscription. It aggregates DEX trades per watchlist mint over the
// sampling window (count + base-token volume), which the detectors consume as the volume-proxy
// observation set (token-unit volume × mark price, mirroring the Helius signature proxy).
//
// Endpoint (v2): POST {BITQUERY_URL ?? "https://streaming.bitquery.io/graphql"}
//   Authorization: Bearer {BITQUERY_API_KEY}
//
//   query ($mints: [String!], $since: ISO8601) {
//     solana {
//       dexTrades(
//         base: { currency: { in: $mints } }
//         time: { after: $since }
//       ) {
//         count
//         baseAmount
//         baseCurrency { address }
//       }
//     }
//   }
//
// The response is parsed DEFENSIVELY (optional chains everywhere): a schema drift or a partial
// response degrades to [] — the fail-soft contract in sources.ts covers the rest. Mark prices come
// from the same keyless Jupiter Price limb the Helius provider uses.

import type { MemeChain, MemeObservation } from "./types.js";
import type { Env } from "../config.js";
import type { MemeSourceProvider, MemeWindow } from "./sources.js";
import { jupiterPrices, parseSolanaWatchlist, type FetchImpl } from "./sources-helius.js";

const TIMEOUT_MS = 10_000;

const QUERY = `
query ($mints: [String!], $since: ISO8601) {
  solana {
    dexTrades(
      base: { currency: { in: $mints } }
      time: { after: $since }
    ) {
      count
      baseAmount
      baseCurrency { address }
    }
  }
}`;

interface BitqueryTrade {
  count?: number;
  baseAmount?: number | string;
  baseCurrency?: { address?: string };
}

/**
 * The Bitquery provider. Requires BITQUERY_API_KEY; without it the provider returns [] (null
 * behaviour), exactly like the Helius provider without its key.
 */
export function makeBitqueryProvider(env: Env, fetchImpl: FetchImpl = fetch): MemeSourceProvider {
  return async (chain: MemeChain, window: MemeWindow): Promise<MemeObservation[]> => {
    if (chain !== "solana") return []; // v1 scope: the Solana dataset (EVM datasets are P0-2's job)
    const apiKey = (env.BITQUERY_API_KEY ?? "").trim();
    if (!apiKey) return [];

    const entries = parseSolanaWatchlist(env.MEME_WATCHLIST_SOLANA);
    if (entries.length === 0) return [];
    const mints = entries.map((e) => e.mint);

    const url = (env.BITQUERY_URL ?? "https://streaming.bitquery.io/graphql").trim();
    let trades: BitqueryTrade[] = [];
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query: QUERY,
          variables: {
            mints,
            since: new Date(Date.now() - window.volumeBaselineMs).toISOString(),
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`bitquery ${res.status}`);
      const body = (await res.json()) as { data?: { solana?: { dexTrades?: BitqueryTrade[] } } };
      trades = body.data?.solana?.dexTrades ?? [];
    } catch (e) {
      console.warn("[meme] bitquery query failed (non-fatal):", (e as Error).message);
      return [];
    }

    // Aggregate per mint: trade count + cumulative base-token amount over the window.
    const counts = new Map<string, number>();
    const amounts = new Map<string, number>();
    for (const t of trades) {
      const mint = (t.baseCurrency?.address ?? "").trim();
      if (!mint) continue;
      counts.set(mint, (counts.get(mint) ?? 0) + (typeof t.count === "number" ? t.count : 1));
      const amt = typeof t.baseAmount === "string" ? Number(t.baseAmount) : t.baseAmount;
      if (typeof amt === "number" && Number.isFinite(amt)) {
        amounts.set(mint, (amounts.get(mint) ?? 0) + amt);
      }
    }

    // Token-unit volume × mark price → USD proxy (the detectors normalise ratios, so a consistent
    // proxy is sufficient; P1-3 replaces the marks with the audited price feed).
    const marks = await jupiterPrices(mints, fetchImpl);
    const obs: MemeObservation[] = [];
    for (const entry of entries) {
      const price = marks.get(entry.mint);
      const tokens = amounts.get(entry.mint);
      const usd = price != null && tokens != null ? tokens * price : undefined;
      obs.push({
        token: entry.mint,
        chain: "solana",
        volume1hUsd: usd,
        volume5mUsd: usd != null ? usd * (5 / 60) : undefined, // pro-rata share of the 1h window
        priceUsd: price,
      });
    }
    return obs;
  };
}
