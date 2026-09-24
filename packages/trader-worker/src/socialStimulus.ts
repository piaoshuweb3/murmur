// ============================================================================================================
// socialStimulus.ts — the AGE FEEDBACK BUS (时代反馈总线 · "神经反馈"的自主实现).
//
// The chronicler READS the swarm and names the age (eraInfo()); this module closes the loop the bounded
// way: the historian's verdict flows BACK into the swarm as at most two felt stimuli per tick, so the
// flies can FEEL the era they live in — the Famine gnaws, the Gilding feeds, the Long Cold glows. An
// autonomous implementation of the feedback-bus idea (只取机制思想，映射/回退/优先级均为本仓自写设计).
//
// THE RED LINE — 绝不新增感官通道: the age speaks ONLY through the same four sensory channels the
// visitors already use (food / threat / light / dark — stimulus.ts → fly-brain StimulusEvent). No new
// stimulus kind, no genome / connectome / fingerprint touched, therefore manifestHash 不轮转 — the era
// borrows the visitors' voice instead of growing a new sense organ. Every felt stimulus is stamped
// from: "age" so the audit feed can tell the age's whisper from a visitor's poke.
//
// THE ONE IRON RULE — PURE READ-OUT, BOUNDED PUSH (时代能推动群体，永远不能驾驭它):
//   1. eraStimuli() is a PURE function: no clock, no Math.random, no I/O; same input → byte-identical
//      output, with every intensity snapped to a coarse grid so no float tail may differ across engines.
//   2. HARD CAP. Every intensity ≤ cap (default 0.3), clamped before AND after quantization — no path
//      (shock mandate, regime trim, rounding) can breach it. A quiet middle age with no shock yields the
//      EMPTY array: 空, 即"本 tick 无文明刺激" — the bus stays silent and the swarm hears nothing.
//   3. TYPE-ONLY COUPLING. ShockKind arrives via `import type` from chronicler.js — the two enum sites
//      cannot drift (compile-time guardrail), yet the compiled module holds ZERO runtime reference to
//      the chronicler: no import cycle, no lazy coupling; the bus only ever sees the caller's plain data.
//
// MAPPING (era verdict → felt stimulus; mirrored assertion-by-assertion by socialStimulus.test.ts):
//
//   BASE — the slow civilization level (civ 0..100; null ⇒ era-name keyword proxy below; out-of-range
//   clamped in; NaN/undefined ⇒ treated as null):
//     civ ≥ 70 (golden/rising)  → food 0.2..0.3 (丰饶) + light 0.1..0.2 (明亮), scaled linearly by civ
//     civ ≤ 30 (dark/declining) → dark 0.2..0.3 + threat 0.1, scaled linearly by civ
//     30 < civ < 70 (the quiet middle) → nothing — a calm age is not a stimulus
//     Keyword proxy (civLevel null only; matched against the LOWERCASED era name, HIGH table first,
//     everything unmatched ⇒ neutral 50 ⇒ silence):
//       HIGH (⇒ civ 85, on-grid) : gold, gild, ascend, bloom, surge, boom, rise, plenty, harvest, renaiss
//         — covers the chronicler's own name pool ("the Gilding", "the Surge") + the spec's gold/ascend
//       LOW  (⇒ civ 15, on-grid) : dark, declin, decay, fall, ruin, rot, famine, plague, dusk, ash, grim,
//         winter, frost, cold, huddle, still — the whole COLD name family + "the Famine"/"the Rot"
//
//   SHOCK OVERLAY — the event that FORCED this era open re-tunes the signature (eraShock null ⇒ none):
//     FAMINE       → food deleted (归零: the drought undoes whatever plenty the base had) + threat = cap
//     PLAGERA      → threat = cap
//     BOOM         → food = cap
//     GREAT_HUDDLE → food = 0.25 + light = 0.15 (the communal warmth and glow of the huddle)
//     DYNASTIC     → light = max(current, 0.2) (the houses' grip shines)
//     An unknown kind (forward-compat) is treated as calm — still pure, still bounded.
//
//   REGIME TRIM — the market's fast weather modulates by at most ±0.05 (仅轻微调制):
//     HOT  → food +0.05, only where food ALREADY flows (FAMINE's drought cannot be sweetened by weather)
//     COLD → dark +0.05, only where dark ALREADY falls
//     Only the chronicler's exact tokens "HOT"/"COLD" trim; anything else (incl. lowercase) is calm.
//
//   PRECEDENCE — more than two channels can never be emitted (输出条数 0..2). Base contributes ≤ 2 and
//   the overlay ≤ 2, so when a shock era lands on a coloured base the survivors are chosen: shock-mandated
//   channels first, then the rest by intensity, ties by fixed channel order (food, threat, light, dark).
//   Hence a BOOM in a dark age is felt as food + dark (abundance breaking through the gloom), and a
//   PLAGERA in a golden age as threat + food (the plague shadowing the plenty). The emitted order is
//   strongest-first (ties by the same fixed channel order).
//
// PRECISION — 为什么是 0.05 网格: the spec's own constants 0.25/0.15 (GREAT_HUDDLE) live on the 0.05
// grid; a strict one-decimal grid would erase them. So the quantizer snaps to 0.05 (Math.round(v*20)/20),
// which both preserves the mandated constants and kills every computed float tail (0.21000000000000002 →
// 0.2) — no engine may disagree on a felt intensity. At the margin cap wins over the grid: clamp →
// quantize → clamp again (a tight cap like 0.28 can survive the snap off-grid, but never breached).
// ============================================================================================================

import type { ShockKind } from "./chronicler.js";

/** The only four senses the age may use — exactly the visitor stimulus channels (no fifth channel, ever). */
export type FeltChannel = "food" | "threat" | "light" | "dark";

/** One felt stimulus, shaped to drop straight into fly-brain's StimulusEvent (from is always "age"). */
export interface FeltStimulus {
  type: FeltChannel;
  intensity: number;
  from: string;
}

/** The historian's era verdict, as the caller adapts it from Chronicler.eraInfo() (+ a civilization level). */
export interface EraSignal {
  era: number;
  eraName: string;
  eraShock: ShockKind | null; // the shock that forced the CURRENT era open (null = 平稳时代)
  civLevel: number | null; // 0..100 civilization read-out (null ⇒ keyword proxy on eraName)
  regime: string; // "HOT" | "CALM" | "COLD" — the market's fast weather, only a light modulation
}

/** The provenance stamp every felt stimulus carries — how the audit feed tells the age from a visitor. */
export const AGE_SOURCE = "age";

// --- the bounded dials (all on the 0.05 grid; the cap is the constitution, the rest is weather) ---------
const DEFAULT_CAP = 0.3; // 默认封顶: no single felt intensity may pass it
const MAX_CAP = 1; // felt intensity lives in the visitor stimulus domain 0..1
const GRID = 20; // quantize step = 1/20 = 0.05 (keeps 0.25/0.15 exact, kills float tails)
const GOLDEN_FROM = 70; // civ ≥ 70 feels the golden signature
const DARK_TO = 30; // civ ≤ 30 feels the dark signature
const GOLDEN_PROXY = 85; // keyword-fallback proxy level (lands on-grid inside the golden band)
const DARK_PROXY = 15; // keyword-fallback proxy level (lands on-grid inside the dark band)
const NEUTRAL_CIV = 50; // unmatched era name ⇒ the quiet middle ⇒ silence

const CHANNEL_ORDER: readonly FeltChannel[] = ["food", "threat", "light", "dark"];

const HIGH_WORDS = ["gold", "gild", "ascend", "bloom", "surge", "boom", "rise", "plenty", "harvest", "renaiss"];
const LOW_WORDS = [
  "dark", "declin", "decay", "fall", "ruin", "rot", "famine", "plague",
  "dusk", "ash", "grim", "winter", "frost", "cold", "huddle", "still",
];

/** Channels each shock MANDATES into the output — they outrank base channels when the 2-slot bus is full. */
const MANDATED: Record<ShockKind, ReadonlySet<FeltChannel>> = {
  FAMINE: new Set<FeltChannel>(["threat"]),
  PLAGERA: new Set<FeltChannel>(["threat"]),
  BOOM: new Set<FeltChannel>(["food"]),
  GREAT_HUDDLE: new Set<FeltChannel>(["food", "light"]),
  DYNASTIC: new Set<FeltChannel>(["light"]),
};
const NO_CHANNELS: ReadonlySet<FeltChannel> = new Set<FeltChannel>();

/**
 * Turn the historian's era verdict into the 0..2 felt stimuli the swarm receives this tick.
 * Pure: no clock, no RNG, no I/O — the same signal always yields a byte-identical list.
 */
export function eraStimuli(sig: EraSignal, cap?: number): FeltStimulus[] {
  const capEff = sanitizeCap(cap);
  if (!sig || typeof sig !== "object") return []; // defensive for untyped callers; still pure

  const felt = baseSignature(effectiveCivLevel(sig.civLevel, sig.eraName));
  overlayShock(felt, sig.eraShock, capEff);
  regimeTrim(felt, sig.regime);
  return emit(felt, capEff, sig.eraShock);
}

/** undefined ⇒ the contract default; NaN/±Infinity ⇒ fail closed (silence); otherwise clamp to 0..1. */
function sanitizeCap(cap: number | undefined): number {
  if (cap === undefined) return DEFAULT_CAP;
  if (!Number.isFinite(cap)) return 0;
  return Math.max(0, Math.min(MAX_CAP, cap));
}

/** The effective civilization level: clamped read-out, or the era-name keyword proxy, or neutral 50. */
function effectiveCivLevel(civLevel: number | null, eraName: string): number {
  if (typeof civLevel === "number" && Number.isFinite(civLevel)) {
    return Math.max(0, Math.min(100, civLevel));
  }
  const name = typeof eraName === "string" ? eraName.toLowerCase() : "";
  if (HIGH_WORDS.some((w) => name.includes(w))) return GOLDEN_PROXY;
  if (LOW_WORDS.some((w) => name.includes(w))) return DARK_PROXY;
  return NEUTRAL_CIV;
}

/** The slow base signature of the age, before any shock or weather. Empty map = the quiet middle. */
function baseSignature(civ: number): Map<FeltChannel, number> {
  const felt = new Map<FeltChannel, number>();
  if (civ >= GOLDEN_FROM) {
    const t = (civ - GOLDEN_FROM) / (100 - GOLDEN_FROM); // 0..1 across the golden band
    felt.set("food", 0.2 + 0.1 * t); // 丰饶 0.2..0.3
    felt.set("light", 0.1 + 0.1 * t); // 明亮 0.1..0.2
  } else if (civ <= DARK_TO) {
    const t = (DARK_TO - civ) / DARK_TO; // 0..1 across the dark band
    felt.set("dark", 0.2 + 0.1 * t); // 0.2..0.3
    felt.set("threat", 0.1);
  }
  return felt;
}

/** The shock that forced this era open re-tunes the signature (null or unknown kind ⇒ untouched). */
function overlayShock(felt: Map<FeltChannel, number>, shock: ShockKind | null, cap: number): void {
  switch (shock) {
    case "FAMINE":
      felt.delete("food"); // 归零 — the drought undoes whatever plenty the base had
      felt.set("threat", cap);
      break;
    case "PLAGERA":
      felt.set("threat", cap);
      break;
    case "BOOM":
      felt.set("food", cap);
      break;
    case "GREAT_HUDDLE":
      felt.set("food", 0.25);
      felt.set("light", 0.15);
      break;
    case "DYNASTIC":
      felt.set("light", Math.max(felt.get("light") ?? 0, 0.2));
      break;
    default:
      break; // 平稳时代 (or a forward-compat unknown kind): no overlay, still pure
  }
}

/** The market's fast weather nudges an ALREADY-flowing channel by one 0.05 step — never creates one. */
function regimeTrim(felt: Map<FeltChannel, number>, regime: string): void {
  if (regime === "HOT") {
    const food = felt.get("food");
    if (food !== undefined && food > 0) felt.set("food", food + 0.05);
  } else if (regime === "COLD") {
    const dark = felt.get("dark");
    if (dark !== undefined && dark > 0) felt.set("dark", dark + 0.05);
  }
}

/** Clamp → quantize → clamp → prune → (trim to 2, mandated first) → strongest-first. The bounded exit. */
function emit(felt: Map<FeltChannel, number>, cap: number, shock: ShockKind | null): FeltStimulus[] {
  const mandated = (shock && MANDATED[shock]) || NO_CHANNELS;
  const live: { type: FeltChannel; intensity: number; mandated: boolean }[] = [];
  for (const ch of CHANNEL_ORDER) {
    const raw = felt.get(ch);
    if (raw === undefined) continue;
    let v = raw > cap ? cap : raw; // hard cap, first pass
    v = Math.round(v * GRID) / GRID; // 0.05-grid snap — no float tail may survive
    if (v > cap) v = cap; // hard cap, second pass (the snap may round up past a tight cap)
    if (v <= 0) continue; // silence beats a zero-intensity entry
    live.push({ type: ch, intensity: v, mandated: mandated.has(ch) });
  }
  if (live.length > 2) {
    // 输出条数 0..2: shock-mandated channels hold the bus; the base's survivors rank by intensity.
    live.sort(
      (a, b) =>
        (a.mandated ? 0 : 1) - (b.mandated ? 0 : 1) ||
        b.intensity - a.intensity ||
        CHANNEL_ORDER.indexOf(a.type) - CHANNEL_ORDER.indexOf(b.type),
    );
    live.length = 2;
  }
  live.sort(
    (a, b) => b.intensity - a.intensity || CHANNEL_ORDER.indexOf(a.type) - CHANNEL_ORDER.indexOf(b.type),
  );
  return live.map((x) => ({ type: x.type, intensity: x.intensity, from: AGE_SOURCE }));
}
