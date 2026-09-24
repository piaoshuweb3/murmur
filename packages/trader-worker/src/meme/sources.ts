// meme/sources.ts — the data-source abstraction for the meme monitoring channel.
//
// Design goal (from the 二次开发 spec): one stable interface, pluggable providers. The initial
// implementation shipped a NULL provider that returned zero observations; the channel then reported
// safe neutral indicators and the swarm felt nothing, so MEME_ENABLED="true" alone could never
// destabilise a live deployment. This file now hosts the PROVIDER REGISTRY (P0-1 of the task list):
// real providers slot in behind fetchMemeSignals() selected purely by env, without touching callers:
//   · dexscreener — keyless multi-chain aggregated pairs (Solana + Base + ETH), the zero-config default
//   · helius      — Helius deep scan for Solana: batched JSON-RPC (supply / largest accounts /
//                   signature rates) + the Enhanced Transactions API for new-pool events
//   · bitquery    — Bitquery GraphQL DEX-trade aggregation (keyed alternative, spec's "二选一")
// With no MEME_SOURCE_* configured the registry stays empty and the channel remains exactly the
// shipped v0 behaviour (safe neutral) — default behaviour is byte-for-byte unchanged.
//
// Providers MUST be read-only, best-effort and fail-soft: a flaky provider degrades the channel to
// neutral, it never throws into the cron tick (state.ts additionally wraps the whole sample in a
// try/catch for belt-and-braces).

import type { Env } from "../config.js";
import type { MemeChain, MemeObservation } from "./types.js";
import { makeDexScreenerProvider } from "./sources-dexscreener.js";
import { makeHeliusProvider } from "./sources-helius.js";
import { makeBitqueryProvider } from "./sources-bitquery.js";

/** Sampling window descriptor handed to every provider. */
export interface MemeWindow {
  /** How far back to scan for brand-new pools (ms). Default 15 min to match the launch-heat window. */
  newPoolWindowMs: number;
  /** Volume baseline window (ms). Default 1 h — the EWMA reference the spike detector normalises against. */
  volumeBaselineMs: number;
}

export const DEFAULT_MEME_WINDOW: MemeWindow = {
  newPoolWindowMs: 15 * 60_000,
  volumeBaselineMs: 60 * 60_000,
};

/**
 * The ONE function every provider implements. Returns the raw observations for a chain over the
 * requested window; the indicators module reduces them. Empty array = "nothing seen" (NOT an error).
 */
export type MemeSourceProvider = (
  chain: MemeChain,
  window: MemeWindow,
) => Promise<MemeObservation[]>;

/**
 * The active provider registry. Keys are chain names; an absent key simply means that chain is not
 * sampled. Rebuilt from env on EVERY tick by configureMemeProviders() — no stale state can survive
 * a config change, and the cost is a handful of closures per cron (negligible).
 */
const PROVIDERS: Partial<Record<MemeChain, MemeSourceProvider>> = {};

/**
 * (Re)build the provider registry from env (P0-1 wiring point — called by indicators.ts each tick).
 * Selection is explicit and per-chain; anything unrecognised or empty means "no provider for that
 * chain" → fetchMemeSignals resolves [] → safe neutral indicators. NO provider here can trade,
 * hold a key or move money: this layer is strictly read-only observation.
 */
export function configureMemeProviders(env: Env): void {
  // Clear first — a config change must never leave a stale provider registered.
  for (const k of Object.keys(PROVIDERS) as MemeChain[]) delete PROVIDERS[k];

  const pick = (v: string | undefined): string => (v ?? "").trim().toLowerCase();

  // Solana: the spec's P0-1 primary target — Helius / Bitquery 二选一, or keyless DexScreener.
  const sol = pick(env.MEME_SOURCE_SOLANA);
  if (sol === "helius") PROVIDERS.solana = makeHeliusProvider(env);
  else if (sol === "bitquery") PROVIDERS.solana = makeBitqueryProvider(env);
  else if (sol === "dexscreener") PROVIDERS.solana = makeDexScreenerProvider(env);

  // Base / ETH: aggregated pairs cover both cleanly (P0-2's Uniswap/Aerodrome event scan is the
  // deeper alternative once the operator runs dedicated RPCs).
  if (pick(env.MEME_SOURCE_BASE) === "dexscreener") PROVIDERS.base = makeDexScreenerProvider(env);
  if (pick(env.MEME_SOURCE_ETH) === "dexscreener") PROVIDERS.eth = makeDexScreenerProvider(env);
  // "arc" intentionally has no provider: Arc's own MarketMeter is the primary temperature source.
}

/**
 * Fetch meme observations for one chain. Chains without a registered provider resolve to [] so the
 * caller can fan out over every chain it cares about without per-chain feature checks.
 */
export async function fetchMemeSignals(
  chain: MemeChain,
  window: MemeWindow = DEFAULT_MEME_WINDOW,
): Promise<MemeObservation[]> {
  const provider = PROVIDERS[chain];
  if (!provider) return [];
  try {
    return (await provider(chain, window)) ?? [];
  } catch {
    // Fail-soft: a broken provider must never break the channel (indicators fall back to neutral).
    return [];
  }
}

/** The chains the channel currently fans out over, in sampling order. */
export const MEME_CHAINS: MemeChain[] = ["solana", "base", "eth", "arc"];

/** Test/inspection hook: which chains currently have a provider registered. */
export function configuredProviderChains(): MemeChain[] {
  return (Object.keys(PROVIDERS) as MemeChain[]).filter((c) => PROVIDERS[c] != null);
}
