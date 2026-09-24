// meme/indicators.ts — reduce the raw observations into the channel's indicator set + snapshot.
//
// This is the module the 二次开发 spec calls "最小可用 meme/indicators.ts": computeMemeIndicators()
// is the single entry point MarketMeter/state.ts consume. With NO providers registered (the shipped
// v0 state) it returns SAFE NEUTRAL values — overallHeat 0.5, NEUTRAL regime, empty top signals —
// so flipping MEME_ENABLED="true" changes nothing material until a real data source is wired.
//
// The overallHeat weights come from the spec:
//   launchHeat 0.25 · volumeSpike 0.30 · smartMoneyFlow 0.25 · socialMomentum 0.15 · liquidityHealth 0.05
// (liquidityHealth is deliberately tiny in the heat blend — it is a RISK gate, not an excitement
// signal; its real job is the RUG_RISK regime override and the execution layer's blacklist.)

import type { Env } from "../config.js";
import { fetchMemeSignals, MEME_CHAINS, DEFAULT_MEME_WINDOW, configureMemeProviders } from "./sources.js";
import {
  detectNewPools as launchHeatOf,
  detectPriceVelocity,
  detectRugFeatures,
  detectSmartMoneyFlow,
  detectSocialMomentum,
  detectVolumeSpikes,
  scoreSignals,
} from "./detectors.js";
import type { MemeIndicators, MemeSnapshot } from "./types.js";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The spec's heat weights (sum ≈ 1; liquidityHealth enters the blend marginally). */
const HEAT_WEIGHTS = {
  launchHeat: 0.25,
  volumeSpike: 0.3,
  smartMoneyFlow: 0.25,
  socialMomentum: 0.15,
  liquidityHealth: 0.05,
} as const;

/** Safe neutral fallback — what an unconfigured channel reports (spec: "初期返回安全中性值"). */
export function neutralIndicators(): MemeIndicators {
  return {
    launchHeat: 0.5,
    volumeSpike: 0.5,
    smartMoneyFlow: 0.5,
    socialMomentum: 0.5,
    liquidityHealth: 1.0,
    holderConcentration: 0.2,
    priceVelocity: 0.5,
    topSignals: [],
  };
}

/** Compute the raw indicator set from every configured provider (fail-soft per chain). */
export async function computeMemeIndicators(env: Env): Promise<MemeIndicators> {
  // (Re)build the provider registry from env — P0-1's wiring point (no-op until MEME_SOURCE_* is set,
  // which keeps the shipped default behaviour byte-for-byte identical to the null-provider channel).
  configureMemeProviders(env);
  // Fan out over every chain; chains without a provider contribute zero observations.
  const perChain = await Promise.all(
    MEME_CHAINS.map((chain) => fetchMemeSignals(chain, DEFAULT_MEME_WINDOW)),
  );
  const observations = perChain.flat();

  if (observations.length === 0) return neutralIndicators();

  const launchHeat = launchHeatOf(observations, DEFAULT_MEME_WINDOW.newPoolWindowMs);
  const volumeSpike = detectVolumeSpikes(observations);
  const smartMoneyFlow = detectSmartMoneyFlow(observations);
  const socialMomentum = detectSocialMomentum(observations);
  const liquidityHealth = detectRugFeatures(observations);
  const priceVelocity = detectPriceVelocity(observations);

  // Holder concentration reported by the channel is the WORST (max) share among the top candidates —
  // it is the number the RUG_RISK override is judged against.
  let holderConcentration = 0;
  for (const o of observations) {
    const c = o.top10HolderShare;
    if (c != null && c > holderConcentration) holderConcentration = c;
  }

  return {
    launchHeat,
    volumeSpike,
    smartMoneyFlow,
    socialMomentum,
    liquidityHealth,
    holderConcentration,
    priceVelocity,
    topSignals: scoreSignals(observations).slice(0, 8),
  };
}

/** Fold the raw indicators into the 0..1 composite heat using the spec's weights. */
export function overallHeatOf(ind: MemeIndicators): number {
  return clamp01(
    ind.launchHeat * HEAT_WEIGHTS.launchHeat +
      ind.volumeSpike * HEAT_WEIGHTS.volumeSpike +
      ind.smartMoneyFlow * HEAT_WEIGHTS.smartMoneyFlow +
      ind.socialMomentum * HEAT_WEIGHTS.socialMomentum +
      ind.liquidityHealth * HEAT_WEIGHTS.liquidityHealth,
  );
}

/**
 * RUG_RISK override thresholds (spec: liquidityHealth < 0.3 OR holderConcentration > 0.45), each
 * tunable via env so an operator can tighten them without a code change.
 */
export function memeRegimeOf(ind: MemeIndicators, env: Env): MemeSnapshot["regime"] {
  const heat = overallHeatOf(ind);
  const rugConc = Number(env.MEME_RUG_CONCENTRATION ?? "0.45");
  const rugLiq = Number(env.MEME_RUG_LIQUIDITY ?? "0.3");
  if (ind.liquidityHealth < rugLiq || ind.holderConcentration > rugConc) return "RUG_RISK";
  if (heat > 0.75) return "PUMP";
  if (heat < 0.25) return "DUMP";
  return "NEUTRAL";
}

/** One-call sampling entry: indicators → MemeSnapshot (the shape state.ts fuses + logs). */
export async function sampleMeme(env: Env): Promise<MemeSnapshot> {
  const ind = await computeMemeIndicators(env);
  const heat = overallHeatOf(ind);
  return {
    overallHeat: heat,
    regime: memeRegimeOf(ind, env),
    topSignals: ind.topSignals,
    raw: {
      launchHeat: ind.launchHeat,
      volumeSpike: ind.volumeSpike,
      smartMoneyFlow: ind.smartMoneyFlow,
      socialMomentum: ind.socialMomentum,
      liquidityHealth: ind.liquidityHealth,
    },
  };
}
