// meme/detectors.ts — pure, stateless meme-market detectors (the 二次开发 spec's detection layer).
//
// Every function here is a PURE reduce over MemeObservation lists: no I/O, no clock reads, no env —
// which makes each one trivially unit-testable and safe to run inside the cron tick. The detectors
// feed meme/indicators.ts, which turns their outputs into the channel's indicator set + top signals.
//
// Detectors (from the spec's indicator table):
//   · detectNewPools     → launchHeat          (fresh liquidity + size, 5–15 min window)
//   · detectVolumeSpikes → volumeSpike         (1m/5m volume vs the 1h EWMA baseline)
//   · detectRugFeatures  → liquidityHealth     (locked-liquidity quality, holder concentration)
//   · scoreSignals       → topSignals          (composite, risk-discounted attractiveness)

import type { MemeObservation, MemeSignal } from "./types.js";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Launch heat: how aggressively new pools are being deployed and seeded right now.
 * Combines the COUNT of pools younger than the window (breadth) with their median initial
 * liquidity (serious-ness, filters the zero-liquidity spam farms). Both limbs saturate: 8+ fresh
 * pools or a $64k median seed each pin the limb at 1.
 */
export function detectNewPools(observations: MemeObservation[], windowMs: number): number {
  const now = Date.now();
  const fresh = observations.filter(
    (o) => o.poolCreatedAtMs != null && now - o.poolCreatedAtMs <= windowMs,
  );
  if (fresh.length === 0) return 0;
  const breadth = clamp01(fresh.length / 8);
  const seeds = fresh
    .map((o) => o.initialLiquidityUsd ?? 0)
    .sort((a, b) => a - b);
  const medianSeed = seeds[Math.floor(seeds.length / 2)] ?? 0;
  const depth = clamp01(medianSeed / 64_000);
  return clamp01(0.5 * breadth + 0.5 * depth);
}

/**
 * Volume spike: current short-window volume vs the 1h EWMA baseline, normalised to 0..1.
 * The 5m window is the headline (fast enough to catch a pump, long enough to survive one dust
 * trade); a 6× multiple against its pro-rata share of the hourly baseline saturates the detector.
 */
export function detectVolumeSpikes(observations: MemeObservation[]): number {
  let best = 0;
  for (const o of observations) {
    const v1h = o.volume1hUsd ?? 0;
    if (v1h <= 1) continue;                       // no baseline → no claim (avoids divide-by-dust)
    const baseline5m = v1h * (5 / 60);
    const v5m = o.volume5mUsd ?? 0;
    const mult = v5m / baseline5m;                 // 1 = exactly in line with the hourly pace
    best = Math.max(best, mult);
  }
  // 1× → 0 (calm), 6× → 1 (full spike); logistic-ish shoulder via the sqrt keeps 2–3× meaningful.
  return clamp01(Math.sqrt(Math.max(0, best - 1)) / Math.sqrt(5));
}

/**
 * Rug-feature scan: liquidity-health quality across the observed set. Returns 1 (healthy) when
 * nothing suspicious is seen; each risky feature pulls the score down:
 *   · unlocked liquidity (liquidityLockedFrac < 0.8) — the owner can pull the pool at will
 *   · top-10 holder share > 0.45 — one wallet can nuke the chart
 *   · trivial liquidity (< $10k) — exit liquidity for everyone else is a rumour
 */
export function detectRugFeatures(observations: MemeObservation[]): number {
  if (observations.length === 0) return 1;         // nothing observed ≠ evidence of danger
  let worst = 1;
  for (const o of observations) {
    let health = 1;
    const locked = o.liquidityLockedFrac;
    if (locked != null) health = Math.min(health, clamp01(locked / 0.8));
    const concentration = o.top10HolderShare;
    if (concentration != null && concentration > 0.45) {
      health = Math.min(health, clamp01(1 - (concentration - 0.45) * 2));
    }
    const liq = o.initialLiquidityUsd;
    if (liq != null && liq < 10_000) {
      health = Math.min(health, clamp01(liq / 10_000));
    }
    worst = Math.min(worst, health);
  }
  return worst;
}

/** Smart-money flow: max known-wallet net inflow across the set, log-scaled ($1k → ~0.5, $32k → 1). */
export function detectSmartMoneyFlow(observations: MemeObservation[]): number {
  let bestNet = 0;
  for (const o of observations) {
    const net = o.smartMoneyNetUsd ?? 0;
    if (net > bestNet) bestNet = net;
  }
  if (bestNet <= 0) return 0;
  return clamp01(Math.log10(1 + bestNet / 1_000) / Math.log10(1 + 32));
}

/** Social momentum: max mention velocity, saturating at 50 mentions/hour. */
export function detectSocialMomentum(observations: MemeObservation[]): number {
  let best = 0;
  for (const o of observations) {
    const m = o.socialMentionsPerHour ?? 0;
    if (m > best) best = m;
  }
  return clamp01(best / 50);
}

/** Price velocity: max |1h move| across the set, saturating at ±80%. */
export function detectPriceVelocity(observations: MemeObservation[]): number {
  let best = 0;
  for (const o of observations) {
    const move = Math.abs(o.priceChangePct1h ?? 0) / 100;
    if (move > best) best = move;
  }
  return clamp01(best / 0.8);
}

/**
 * Composite, risk-discounted signal ranking. The raw attractiveness blends momentum detectors;
 * the RISK DISCOUNT then multiplies it down for unhealthy liquidity / dangerous concentration, so
 * a rug-shaped token can never top the board no matter how hot its volume looks.
 */
export function scoreSignals(observations: MemeObservation[]): MemeSignal[] {
  const scored: Array<{ o: MemeObservation; score: number; reasons: string[] }> = [];
  for (const o of observations) {
    const reasons: string[] = [];

    const spike = detectVolumeSpikes([o]);
    if (spike > 0.3) reasons.push(`volumeSpike ${(spike * 100).toFixed(0)}%`);
    const smart = detectSmartMoneyFlow([o]);
    if (smart > 0.3) reasons.push("smartMoney inflow");
    const social = detectSocialMomentum([o]);
    if (social > 0.3) reasons.push("social momentum");
    const velocity = detectPriceVelocity([o]);
    if (velocity > 0.3) reasons.push("price velocity");

    let score = 0.35 * spike + 0.3 * smart + 0.2 * social + 0.15 * velocity;

    // Risk discount — rug features are multiplicative, not additive, so they can always win.
    const locked = o.liquidityLockedFrac;
    if (locked != null) score *= clamp01(0.4 + 0.6 * locked);
    const concentration = o.top10HolderShare;
    if (concentration != null && concentration > 0.35) {
      score *= clamp01(1 - (concentration - 0.35) * 1.5);
    }
    const liq = o.initialLiquidityUsd;
    if (liq != null && liq < 10_000) score *= clamp01(liq / 10_000);

    if (score > 0.15) scored.push({ o, score: clamp01(score), reasons });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .map(({ o, score, reasons }) => ({
      token: o.token,
      chain: o.chain,
      score,
      reasons,
      liquidityUsd: o.initialLiquidityUsd,
      holderConcentration: o.top10HolderShare,
      priceUsd: o.priceUsd, // feeds the execution layer's exit rules (P&L reference at entry)
    }));
}
