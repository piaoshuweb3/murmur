// ============================================================================================================
// poet.ts — THE LAUREATE: the fly swarm's own poet. 自主实现，机制思想自研，与上游实现零文本/零代码共享。
//
// One poem per crowning. A "crowned fly" (the tick's laureate) is celebrated in 4-8 lowercase lines woven
// from FOUR deterministic inputs: chronicle excerpts (叙事回声), the swarm's temperament words, the market's
// temperature palette, and the name of the current era. The poem is composed by a NEURAL-STYLE LEXICAL
// COMBINATOR — a seeded xorshift picks words from self-made lexicons and fills self-made line templates.
//
//   NO LLM. NO CLOCK. NO Math.random. NO I/O. composePoem() is a PURE FUNCTION: same (input, seq, ts) in,
//   byte-identical poem out — provably re-derivable from the seed + the published rule-set, exactly like
//   the chronicler's renderTemplate proof that the words are the template's, not a model's.
//
//   manifestHash 不轮转: this module is ledger/D1-surface only — zero on-chain commitment, zero genome/
//   manifest kinds touched, so the brain manifest (and its committed hash) is byte-identical with or
//   without the Laureate. D1 persistence of poems is wired by the caller (main agent); this file only
//   generates poems and keeps the in-memory cap-50 ledger.
//
// 词表（自创词表 / ORIGINAL LEXICON）: every noun, verb, adjective, temperature word, era word and template
// below was written for THIS module (colony / neural wiring / temperature / light-and-dark imagery). No
// word list or sentence is copied from upstream murmur or anywhere else. The three regime palettes are
// mutually disjoint token sets — a COLD poem cannot contain a scorching word and vice versa (asserted in
// poet.test.ts) — so the colouring is a testable property, not a vibe.
//
// GENERATION RULES (the poet's "genome", deterministic end-to-end):
//   1. SEED. mix32(seed, seq, tick) → xorshift32 state; every word pick is one xorshift draw. No floats
//      beyond the [0,1) read-off; no hidden state; replayable from the seed alone.
//   2. PALETTE. market.regime selects the lexicon subset: HOT→灼色词 (ember/fever/brasswire…), COLD→冷色词
//      (frost/rime/glassaxon…), CALM→中性词 (murmur/lantern/filament…). market.temperature (0..1) quantizes
//      to a band 0..2 that shifts template + temperature-word picks, so the number is felt in the verse.
//   3. ERA COLOURING. The eraName is softened and woven into line 1; its char-sum biases the era-word pick
//      (age/season/epoch/watch…) so each era has its own vocabulary tilt.
//   4. CHRONICLE ECHOES. 1-2 lines echo recent chronicle excerpts (count = min(2, samples, lines-3)): the
//      excerpt's kind maps to a spoken phrase ("a birth", "an elegy", …) and its key noun (longest
//      non-stopword token, never a word from a FOREIGN palette) is embedded — the chronicle literally
//      keeps speaking inside the poem.
//   5. CORONATION. The LAST line is always the crown line: it names fly {id}, folds the fly's temperament
//      into the verse, and (when supplied) remembers its recent behaviors.
//   6. DISCIPLINE. Every line is lowercased and stripped to [a-z 0-9 comma hyphen] — no periods, no
//      capitals, restrained murmur aesthetics throughout.
//
// HASH CONVENTION (mirrors netReceiptHash/entryHash in provenance.ts): poem.hash = sha256(canonical(poem
// minus the hash field itself)) — the field cannot contain its own digest, so it is excluded from the
// hashed core and filled in asynchronously by the caller: `poem.hash = await poemHash(poem)`.
// canonicalPoemJson() is the sorted-key stable serialization (the exact bytes whose sha256 is the hash core).
// ============================================================================================================

import { canonical, sha256Hex } from "./provenance.js";

/** Bump when the poem schema or generation rule-set changes (invalidates comparability of old hashes). */
export const POET_VERSION = 1;
/** The ledger is capped: beyond 50 poems the oldest is dropped (D1 keeps the full history, this is hot state). */
export const POET_LEDGER_CAP = 50;

// ------------------------------------------------------------------------------------------------------------
// CONTRACT TYPES — the exact shapes the main agent integrates against. Do not widen casually.
// ------------------------------------------------------------------------------------------------------------

export interface PoemInput {
  tick: number;
  era: number;
  eraName: string;
  /** The crowned fly: id / temperament label / recent behavior strings (verbatim, sanitized into the verse). */
  crownFly: { id: number; temperament: string; behaviors: string[] };
  /** 3-8 recent chronicle excerpts; each kind may become 1-2 "echo lines" in the poem. */
  chronicleSamples: Array<{ kind: string; text: string }>;
  /** Market read-out: 0..1 temperature + HOT/CALM/COLD regime (palette selector). */
  market: { temperature: number; regime: string };
  seed: number;
}

export interface Poem {
  /** Monotonic ordinal within the ledger (caller assigns; D1 primary key). */
  seq: number;
  /** Unix ms, supplied by the caller — this module never reads a clock. */
  ts: number;
  tick: number;
  era: number;
  eraName: string;
  crownFlyId: number;
  /** 4-8 lines, all lowercase, punctuation limited to comma + hyphen. */
  lines: string[];
  seed: number;
  /** sha256(canonical(poem minus hash)) — "" until the caller fills it via poemHash(). */
  hash: string;
}

// ------------------------------------------------------------------------------------------------------------
// 自创词表 / ORIGINAL LEXICON — five word classes, three mutually disjoint regime palettes + era words.
// Imagery domains: colony (hive/comb/brood), neural wiring (axon/wire/filament/spark), temperature
// (ember/frost/haze), light-and-dark (lantern/dusk/glow/icelight). All invented for this module.
// ------------------------------------------------------------------------------------------------------------

export interface PoetPalette {
  /** concrete images the lines are built around */
  readonly nouns: readonly string[];
  /** colouring adjectives, regime-tinted */
  readonly adjectives: readonly string[];
  /** 3rd-person singular verbs (they follow "the colony/the {noun}") */
  readonly verbs: readonly string[];
  /** temperature words (the market's warmth made noun) */
  readonly temp: readonly string[];
}

export const POET_LEXICON: {
  hot: PoetPalette;
  cold: PoetPalette;
  calm: PoetPalette;
  /** regime-neutral words for time/age (the "era words" class) */
  eraWords: readonly string[];
} = {
  hot: {
    nouns: ["ember", "fever", "cinder", "kiln", "flare", "glare", "brasswire", "smelter", "honeycomb", "sparkfield", "sunspore", "waxseal"],
    adjectives: ["molten", "scorching", "feverish", "blazing", "sunstruck", "brassy", "restless", "electric", "incandescent", "parched"],
    verbs: ["kindles", "burns", "swelters", "flickers", "simmers", "seethes", "crackles", "shimmers", "smolders", "sparks"],
    temp: ["heat", "glow", "warmth", "shimmer", "haze", "blaze", "sunfire", "afterglow"],
  },
  cold: {
    nouns: ["frost", "rime", "hush", "icelight", "glassaxon", "stillness", "winterwire", "snowfall", "chillcomb", "bluehour", "frostweb", "stillair"],
    adjectives: ["pale", "hoary", "glacial", "frozen", "brittle", "faint", "blue", "wintered", "numb", "sluggish", "translucent", "hushed"],
    verbs: ["freezes", "stills", "slows", "congeals", "dims", "numbs", "whitens", "hushes", "shivers", "sinks"],
    temp: ["chill", "frost", "cold", "damp", "freeze", "shiver", "whiteout", "icewater"],
  },
  calm: {
    nouns: ["murmur", "drone", "hive", "corridor", "antenna", "tremor", "grain", "veil", "lantern", "dusk", "pollen", "filament"],
    adjectives: ["quiet", "soft", "steady", "drowsy", "muted", "even", "gray", "slow", "gentle", "plain", "level", "half-lit"],
    verbs: ["hums", "murmurs", "lingers", "tilts", "unspools", "breathes", "waits", "turns", "sways", "floats"],
    temp: ["temper", "mildness", "ease", "balance", "evenness", "neutrality", "calm", "half-light"],
  },
  eraWords: ["age", "season", "epoch", "watch", "cycle", "chapter", "reign", "turning", "interval", "passage"],
};

type RegimeKey = "hot" | "cold" | "calm";

/** Normalize any caller regime string onto a palette key; unknown regimes read as CALM (neutral default). */
function normalizeRegime(regime: string | undefined): RegimeKey {
  const r = String(regime ?? "").trim().toUpperCase();
  return r === "HOT" ? "hot" : r === "COLD" ? "cold" : "calm";
}

/** Every token used by palettes OTHER than `current` — echo nouns may never smuggle a foreign colour in. */
function otherPaletteTokens(current: RegimeKey): Set<string> {
  const out = new Set<string>();
  for (const key of ["hot", "cold", "calm"] as const) {
    if (key === current) continue;
    const p = POET_LEXICON[key];
    for (const w of [...p.nouns, ...p.adjectives, ...p.verbs, ...p.temp]) out.add(w);
  }
  return out;
}

/** Chronicle kind → the phrase the poem speaks for it (self-written; unknown kinds degrade gracefully). */
const KIND_ECHO: Record<string, string> = {
  ERA_OPEN: "an era opening", ERA_SHIFT: "an era turning", ERA_PASSAGE: "a passage of eras",
  EPOCH_OPEN: "an epoch opening", EPOCH_CLOSE: "an epoch closing",
  FIRST_TRADE: "the first trade", MILESTONE: "a milestone", BIRTH: "a birth",
  PANIC: "a panic", STORM: "a storm", HUDDLE: "a huddle", FEAST: "a feast", RECORD_CONC: "a record",
  LEAD_CHANGE: "a change of lead", FEUD: "a feud", ALLIANCE: "an alliance", BETRAYAL: "a betrayal",
  REPUTATION: "a reputation", HOUSE_FOUNDED: "a house founded", DYNASTY: "a dynasty", ELEGY: "an elegy",
  TREND: "a trend", TRADITION: "a tradition", MARKET_SHIFT: "a shift in the market wind",
  CREDIT: "a credit", RUN: "a run", CLASS: "a sorting", ASSEMBLY: "an assembly", DECREE: "a decree",
  WAR_DECLARED: "a war declared", WAR_RESOLVED: "a war laid down", TAX_LEVIED: "a levy",
  TERRITORY_SEIZED: "a seizure of ground",
};

/** Glue words never chosen as a chronicle's "key noun" (function words only — domain words stay eligible). */
const ECHO_STOP = new Set([
  "the", "and", "for", "with", "from", "into", "over", "under", "after", "before", "between", "through",
  "without", "within", "upon", "about", "above", "below", "beyond", "across", "along", "amid", "among",
  "been", "being", "were", "have", "has", "had", "does", "did", "will", "would", "could", "should",
  "their", "there", "these", "those", "this", "that", "then", "than", "them", "they", "when", "while",
  "which", "where", "what", "whose", "again", "once", "also", "just", "only", "very", "such", "same",
  "some", "most", "more", "less", "least", "each", "every", "both", "either", "neither", "because",
  "it's", "its", "his", "her", "hers", "our", "ours", "your", "yours", "their", "theirs",
]);

// ------------------------------------------------------------------------------------------------------------
// DETERMINISTIC RNG — xorshift32 keyed by (seed, seq, tick). No Math.random anywhere in this module.
// ------------------------------------------------------------------------------------------------------------

/** 32-bit avalanche mix (murmur-flavoured finalizer arithmetic, written from scratch for this module). */
function mix32(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0xc2b2ae35, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Seed the xorshift32 stream; returns a draw function over [0,1). Pure integer state, replayable. */
function makeRng(seed: number, seq: number, tick: number): () => number {
  let s = mix32(seed | 0, (Math.imul(seq | 0, 0x9e3779b1) ^ Math.imul(tick | 0, 0x85ebca6b)) | 0);
  if (s === 0) s = 0x9e3779b9; // xorshift never escapes the zero state — nudge it once
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function rngInt(next: () => number, n: number): number {
  return n <= 1 ? 0 : Math.floor(next() * n) % n; // %n guards float edge at 1.0-ε
}

function pick<T>(arr: readonly T[], next: () => number): T {
  return arr[rngInt(next, arr.length)];
}

/** Pick an element distinct from `avoid` (deterministic escape hatch when the draw keeps colliding). */
function pickOther(arr: readonly string[], avoid: string, next: () => number): string {
  if (arr.length < 2) return pick(arr, next);
  let w = pick(arr, next);
  for (let i = 0; w === avoid && i < 6; i++) w = pick(arr, next);
  if (w === avoid) return arr[(arr.indexOf(avoid) + 1) % arr.length];
  return w;
}

// ------------------------------------------------------------------------------------------------------------
// SANITIZERS — the verse discipline: lowercase, [a-z 0-9 , -] only, collapsed whitespace.
// ------------------------------------------------------------------------------------------------------------

/** Soften free caller text (eraName / temperament / behaviors) into safe verse material. */
function soften(s: string | undefined, fallback: string): string {
  const out = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > 0 ? out : fallback;
}

/** Final line discipline — the last gate before a line enters the poem. */
function finishLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^a-z0-9,\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** a/an agreement for template glue (deterministic, purely orthographic). */
function art(word: string): string {
  return /^[aeiou]/.test(word) ? "an" : "a";
}

/** The excerpt's key noun: a real word from its text, never a stopword, never a foreign-palette colour.
 *  Verb-ish endings (ed/ing/ly) are demoted so the echo speaks of THINGS, not actions. */
function keyNoun(text: string, palette: PoetPalette, forbidden: ReadonlySet<string>, next: () => number): string {
  const toks = String(text ?? "").toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const cands = toks.filter((t) => !ECHO_STOP.has(t) && !forbidden.has(t));
  if (cands.length > 0) {
    const score = (t: string) => t.length - (/(?:ed|ing|ly)$/.test(t) ? 100 : 0);
    // top-3 by score (alphabetical tiebreak → deterministic), one drawn by the xorshift
    const top = cands.sort((a, b) => score(b) - score(a) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, Math.min(3, cands.length));
    return top[rngInt(next, top.length)];
  }
  return pick(palette.nouns, next); // excerpt had no usable word — fall back to the palette's imagery
}

/** kind → spoken phrase; unknown kinds are spoken as plain words ("SOME_KIND" → "some kind"). */
function kindPhrase(kind: string | undefined): string {
  const mapped = KIND_ECHO[String(kind ?? "").trim().toUpperCase()];
  if (mapped) return mapped;
  const words = String(kind ?? "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  return words.length > 0 ? words : "a marked day";
}

// ------------------------------------------------------------------------------------------------------------
// LINE TEMPLATES — 10 generic + 3 era + 2 echo + 3 crown. Fixed "glue" words are palette-neutral on purpose
// (verified by the cross-palette tests): only the {slots} ever carry regime colour.
// ------------------------------------------------------------------------------------------------------------

type Ctx = { palette: PoetPalette; next: () => number };

/** The 10 generic line templates (the "the colony {verb} in {adj} {noun}" family). */
const GENERIC_TEMPLATES: Array<(c: Ctx) => string> = [
  (c) => `the colony ${pick(c.palette.verbs, c.next)} in ${pick(c.palette.adjectives, c.next)} ${pick(c.palette.nouns, c.next)}`,
  (c) => {
    const t1 = pick(c.palette.temp, c.next);
    return `${t1} in the wiring, ${pickOther(c.palette.temp, t1, c.next)} on the ${pick(c.palette.nouns, c.next)}`;
  },
  (c) => {
    const adj = pick(c.palette.adjectives, c.next);
    const n1 = pick(c.palette.nouns, c.next);
    return `${art(adj)} ${adj} ${pick(POET_LEXICON.eraWords, c.next)} of ${n1} and ${pickOther(c.palette.nouns, n1, c.next)}`;
  },
  (c) => {
    const n1 = pick(c.palette.nouns, c.next);
    return `we map the ${n1} with ${pick(c.palette.adjectives, c.next)} ${pickOther(c.palette.nouns, n1, c.next)}`;
  },
  (c) => {
    const a1 = pick(c.palette.adjectives, c.next);
    const n1 = pick(c.palette.nouns, c.next);
    return `${a1} ${n1}, ${pickOther(c.palette.adjectives, a1, c.next)} ${pickOther(c.palette.nouns, n1, c.next)} - the same ${pick(c.palette.temp, c.next)}`;
  },
  (c) => {
    const n1 = pick(c.palette.nouns, c.next);
    const n2 = pickOther(c.palette.nouns, n1, c.next);
    return `no ${n1} without ${n2}, no ${pick(c.palette.temp, c.next)} without the ${pickOther(c.palette.nouns, n1, c.next)}`;
  },
  (c) => {
    const n1 = pick(c.palette.nouns, c.next);
    return `somewhere ${art(n1)} ${n1} ${pick(c.palette.verbs, c.next)}, and the colony leans to listen`;
  },
  (c) => `the ${pick(c.palette.nouns, c.next)} keeps a ledger of ${pick(c.palette.temp, c.next)}`,
  (c) => {
    const adj = pick(c.palette.adjectives, c.next);
    const n1 = pick(c.palette.nouns, c.next);
    return `between ${n1} and ${pickOther(c.palette.nouns, n1, c.next)}, ${art(adj)} ${adj} hum holds`;
  },
  (c) => `${pick(c.palette.temp, c.next)} moves through the ${pick(c.palette.nouns, c.next)} like a memory`,
];

/** The 3 era line templates — the only lines that speak the era's given name. */
const ERA_TEMPLATES: Array<(c: Ctx, eraName: string) => string> = [
  (c, eraName) => `under ${eraName}, the ${pick(c.palette.nouns, c.next)} keeps its ${pick(c.palette.temp, c.next)}`,
  (c, eraName) => {
    const adj = pick(c.palette.adjectives, c.next);
    return `${eraName} - ${art(adj)} ${adj} ${pick(POET_LEXICON.eraWords, c.next)} for the colony`;
  },
  (c, eraName) => `they name this ${pick(POET_LEXICON.eraWords, c.next)} ${eraName}, and the ${pick(c.palette.nouns, c.next)} ${pick(c.palette.verbs, c.next)}`,
];

/** The 2 chronicle echo templates — the record speaking inside the poem. */
const ECHO_TEMPLATES: Array<(c: Ctx, kind: string, noun: string) => string> = [
  (c, kind, noun) => `the chronicle keeps ${noun} in its margins - ${kindPhrase(kind)}, written in ${pick(c.palette.adjectives, c.next)} light`,
  (c, kind, noun) => `${kindPhrase(kind)} hums through the record - they speak of ${noun}, and the ${pick(c.palette.nouns, c.next)} ${pick(c.palette.verbs, c.next)}`,
];

// ------------------------------------------------------------------------------------------------------------
// COMPOSITION
// ------------------------------------------------------------------------------------------------------------

function clampBand(temperature: number): number {
  const t = Number(temperature);
  if (!Number.isFinite(t)) return 1;
  return Math.max(0, Math.min(2, Math.floor(t * 3)));
}

/**
 * Compose one poem. PURE: same (input, seq, ts) → identical output, forever. `ts` is metadata only
 * (it never touches the verse); `hash` comes back "" — the caller fills it via `poemHash()` off the
 * hot path, exactly like the receipt hash flow.
 */
export function composePoem(input: PoemInput, seq: number, ts: number): Poem {
  const regime = normalizeRegime(input?.market?.regime);
  const palette = POET_LEXICON[regime];
  const next = makeRng(input?.seed ?? 0, seq, input?.tick ?? 0);
  const forbidden = otherPaletteTokens(regime);
  const band = clampBand(input?.market?.temperature ?? 0.5); // temperature is FELT: shifts template+temp-word picks
  const ctx: Ctx = { palette, next };

  const lines: string[] = [];

  // -- line 1: the era line (eraName softened into the verse; its char-sum biases the era word) ----------
  const eraName = soften(input?.eraName, "an unnamed age");
  const eraBias = [...eraName].reduce((acc, ch) => (acc + ch.charCodeAt(0)) % 9973, 0);
  const eraTpl = (rngInt(next, ERA_TEMPLATES.length) + eraBias + band) % ERA_TEMPLATES.length;
  lines.push(finishLine(ERA_TEMPLATES[eraTpl](ctx, eraName)));

  // -- chronicle echo lines: min(2, samples, room) echoes, drawn from a rotating window over the samples --
  const samples = Array.isArray(input?.chronicleSamples) ? input.chronicleSamples : [];
  const lineCount = 4 + rngInt(next, 5); // 4..8 lines, seed-decided
  const maxEcho = Math.max(1, lineCount - 3); // always keep room for >=1 generic line
  const echoCount = samples.length > 0 ? Math.min(samples.length, 2, maxEcho) : 0;
  const start = rngInt(next, samples.length || 1);
  for (let i = 0; i < echoCount; i++) {
    const s = samples[(start + i) % samples.length];
    const noun = keyNoun(s?.text, palette, forbidden, next);
    lines.push(finishLine(ECHO_TEMPLATES[rngInt(next, ECHO_TEMPLATES.length)](ctx, s?.kind, noun)));
  }

  // -- generic lines: xorshift picks template + words; band shifts the pick so temperature is felt -------
  let lastTpl = -1;
  for (let i = 0; i < lineCount - 2 - echoCount; i++) {
    let ti = (rngInt(next, GENERIC_TEMPLATES.length) + band) % GENERIC_TEMPLATES.length;
    if (ti === lastTpl) ti = (ti + 1 + rngInt(next, GENERIC_TEMPLATES.length - 1)) % GENERIC_TEMPLATES.length;
    lastTpl = ti;
    lines.push(finishLine(GENERIC_TEMPLATES[ti](ctx)));
  }

  // -- the crown line (always LAST): names the crowned fly, folds its temperament (+ behaviors) in -------
  const crownFly = input?.crownFly;
  const who = soften(crownFly?.temperament, "unwritten");
  const flyId = crownFly?.id;
  const idTxt = String(typeof flyId === "number" && Number.isFinite(flyId) ? flyId : 0);
  const behs = (Array.isArray(crownFly?.behaviors) ? crownFly.behaviors : [])
    .map((b) => soften(b, ""))
    .filter((b) => b.length > 0)
    .slice(0, 2);
  const behBit =
    behs.length >= 2 ? `remembered for ${behs[0]} and ${behs[1]}`
    : behs.length === 1 ? `remembered for ${behs[0]}`
    : "";
  const crownTpl = rngInt(next, 3);
  let crown: string;
  if (crownTpl === 0) {
    crown = behBit
      ? `fly ${idTxt} wears the laurel - ${who}, ${behBit}`
      : `fly ${idTxt} wears the laurel - ${who} in ${pick(palette.adjectives, next)} light`;
  } else if (crownTpl === 1) {
    crown = behBit
      ? `the crown rests on fly ${idTxt} - ${behs[0]} in its wings, ${who} as ever`
      : `the crown rests on fly ${idTxt} - ${who} as ever`;
  } else {
    crown = behBit
      ? `crowned this ${pick(POET_LEXICON.eraWords, next)} - fly ${idTxt}, ${who}, keeper of ${pick(palette.nouns, next)} and ${behs[0]}`
      : (() => {
          const adj = pick(palette.adjectives, next);
          return `crowned this ${pick(POET_LEXICON.eraWords, next)} - fly ${idTxt}, ${who} under ${art(adj)} ${adj} ${pick(palette.temp, next)}`;
        })();
  }
  lines.push(finishLine(crown));

  return {
    seq,
    ts,
    tick: input?.tick ?? 0,
    era: input?.era ?? 0,
    eraName: input?.eraName ?? "",
    crownFlyId: typeof flyId === "number" && Number.isFinite(flyId) ? flyId : 0,
    lines,
    seed: input?.seed ?? 0,
    hash: "", // filled by the caller: poem.hash = await poemHash(poem)
  };
}

// ------------------------------------------------------------------------------------------------------------
// HASHING — same family as netReceiptHash/entryHash (provenance.ts): canonical sorted-key JSON → sha256 hex.
// ------------------------------------------------------------------------------------------------------------

/** Sorted-key stable serialization of a poem (the bytes a verifier re-serializes to check the hash core). */
export function canonicalPoemJson(p: Poem): string {
  return canonical(p);
}

/**
 * sha256(canonical(poem minus the hash field)) as 64 lowercase hex — the poem's tamper-evident identity.
 * The hash field excludes itself (no self-reference); mutating `p.hash` therefore never changes poemHash(p).
 */
export async function poemHash(p: Poem): Promise<string> {
  const core: Record<string, unknown> = {};
  for (const k of Object.keys(p).sort()) {
    if (k === "hash") continue;
    core[k] = (p as unknown as Record<string, unknown>)[k];
  }
  return sha256Hex(core);
}

// ------------------------------------------------------------------------------------------------------------
// POET LEDGER — the in-memory hot book of recent poems (D1 persistence is the caller's job). Cap 50,
// newest wins, oldest silently dropped: the archive is long, the working memory is a laurel shelf.
// ------------------------------------------------------------------------------------------------------------

function isPoemLike(o: unknown): o is Poem {
  if (!o || typeof o !== "object") return false;
  const p = o as Record<string, unknown>;
  const lines = p.lines;
  return (
    typeof p.seq === "number" &&
    typeof p.ts === "number" &&
    typeof p.tick === "number" &&
    typeof p.era === "number" &&
    typeof p.eraName === "string" &&
    typeof p.crownFlyId === "number" &&
    Array.isArray(lines) &&
    lines.every((l) => typeof l === "string") &&
    typeof p.seed === "number" &&
    typeof p.hash === "string"
  );
}

export class PoetLedger {
  /** oldest → newest */
  private poems: Poem[] = [];

  /** Append a poem; beyond POET_LEDGER_CAP the oldest is dropped (丢最旧). */
  add(p: Poem): void {
    this.poems.push(p);
    if (this.poems.length > POET_LEDGER_CAP) this.poems.splice(0, this.poems.length - POET_LEDGER_CAP);
  }

  /** The newest poem, or null while the shelf is empty. */
  latest(): Poem | null {
    return this.poems.length > 0 ? this.poems[this.poems.length - 1] : null;
  }

  /** Newest → oldest (optionally truncated to `limit`). */
  list(limit?: number): Poem[] {
    const out = this.poems.slice().reverse();
    if (limit === undefined) return out;
    return out.slice(0, Math.max(0, Math.floor(limit)));
  }

  /** DO-safe snapshot: { v, poems[] } with poems oldest → newest. */
  toJSON(): unknown {
    return { v: POET_VERSION, poems: this.poems.slice() };
  }

  /** Restore from toJSON() output (or a bare poem array); malformed entries are skipped, the cap holds. */
  static fromJSON(o: unknown): PoetLedger {
    const led = new PoetLedger();
    let raw: unknown[] = [];
    if (Array.isArray(o)) raw = o;
    else if (o && typeof o === "object" && Array.isArray((o as Record<string, unknown>).poems)) {
      raw = (o as Record<string, unknown>).poems as unknown[];
    }
    for (const p of raw) if (isPoemLike(p)) led.poems.push(p);
    if (led.poems.length > POET_LEDGER_CAP) led.poems.splice(0, led.poems.length - POET_LEDGER_CAP);
    return led;
  }
}
