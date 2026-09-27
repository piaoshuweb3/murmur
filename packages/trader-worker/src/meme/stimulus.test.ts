// Wave-3 tests — B5: the meme regime EDGE stimulus (meme/stimulus.ts). Pure-table tests over the
// one function the cron's Step 1b calls after the temperature fusion. The contracts enforced here:
//   · the FIRST observation is not an edge (a fresh deploy must not shout at the swarm);
//   · equal states are not an edge (persistent states re-inject NOTHING — the level already
//     flows through the temperature fusion);
//   · every real crossing maps onto the EXISTING four visitor channels with the programmatic
//     feeling-leg cap discipline (never above COIN_STIMULUS_CAP = 0.35; a settle is quieter);
//   · the `from` provenance tag names the crossing, so the audit feed can tell a meme flash
//     crash from any other threat.

import test from "node:test";
import assert from "node:assert/strict";

import { memeRegimeStimulus, MEME_STIMULUS_CAP, MEME_SETTLE_INTENSITY } from "./stimulus.js";
import type { MemeRegime } from "./types.js";

test("B5: the first observation is not an edge — a fresh deploy injects nothing", () => {
  assert.equal(memeRegimeStimulus(null, "PUMP"), null);
  assert.equal(memeRegimeStimulus(undefined, "DUMP"), null);
});

test("B5: equal states are not an edge — the level leg owns persistent regimes", () => {
  for (const r of ["PUMP", "DUMP", "NEUTRAL", "RUG_RISK"] as MemeRegime[]) {
    assert.equal(memeRegimeStimulus(r, r), null, `${r} → ${r} must stay silent`);
  }
});

test("B5: a dump crossing fires one THREAT at the feeling-leg cap, provenance-tagged", () => {
  const st = memeRegimeStimulus("NEUTRAL", "DUMP");
  assert.ok(st);
  assert.equal(st.type, "threat");
  assert.equal(st.intensity, MEME_STIMULUS_CAP);
  assert.equal(st.from, "meme:NEUTRAL->DUMP");
});

test("B5: a rug-risk crossing fires THREAT too — the alarm channel is the same, the tag differs", () => {
  const st = memeRegimeStimulus("PUMP", "RUG_RISK");
  assert.ok(st);
  assert.equal(st.type, "threat");
  assert.equal(st.intensity, MEME_STIMULUS_CAP);
  assert.equal(st.from, "meme:PUMP->RUG_RISK");
});

test("B5: a pump crossing fires FOOD (euphoria) at the cap", () => {
  const st = memeRegimeStimulus("DUMP", "PUMP");
  assert.ok(st);
  assert.equal(st.type, "food");
  assert.equal(st.intensity, MEME_STIMULUS_CAP);
});

test("B5: settling back to NEUTRAL is a quiet LIGHT ping, not an alarm", () => {
  const st = memeRegimeStimulus("PUMP", "NEUTRAL");
  assert.ok(st);
  assert.equal(st.type, "light");
  assert.equal(st.intensity, MEME_SETTLE_INTENSITY);
  assert.ok(st.intensity < MEME_STIMULUS_CAP, "a settle never shouts at the cap");
});

test("B5: cap discipline — every crossing stays inside the programmatic feeling-leg table", () => {
  const regimes: MemeRegime[] = ["PUMP", "DUMP", "NEUTRAL", "RUG_RISK"];
  for (const prev of regimes) {
    for (const next of regimes) {
      const st = memeRegimeStimulus(prev, next);
      if (!st) continue;
      assert.ok(st.intensity > 0 && st.intensity <= MEME_STIMULUS_CAP, `${prev}→${next} breaches the cap`);
      assert.ok(["food", "threat", "light", "dark"].includes(st.type), `${prev}→${next} left the four channels`);
    }
  }
});
