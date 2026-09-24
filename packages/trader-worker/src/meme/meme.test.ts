// Meme-channel tests — the monitoring layer stays safe-by-default and honest about what it knows.
//
// The 二次开发 spec's core safety idea for the meme channel: with no data providers wired, the channel
// reports SAFE NEUTRAL values (flipping MEME_ENABLED alone must change nothing material), and the
// RUG_RISK override must fire on the exact thresholds the spec pins (liquidityHealth < 0.3 OR
// holderConcentration > 0.45). These tests enforce both, plus the heat blend's weights and the
// detectors' risk-discount behaviour, entirely offline.

import test from "node:test";
import assert from "node:assert/strict";

import { neutralIndicators, overallHeatOf, memeRegimeOf, sampleMeme } from "./indicators.js";
import { detectNewPools, detectVolumeSpikes, detectRugFeatures, scoreSignals } from "./detectors.js";
import type { MemeObservation } from "./types.js";

function env(over: Record<string, string> = {}): any {
  return { MEME_WEIGHT: "0.35", MEME_RUG_CONCENTRATION: "0.45", MEME_RUG_LIQUIDITY: "0.3", ...over };
}

test("neutral fallback: no providers ⇒ safe neutral indicators and an empty signal board", async () => {
  const snap = await sampleMeme(env()); // v0 ships zero providers
  assert.equal(snap.regime, "NEUTRAL");
  assert.deepEqual(snap.topSignals, []);
  assert.equal(snap.raw.liquidityHealth, 1.0);
  // overallHeat sits at the neutral midpoint blend, and is a finite 0..1 number
  assert.ok(snap.overallHeat >= 0 && snap.overallHeat <= 1);
});

test("overallHeat: follows the spec's exact weight vector", () => {
  const ind = { ...neutralIndicators(), topSignals: [] };
  ind.launchHeat = 1; ind.volumeSpike = 0; ind.smartMoneyFlow = 0; ind.socialMomentum = 0; ind.liquidityHealth = 0;
  // 1*0.25 + 0*0.30 + 0*0.25 + 0*0.15 + 0*0.05 = 0.25
  assert.ok(Math.abs(overallHeatOf(ind) - 0.25) < 1e-9);
  ind.launchHeat = 0; ind.volumeSpike = 1;
  assert.ok(Math.abs(overallHeatOf(ind) - 0.30) < 1e-9);
});

test("meme regime: RUG_RISK fires exactly on the spec thresholds", () => {
  const base = neutralIndicators();
  base.holderConcentration = 0.2; base.liquidityHealth = 1;

  const hot = { ...base, launchHeat: 1, volumeSpike: 1, smartMoneyFlow: 1, socialMomentum: 1 };
  // heat = 0.25+0.30+0.25+0.15+0.05 = 1.0 > 0.75 ⇒ PUMP
  assert.equal(memeRegimeOf(hot, env()), "PUMP");

  const whale = { ...base, holderConcentration: 0.46 };
  assert.equal(memeRegimeOf(whale, env()), "RUG_RISK");

  const thin = { ...base, liquidityHealth: 0.29 };
  assert.equal(memeRegimeOf(thin, env()), "RUG_RISK");

  // thresholds are tunable via env without a code change; with the override the whale case falls
  // back to the raw heat (0.525 = neutral midpoint blend) ⇒ NEUTRAL
  assert.equal(memeRegimeOf(whale, env({ MEME_RUG_CONCENTRATION: "0.5" })), "NEUTRAL");
});

test("detectors: volume spike normalises 1x→0 and saturates by ~6x the hourly pace", () => {
  const calm: MemeObservation = { token: "t", chain: "solana", volume1hUsd: 60_000, volume5mUsd: 5_000 };
  const spicy: MemeObservation = { token: "t", chain: "solana", volume1hUsd: 60_000, volume5mUsd: 35_000 };
  assert.equal(detectVolumeSpikes([calm]), 0);                       // exactly in line with the hour
  assert.ok(detectVolumeSpikes([spicy]) > 0.5);                      // ~5.8× the pro-rata pace
});

test("detectors: launch heat needs BOTH fresh pools and real seed money", () => {
  const now = Date.now();
  const spam: MemeObservation[] = Array.from({ length: 10 }, () => ({
    token: "t", chain: "solana", poolCreatedAtMs: now - 60_000, initialLiquidityUsd: 100, // dust seeds
  }));
  assert.ok(detectNewPools(spam, 15 * 60_000) < 0.6);                // breadth yes, depth no

  const serious: MemeObservation[] = spam.map((o) => ({ ...o, initialLiquidityUsd: 80_000 }));
  assert.equal(detectNewPools(serious, 15 * 60_000), 1);             // both limbs saturate
});

test("detectors: rug features pull liquidity health down", () => {
  const healthy: MemeObservation = { token: "t", chain: "solana", liquidityLockedFrac: 1, top10HolderShare: 0.1, initialLiquidityUsd: 500_000 };
  assert.equal(detectRugFeatures([healthy]), 1);

  const rug: MemeObservation = { token: "t", chain: "solana", liquidityLockedFrac: 0.2, top10HolderShare: 0.7, initialLiquidityUsd: 2_000 };
  assert.ok(detectRugFeatures([rug]) <= 0.25);
});

test("detectors: risk discount keeps a rug-shaped token off the top of the board", () => {
  const hotRug: MemeObservation = {
    token: "RugTokenRugToken", chain: "solana",
    volume1hUsd: 120_000, volume5mUsd: 120_000,   // 12× spike
    liquidityLockedFrac: 0.1, top10HolderShare: 0.8, initialLiquidityUsd: 3_000,
  };
  const signals = scoreSignals([hotRug]);
  // either filtered out entirely or scored well below anything tradeable
  if (signals.length > 0) assert.ok(signals[0].score < 0.2);
});
