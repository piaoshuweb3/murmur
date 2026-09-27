// ============================================================================
// meme/stimulus.ts — B5 (Wave-3): the meme channel's REGIME EDGE as a stimulus.
// ----------------------------------------------------------------------------
// The monitoring layer fuses meme heat into the temperature every cron (Step 1b,
// state.ts). That covers the LEVEL. This module covers the EDGE: when the meme
// regime CROSSES a band between crons (PUMP→DUMP, NEUTRAL→PUMP, …) the swarm
// gets a one-shot bounded stimulus through the four EXISTING visitor channels —
// exactly like the bourse's feeling leg (coinStimuli, bourse.ts) and the age's
// felt leg (eraStimuli, socialStimulus.ts). No new sensory channel, no fly-brain
// change: encodeStimulus() maps these straight onto the existing four.
//
// Constitution notes (why the constants look like this):
//   · intensity rides the SAME hard cap as every other programmatic feeling leg
//     (COIN_STIMULUS_CAP = 0.35) — the doc draft's 0.6 would make the meme leg
//     the loudest voice in the swarm on its very first fire; the cap table
//     (0.35 token / 0.3 era) says programmatic feelings never exceed 0.35.
//   · first observation is NOT an edge (prev == null ⇒ null): a fresh deploy
//     must not shout at the swarm just because sampling started.
//   · persistent states re-inject NOTHING — only the crossing fires. The level
//     keeps flowing through the temperature fusion; this module is edge-only.
// ============================================================================

import type { MemeRegime } from "./types.js";

/** The one shape every programmatic feeling leg emits (fly-brain StimulusEvent). */
export type MemeStimulus = {
  type: "food" | "threat" | "light" | "dark";
  intensity: number;
  from: string;
};

/** Hard cap for the meme feeling leg — same table as coinStimuli (bourse.ts). */
export const MEME_STIMULUS_CAP = 0.35;

/** A settle back to NEUTRAL is an attention ping, not an alarm — quieter, on the 0.05 grid. */
export const MEME_SETTLE_INTENSITY = 0.15;

/** True stimulus type for each meme regime, by what the regime MEANS to a fly:
 *  PUMP (euphoria) → food · DUMP (panic) → threat · RUG_RISK (danger) → threat
 *  · NEUTRAL (settled) → light (a soft attention ping). */
const REGIME_CHANNEL: Record<MemeRegime, "food" | "threat" | "light"> = {
  PUMP: "food",
  DUMP: "threat",
  RUG_RISK: "threat",
  NEUTRAL: "light",
};

/**
 * The one-shot stimulus for a meme-regime CROSSING, or null when nothing fired.
 * Pure: no clock, no RNG, no I/O — the same (prev, next) pair always yields a
 * byte-identical verdict. Edge-only by construction: equal states and first
 * observations (prev == null) never fire.
 */
export function memeRegimeStimulus(prev: MemeRegime | null | undefined, next: MemeRegime): MemeStimulus | null {
  if (!prev || prev === next) return null;
  const type = REGIME_CHANNEL[next] ?? "light";
  const intensity = next === "NEUTRAL" ? MEME_SETTLE_INTENSITY : MEME_STIMULUS_CAP;
  return { type, intensity, from: `meme:${prev}->${next}` };
}
