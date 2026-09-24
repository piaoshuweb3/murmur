// socialStimulus.test.ts — the AGE FEEDBACK BUS is provably BOUNDED and DETERMINISTIC:
//   1. Golden/dark ages map onto the four visitor channels (food+light / dark+threat), scaled by civ.
//   2. Each of the five ShockKinds overlays its mandated signature; mandated channels outrank the base
//      when the 2-slot bus is full (a BOOM in a dark age is food+dark; a PLAGERA in a golden age is
//      threat+food).
//   3. civLevel null falls back to the era-name keyword proxy (HIGH/LOW tables), else neutral silence.
//   4. cap is a hard invariant on EVERY path (base, shock, regime trim, rounding) and every intensity
//      sits on the coarse 0.05 grid (keeps the mandated 0.25/0.15 exact, kills float tails).
//   5. The quiet middle age with no shock emits the EMPTY array — 本 tick 无文明刺激.
//   6. Pure: same input twice → deep-equal AND byte-identical JSON; mutating the returned list cannot
//      poison the next call. No clock, no RNG, no I/O anywhere.
//
// These tests do NOT reach into population / economy / D1 / chronicler — the bus is decoupled via the
// EraSignal shape (ShockKind is a type-only import in the implementation), so it is audited in isolation.

import test from "node:test";
import assert from "node:assert/strict";

import { eraStimuli, AGE_SOURCE, type EraSignal, type FeltChannel, type FeltStimulus } from "./socialStimulus.js";

/** A calm baseline: a neutral middle age (civilization 50) with no shock, CALM weather. */
function sig(over: Partial<EraSignal> = {}): EraSignal {
  return { era: 3, eraName: "the Drift", eraShock: null, civLevel: 50, regime: "CALM", ...over };
}

const CAP = 0.3;

/** On the 0.05 grid? (tolerance swallows the multiplication's own last-ulp noise) */
function onGrid(v: number): boolean {
  return Math.abs(v * 20 - Math.round(v * 20)) < 1e-9;
}

function feltOf(arr: FeltStimulus[]): Map<string, number> {
  return new Map(arr.map((s) => [s.type, s.intensity]));
}

const ALL_CHANNELS: FeltChannel[] = ["food", "threat", "light", "dark"];

// ------------------------------------------------------------------------------------------------------------
// 1. 黄金 / 黑暗时代映射
// ------------------------------------------------------------------------------------------------------------

test("golden age flows food + light, scaled by civilization, stamped from 'age'", () => {
  assert.deepEqual(eraStimuli(sig({ civLevel: 80 })), [
    { type: "food", intensity: 0.25, from: "age" },
    { type: "light", intensity: 0.15, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 70 })), [
    { type: "food", intensity: 0.2, from: "age" },
    { type: "light", intensity: 0.1, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 100 })), [
    { type: "food", intensity: 0.3, from: "age" },
    { type: "light", intensity: 0.2, from: "age" },
  ]);
  assert.ok(eraStimuli(sig({ civLevel: 80 })).every((s) => s.from === AGE_SOURCE));
});

test("dark age flows dark + threat, scaled by civilization", () => {
  assert.deepEqual(eraStimuli(sig({ civLevel: 20 })), [
    { type: "dark", intensity: 0.25, from: "age" },
    { type: "threat", intensity: 0.1, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 0 })), [
    { type: "dark", intensity: 0.3, from: "age" },
    { type: "threat", intensity: 0.1, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 30 })), [
    { type: "dark", intensity: 0.2, from: "age" },
    { type: "threat", intensity: 0.1, from: "age" },
  ]);
});

test("the quiet middle age stays silent (平稳时代空输出: 31..69 ⇒ no civilization stimulus)", () => {
  for (const civ of [31, 50, 69]) {
    assert.deepEqual(eraStimuli(sig({ civLevel: civ })), [], `civ=${civ}`);
  }
});

// ------------------------------------------------------------------------------------------------------------
// 2. 五种 ShockKind 各自叠加
// ------------------------------------------------------------------------------------------------------------

test("FAMINE zeroes food and pushes threat to the cap", () => {
  // golden base: the drought zeroes the food, but the era's light still glows beneath the threat
  assert.deepEqual(eraStimuli(sig({ civLevel: 80, eraShock: "FAMINE" })), [
    { type: "threat", intensity: 0.3, from: "age" },
    { type: "light", intensity: 0.15, from: "age" },
  ]);
  // dark base: threat raised to cap, the gloom stays beneath it
  assert.deepEqual(eraStimuli(sig({ civLevel: 20, eraShock: "FAMINE" })), [
    { type: "threat", intensity: 0.3, from: "age" },
    { type: "dark", intensity: 0.25, from: "age" },
  ]);
  // neutral base: the shock alone speaks
  assert.deepEqual(eraStimuli(sig({ civLevel: 50, eraShock: "FAMINE" })), [
    { type: "threat", intensity: 0.3, from: "age" },
  ]);
});

test("PLAGERA pushes threat to the cap; in a golden age it shadows (not erases) the plenty", () => {
  assert.deepEqual(eraStimuli(sig({ civLevel: 80, eraShock: "PLAGERA" })), [
    { type: "threat", intensity: 0.3, from: "age" },
    { type: "food", intensity: 0.25, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 20, eraShock: "PLAGERA" })), [
    { type: "threat", intensity: 0.3, from: "age" },
    { type: "dark", intensity: 0.25, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 50, eraShock: "PLAGERA" })), [
    { type: "threat", intensity: 0.3, from: "age" },
  ]);
});

test("BOOM feeds at the cap; in a dark age it breaks through as food + dark", () => {
  assert.deepEqual(eraStimuli(sig({ civLevel: 80, eraShock: "BOOM" })), [
    { type: "food", intensity: 0.3, from: "age" },
    { type: "light", intensity: 0.15, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 20, eraShock: "BOOM" })), [
    { type: "food", intensity: 0.3, from: "age" },
    { type: "dark", intensity: 0.25, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 50, eraShock: "BOOM" })), [
    { type: "food", intensity: 0.3, from: "age" },
  ]);
});

test("GREAT_HUDDLE mandates exactly food 0.25 + light 0.15, whatever the base", () => {
  const huddle = [
    { type: "food", intensity: 0.25, from: "age" },
    { type: "light", intensity: 0.15, from: "age" },
  ];
  assert.deepEqual(eraStimuli(sig({ civLevel: 80, eraShock: "GREAT_HUDDLE" })), huddle);
  assert.deepEqual(eraStimuli(sig({ civLevel: 20, eraShock: "GREAT_HUDDLE" })), huddle);
  assert.deepEqual(eraStimuli(sig({ civLevel: 50, eraShock: "GREAT_HUDDLE" })), huddle);
});

test("DYNASTIC lifts light to 0.2; the golden base keeps its food, the dark keeps its gloom", () => {
  assert.deepEqual(eraStimuli(sig({ civLevel: 80, eraShock: "DYNASTIC" })), [
    { type: "food", intensity: 0.25, from: "age" },
    { type: "light", intensity: 0.2, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 20, eraShock: "DYNASTIC" })), [
    { type: "dark", intensity: 0.25, from: "age" },
    { type: "light", intensity: 0.2, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 50, eraShock: "DYNASTIC" })), [
    { type: "light", intensity: 0.2, from: "age" },
  ]);
});

test("an eraShock of null never overlays (平稳时代 runs on the base signature alone)", () => {
  assert.deepEqual(eraStimuli(sig({ civLevel: 80, eraShock: null })), [
    { type: "food", intensity: 0.25, from: "age" },
    { type: "light", intensity: 0.15, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 50, eraShock: null })), []);
});

// ------------------------------------------------------------------------------------------------------------
// 3. civLevel null → era-name keyword 回退
// ------------------------------------------------------------------------------------------------------------

test("civLevel null falls back to the era-name keyword proxy (HIGH words)", () => {
  const golden = [
    { type: "food", intensity: 0.25, from: "age" },
    { type: "light", intensity: 0.15, from: "age" },
  ];
  assert.deepEqual(eraStimuli(sig({ civLevel: null, eraName: "the Gilding" })), golden);
  assert.deepEqual(eraStimuli(sig({ civLevel: null, eraName: "the Surge" })), golden);
  assert.deepEqual(eraStimuli(sig({ civLevel: null, eraName: "THE GILDING" })), golden); // case-insensitive
  assert.deepEqual(eraStimuli(sig({ civLevel: null, eraName: "a Golden Age of Plenty" })), golden);
});

test("civLevel null falls back to the era-name keyword proxy (LOW words)", () => {
  const dark = [
    { type: "dark", intensity: 0.25, from: "age" },
    { type: "threat", intensity: 0.1, from: "age" },
  ];
  assert.deepEqual(eraStimuli(sig({ civLevel: null, eraName: "the Famine" })), dark);
  assert.deepEqual(eraStimuli(sig({ civLevel: null, eraName: "the Rot" })), dark);
  assert.deepEqual(eraStimuli(sig({ civLevel: null, eraName: "the Deep Winter" })), dark);
  assert.deepEqual(eraStimuli(sig({ civLevel: null, eraName: "the Long Frost" })), dark);
  assert.deepEqual(eraStimuli(sig({ civLevel: null, eraName: "Frostline" })), dark);
});

test("civLevel null with an unmatched era name stays neutral ⇒ silence", () => {
  for (const name of ["the Drift", "the Quiet Middle", "the Awakening", "the Yoke of Houses", ""]) {
    assert.deepEqual(eraStimuli(sig({ civLevel: null, eraName: name })), [], `name=${name}`);
  }
});

test("the keyword proxy composes with shocks: the Long Cold under GREAT_HUDDLE still huddles", () => {
  assert.deepEqual(eraStimuli(sig({ civLevel: null, eraName: "the Long Cold", eraShock: "GREAT_HUDDLE" })), [
    { type: "food", intensity: 0.25, from: "age" },
    { type: "light", intensity: 0.15, from: "age" },
  ]);
});

// ------------------------------------------------------------------------------------------------------------
// 4. regime 轻调制 (±0.05, never creates a channel, never breaches cap)
// ------------------------------------------------------------------------------------------------------------

test("HOT weather nudges an already-flowing food by +0.05, capped at the cap", () => {
  assert.deepEqual(eraStimuli(sig({ civLevel: 70, regime: "HOT" })), [
    { type: "food", intensity: 0.25, from: "age" },
    { type: "light", intensity: 0.1, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 100, regime: "HOT" })), [
    { type: "food", intensity: 0.3, from: "age" }, // 0.35 clamped back to 0.3 — 总量不破 cap
    { type: "light", intensity: 0.2, from: "age" },
  ]);
});

test("COLD weather nudges an already-falling dark by +0.05, capped at the cap", () => {
  assert.deepEqual(eraStimuli(sig({ civLevel: 20, regime: "COLD" })), [
    { type: "dark", intensity: 0.3, from: "age" },
    { type: "threat", intensity: 0.1, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 0, regime: "COLD" })), [
    { type: "dark", intensity: 0.3, from: "age" }, // 0.35 clamped back to 0.3
    { type: "threat", intensity: 0.1, from: "age" },
  ]);
});

test("regime trim never creates a channel and only honours the chronicler's exact tokens", () => {
  // no dark in a golden age for COLD to deepen; no food in a dark age for HOT to sweeten
  assert.deepEqual(eraStimuli(sig({ civLevel: 70, regime: "COLD" })), [
    { type: "food", intensity: 0.2, from: "age" },
    { type: "light", intensity: 0.1, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 20, regime: "HOT" })), [
    { type: "dark", intensity: 0.25, from: "age" },
    { type: "threat", intensity: 0.1, from: "age" },
  ]);
  // FAMINE deleted food — the weather cannot resurrect it; the golden light stays as it is
  assert.deepEqual(eraStimuli(sig({ civLevel: 80, eraShock: "FAMINE", regime: "HOT" })), [
    { type: "threat", intensity: 0.3, from: "age" },
    { type: "light", intensity: 0.15, from: "age" },
  ]);
  // lowercase / unknown regime ⇒ calm, no trim
  assert.deepEqual(eraStimuli(sig({ civLevel: 70, regime: "hot" })), [
    { type: "food", intensity: 0.2, from: "age" },
    { type: "light", intensity: 0.1, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 70, regime: "MILD" })), [
    { type: "food", intensity: 0.2, from: "age" },
    { type: "light", intensity: 0.1, from: "age" },
  ]);
});

// ------------------------------------------------------------------------------------------------------------
// 5. cap 封顶 + 0.05 网格量化
// ------------------------------------------------------------------------------------------------------------

test("a tighter cap clamps every path, including the shock mandates", () => {
  assert.deepEqual(eraStimuli(sig({ civLevel: 100 }), 0.2), [
    { type: "food", intensity: 0.2, from: "age" },
    { type: "light", intensity: 0.2, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 50, eraShock: "GREAT_HUDDLE" }), 0.2), [
    { type: "food", intensity: 0.2, from: "age" },
    { type: "light", intensity: 0.15, from: "age" },
  ]);
  assert.deepEqual(eraStimuli(sig({ civLevel: 80, eraShock: "FAMINE" }), 0.2), [
    { type: "threat", intensity: 0.2, from: "age" },
    { type: "light", intensity: 0.15, from: "age" },
  ]);
});

test("cap is sanitized: NaN / negative fail closed to silence, huge caps clamp to the 0..1 domain", () => {
  assert.deepEqual(eraStimuli(sig({ civLevel: 80, eraShock: "FAMINE" }), Number.NaN), []);
  assert.deepEqual(eraStimuli(sig({ civLevel: 80, eraShock: "FAMINE" }), -1), []);
  assert.deepEqual(eraStimuli(sig({ civLevel: 80, eraShock: "FAMINE" }), 0), []);
  assert.deepEqual(eraStimuli(sig({ civLevel: 50, eraShock: "BOOM" }), 5), [
    { type: "food", intensity: 1, from: "age" },
  ]);
});

test("every intensity lands on the coarse 0.05 grid (computed tails snap; 0.25/0.15 stay exact)", () => {
  // civ 73 ⇒ raw food ≈ 0.21000000000000002, light ≈ 0.11000000000000001 — snapped, not leaked
  assert.deepEqual(eraStimuli(sig({ civLevel: 73 })), [
    { type: "food", intensity: 0.2, from: "age" },
    { type: "light", intensity: 0.1, from: "age" },
  ]);
  // civ 78 ⇒ raw food ≈ 0.22666… — snaps to 0.25
  assert.deepEqual(eraStimuli(sig({ civLevel: 78 })), [
    { type: "food", intensity: 0.25, from: "age" },
    { type: "light", intensity: 0.15, from: "age" },
  ]);
  // full sweep of the golden band shades
  assert.deepEqual(feltOf(eraStimuli(sig({ civLevel: 95 }))), new Map([["food", 0.3], ["light", 0.2]]));
});

// ------------------------------------------------------------------------------------------------------------
// 6. 纯度: 确定性 + 逐字节一致 + 输出有界
// ------------------------------------------------------------------------------------------------------------

test("determinism: same input twice → deep-equal AND byte-identical JSON", () => {
  const inputs = [
    sig({ civLevel: 80, eraShock: "PLAGERA" }),
    sig({ civLevel: 20, eraShock: "BOOM", regime: "COLD" }),
    sig({ civLevel: null, eraName: "the Deep Winter", eraShock: "DYNASTIC", regime: "HOT" }),
    sig({ civLevel: 73, regime: "COLD" }),
  ];
  for (const s of inputs) {
    const a = eraStimuli(s);
    const b = eraStimuli(s);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  }
});

test("purity: mutating a returned list cannot poison the next call (no shared state)", () => {
  const first = eraStimuli(sig({ civLevel: 80, eraShock: "PLAGERA" }));
  first[0].intensity = 0.99;
  first.pop();
  const second = eraStimuli(sig({ civLevel: 80, eraShock: "PLAGERA" }));
  assert.deepEqual(second, [
    { type: "threat", intensity: 0.3, from: "age" },
    { type: "food", intensity: 0.25, from: "age" },
  ]);
});

test("bounded output sweep: 0..2 entries, cap never breached, grid held, strongest first, 'age' only", () => {
  const shocks = [null, "FAMINE", "PLAGERA", "BOOM", "GREAT_HUDDLE", "DYNASTIC"] as const;
  const regimes = ["HOT", "CALM", "COLD"];
  for (let civ = 0; civ <= 100; civ += 1) {
    for (const shock of shocks) {
      for (const regime of regimes) {
        const out = eraStimuli(sig({ civLevel: civ, eraShock: shock, regime }));
        const where = `civ=${civ} shock=${shock} regime=${regime}`;
        assert.ok(out.length <= 2, `${where}: ${out.length} entries > 2`);
        if (shock !== null) assert.ok(out.length >= 1, `${where}: a shock era must be felt`);
        for (const s of out) {
          assert.ok(s.intensity > 0, `${where}: zero-intensity entry leaked`);
          assert.ok(s.intensity <= CAP + 1e-9, `${where}: ${s.intensity} breaches cap`);
          assert.ok(onGrid(s.intensity), `${where}: ${s.intensity} off the 0.05 grid`);
          assert.equal(s.from, "age", `${where}: provenance stamp`);
          assert.ok(ALL_CHANNELS.includes(s.type), `${where}: unknown channel ${s.type}`);
        }
        for (let i = 1; i < out.length; i += 1) {
          assert.ok(out[i - 1].intensity >= out[i].intensity, `${where}: not strongest-first`);
        }
      }
    }
  }
});

test("the bus never invents a fifth channel (复用四通道红线)", () => {
  const seen = new Set<string>();
  for (let civ = 0; civ <= 100; civ += 7) {
    for (const shock of [null, "FAMINE", "PLAGERA", "BOOM", "GREAT_HUDDLE", "DYNASTIC"] as const) {
      for (const s of eraStimuli(sig({ civLevel: civ, eraShock: shock }))) seen.add(s.type);
    }
  }
  assert.deepEqual([...seen].sort(), ["dark", "food", "light", "threat"]);
});
