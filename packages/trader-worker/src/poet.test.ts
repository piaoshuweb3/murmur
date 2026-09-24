// Laureate tests — the poet is a PURE deterministic lexical combinator with a provable no-LLM contract:
//   1. DETERMINISM: same (input, seq, ts) → byte-identical poem; the seed is the only dice.
//   2. FORM: 4-8 lines, every line lowercase and stripped to [a-z 0-9 comma hyphen]; the LAST line always
//      names the crowned fly and folds its temperament into the verse.
//   3. PALETTE DISCIPLINE: the three regime palettes are disjoint token sets — a COLD poem contains no
//      scorching word, a HOT poem no frost word, a CALM poem neither (checked against the exported lexicon).
//   4. CHRONICLE ECHOES: excerpt kinds are spoken verbatim ("a birth", "an elegy") and their key nouns are
//      woven into the lines — the record keeps speaking inside the poem.
//   5. HASH: canonicalPoemJson is key-order independent; poemHash is stable, 64-hex, content-sensitive and
//      self-excluding (mutating p.hash never changes poemHash(p)).
//   6. LEDGER: cap 50 (oldest dropped), newest→oldest listing, DO-safe toJSON/fromJSON round-trip.
//
// These tests do NOT reach into state/economy/D1 — the poet is decoupled via the PoemInput shape.

import test from "node:test";
import assert from "node:assert/strict";

import {
  composePoem,
  canonicalPoemJson,
  poemHash,
  PoetLedger,
  POET_LEDGER_CAP,
  POET_LEXICON,
  type Poem,
  type PoemInput,
} from "./poet.js";

/** A rich baseline input: warm era, crowned fly with temperament + behaviors, two chronicle excerpts. */
function input(over: Partial<PoemInput> = {}): PoemInput {
  return {
    tick: 1337,
    era: 3,
    eraName: "the Long Warm",
    crownFly: { id: 42, temperament: "Sun-Drunk!!", behaviors: ["WINGBEAT", "AGGREGATE", "rest"] },
    chronicleSamples: [
      { kind: "BIRTH", text: "lanternfall lanternfall lanternfall" },
      { kind: "ELEGY", text: "rainshroud rainshroud rainshroud" },
    ],
    market: { temperature: 0.82, regime: "HOT" },
    seed: 7,
    ...over,
  };
}

function tokensOf(p: Poem): string[] {
  return p.lines.join(" ").match(/[a-z0-9-]+/g) ?? [];
}

function paletteTokens(key: "hot" | "cold" | "calm"): Set<string> {
  const p = POET_LEXICON[key];
  return new Set([...p.nouns, ...p.adjectives, ...p.verbs, ...p.temp]);
}

// ------------------------------------------------------------------------------------------------------------
// 1. DETERMINISM — the not-an-LLM proof, part one
// ------------------------------------------------------------------------------------------------------------

test("composePoem() is deterministic: same input twice, byte-identical poem", () => {
  const a = composePoem(input(), 11, 1_700_000_000_000);
  const b = composePoem(input(), 11, 1_700_000_000_000);
  assert.deepEqual(b, a);
  assert.equal(JSON.stringify(b), JSON.stringify(a));
  // ts is metadata: it never leaks into the verse
  const otherTs = composePoem(input(), 11, 4_000_000_000_000);
  assert.deepEqual(otherTs.lines, a.lines);
});

test("the seed is the dice: a different seed writes a different poem", () => {
  const a = composePoem(input({ seed: 7 }), 11, 1);
  const b = composePoem(input({ seed: 987654321 }), 11, 1);
  assert.notDeepEqual(b.lines, a.lines);
});

test("hash flow: compose leaves hash empty; poemHash fills a stable digest", async () => {
  const p = composePoem(input(), 1, 1);
  assert.equal(p.hash, "");
  const h1 = await poemHash(p);
  const h2 = await poemHash(p);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

// ------------------------------------------------------------------------------------------------------------
// 2. FORM — line bounds + verse discipline + the crown line
// ------------------------------------------------------------------------------------------------------------

test("every poem has 4-8 lowercase lines over the allowed alphabet", () => {
  for (let seed = 0; seed < 300; seed++) {
    for (const regime of ["HOT", "COLD", "CALM"] as const) {
      const p = composePoem(input({ seed, market: { temperature: 0.5, regime } }), seed, 1);
      assert.ok(p.lines.length >= 4 && p.lines.length <= 8, `seed ${seed} regime ${regime}: ${p.lines.length} lines`);
      for (const line of p.lines) {
        assert.ok(line.length > 0, `empty line at seed ${seed}`);
        assert.match(line, /^[a-z0-9 ,\-]+$/, `seed ${seed}: undisciplined line: ${line}`);
        assert.equal(line, line.toLowerCase());
      }
    }
  }
});

test("the last line is the coronation: fly id + temperament, temperament sanitized into the verse", () => {
  const p = composePoem(input({ crownFly: { id: 42, temperament: "Sun-Drunk!!", behaviors: [] } }), 5, 1);
  const last = p.lines[p.lines.length - 1];
  assert.match(last, /fly 42\b/);
  assert.match(last, /sun-drunk/); // "Sun-Drunk!!" softened, dash preserved
  assert.equal(p.crownFlyId, 42);
});

test("crown-fly behaviors are remembered in the verse when the crown template carries them", () => {
  // scan a few seeds: beh-carrying crown variants exist, so some seed must weave WINGBEAT in
  let seen = false;
  for (let seed = 0; seed < 60 && !seen; seed++) {
    const p = composePoem(input({ seed }), seed, 1);
    seen = p.lines[p.lines.length - 1].includes("wingbeat");
  }
  assert.ok(seen, "no crown line ever remembered a behavior across 60 seeds");
});

test("poem metadata mirrors the input (tick/era/eraName/seq/ts verbatim)", () => {
  const p = composePoem(input({ eraName: "the Long Warm" }), 77, 123_456);
  assert.equal(p.seq, 77);
  assert.equal(p.ts, 123_456);
  assert.equal(p.tick, 1337);
  assert.equal(p.era, 3);
  assert.equal(p.eraName, "the Long Warm"); // stored verbatim; only the verse is softened
});

// ------------------------------------------------------------------------------------------------------------
// 3. PALETTE DISCIPLINE — the colouring is a testable property of the ORIGINAL lexicon
// ------------------------------------------------------------------------------------------------------------

test("lexicon sanity: the three regime palettes are mutually disjoint token sets", () => {
  const hot = paletteTokens("hot");
  const cold = paletteTokens("cold");
  const calm = paletteTokens("calm");
  for (const [a, b, an, bn] of [
    [hot, cold, "hot", "cold"],
    [hot, calm, "hot", "calm"],
    [cold, calm, "cold", "calm"],
  ] as Array<[Set<string>, Set<string>, string, string]>) {
    for (const w of a) assert.ok(!b.has(w), `palette clash: "${w}" is in both ${an} and ${bn}`);
  }
  assert.ok(POET_LEXICON.eraWords.length >= 8, "era-word class should be a real vocabulary");
});

test("regime colouring: COLD poems hold no scorching word, HOT none frost, CALM neither", () => {
  const hot = paletteTokens("hot");
  const cold = paletteTokens("cold");
  const cases: Array<{ regime: string; forbidden: Set<string> }> = [
    { regime: "COLD", forbidden: hot },
    { regime: "HOT", forbidden: cold },
    { regime: "CALM", forbidden: new Set([...hot, ...cold]) },
    { regime: "WEIRD", forbidden: new Set([...hot, ...cold]) }, // unknown regime → neutral palette
  ];
  for (const { regime, forbidden } of cases) {
    for (let seed = 0; seed < 40; seed++) {
      const p = composePoem(input({ seed, market: { temperature: 0.5, regime } }), seed, 1);
      for (const t of tokensOf(p)) {
        assert.ok(!forbidden.has(t), `regime ${regime} seed ${seed}: foreign palette word "${t}" in: ${p.lines.join(" | ")}`);
      }
    }
  }
});

test("temperature is felt: the same seed at different temperatures does not always read the same", () => {
  let differing = 0;
  const base = composePoem(input({ market: { temperature: 0.05, regime: "CALM" } }), 9, 1).lines.join("\n");
  for (const t of [0.4, 0.75, 0.95]) {
    const lines = composePoem(input({ market: { temperature: t, regime: "CALM" } }), 9, 1).lines.join("\n");
    if (lines !== base) differing++;
  }
  assert.ok(differing >= 2, "temperature bands should shift the verse for most bands");
});

// ------------------------------------------------------------------------------------------------------------
// 4. CHRONICLE ECHOES — the record speaking inside the poem
// ------------------------------------------------------------------------------------------------------------

test("excerpt kinds are spoken verbatim and key nouns are woven in (1-2 echo lines)", () => {
  // single distinct key noun per excerpt (repeated → always the picked candidate), so assertions are exact
  let found: Poem | null = null;
  for (let seed = 0; seed < 40 && !found; seed++) {
    const p = composePoem(input({ seed }), seed, 1); // lineCount >= 5 → both echoes fit
    if (p.lines.length >= 5) found = p;
  }
  assert.ok(found, "no seed produced a 5+ line poem in 40 tries");
  const joined = found!.lines.join(" | ");
  assert.ok(joined.includes("a birth"), `BIRTH kind not spoken: ${joined}`);
  assert.ok(joined.includes("an elegy"), `ELEGY kind not spoken: ${joined}`);
  assert.ok(joined.includes("lanternfall"), `excerpt key noun not woven in: ${joined}`);
  assert.ok(joined.includes("rainshroud"), `excerpt key noun not woven in: ${joined}`);
});

test("one excerpt yields one echo; poems with excerpts differ from poems without", () => {
  const withSamples = composePoem(input({ chronicleSamples: [{ kind: "PANIC", text: "stampede" }] }), 3, 1);
  assert.ok(withSamples.lines.join(" ").includes("a panic"));
  const without = composePoem(input({ chronicleSamples: [] }), 3, 1);
  assert.notDeepEqual(without.lines, withSamples.lines);
});

test("foreign-palette words never ride in through an excerpt's key noun", () => {
  // regime COLD, but the chronicle text drips with scorching vocabulary — the poet must refuse it
  const p = composePoem(
    input({
      seed: 3,
      market: { temperature: 0.1, regime: "COLD" },
      chronicleSamples: [{ kind: "FEAST", text: "molten ember blaze simmers scorching" }],
    }),
    3,
    1,
  );
  const hot = paletteTokens("hot");
  for (const t of tokensOf(p)) assert.ok(!hot.has(t), `hot word "${t}" smuggled into a COLD poem`);
});

// ------------------------------------------------------------------------------------------------------------
// 5. HASH — canonical form, key-order independence, self-exclusion
// ------------------------------------------------------------------------------------------------------------

test("canonicalPoemJson is stable under key reordering", () => {
  const a = {
    seq: 3, ts: 123, tick: 9, era: 2, eraName: "the long warm",
    crownFlyId: 7, lines: ["one", "two - three"], seed: 5, hash: "",
  };
  const b = {
    lines: ["one", "two - three"], hash: "", seed: 5, crownFlyId: 7,
    eraName: "the long warm", era: 2, tick: 9, ts: 123, seq: 3,
  };
  assert.equal(canonicalPoemJson(a as Poem), canonicalPoemJson(b as Poem));
});

test("poemHash is key-order independent, self-excluding and content-sensitive", async () => {
  const a = composePoem(input(), 3, 1);
  const b: Poem = { ...a }; // same fields; spread preserves order but poemHash sorts keys anyway
  assert.equal(await poemHash(a), await poemHash(b));

  const shuffled: Poem = {
    hash: "", lines: a.lines, seed: a.seed, crownFlyId: a.crownFlyId,
    eraName: a.eraName, era: a.era, tick: a.tick, ts: a.ts, seq: a.seq,
  };
  assert.equal(await poemHash(shuffled), await poemHash(a));

  const withHash: Poem = { ...a, hash: "f".repeat(64) };
  assert.equal(await poemHash(withHash), await poemHash(a), "hash field must exclude itself");

  const edited: Poem = { ...a, lines: [...a.lines.slice(0, -1), "a changed line"] };
  assert.notEqual(await poemHash(edited), await poemHash(a));
});

// ------------------------------------------------------------------------------------------------------------
// 6. LEDGER — cap 50, newest→oldest, JSON round-trip
// ------------------------------------------------------------------------------------------------------------

function poemSeq(seq: number): Poem {
  const p = composePoem(input({ seed: seq * 7919 }), seq, 1_700_000_000_000 + seq);
  p.hash = `h${seq}`;
  return p;
}

test("PoetLedger caps at 50 and drops the oldest", () => {
  const led = new PoetLedger();
  for (let seq = 1; seq <= POET_LEDGER_CAP + 10; seq++) led.add(poemSeq(seq));
  const all = led.list();
  assert.equal(all.length, POET_LEDGER_CAP);
  assert.equal(all[0].seq, POET_LEDGER_CAP + 10); // newest first
  assert.equal(all[all.length - 1].seq, 11); // seq 1..10 already dropped
  assert.equal(led.latest()?.seq, POET_LEDGER_CAP + 10);
});

test("PoetLedger lists newest→oldest and honours limit", () => {
  const led = new PoetLedger();
  for (let seq = 1; seq <= 8; seq++) led.add(poemSeq(seq));
  assert.deepEqual(led.list(3).map((p) => p.seq), [8, 7, 6]);
  assert.deepEqual(led.list().map((p) => p.seq), [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepEqual(led.list(0), []);
  const empty = new PoetLedger();
  assert.equal(empty.latest(), null);
  assert.deepEqual(empty.list(), []);
});

test("PoetLedger round-trips through toJSON/fromJSON (incl. via real JSON bytes)", () => {
  const led = new PoetLedger();
  for (let seq = 1; seq <= 5; seq++) led.add(poemSeq(seq));
  const restored = PoetLedger.fromJSON(JSON.parse(JSON.stringify(led.toJSON())));
  assert.deepEqual(restored.list(), led.list());
  assert.deepEqual(restored.latest(), led.latest());
});

test("PoetLedger.fromJSON is tolerant of garbage and enforces the cap", () => {
  assert.equal(PoetLedger.fromJSON(null).list().length, 0);
  assert.equal(PoetLedger.fromJSON({ poems: "nope" }).list().length, 0);
  assert.equal(PoetLedger.fromJSON({ v: 1, poems: [{ seq: "bad" }, poemSeq(1)] }).list().length, 1);

  // a bare array is accepted too, and the cap still holds (newest 50 kept)
  const arr: unknown[] = [];
  for (let seq = 1; seq <= POET_LEDGER_CAP + 20; seq++) arr.push(JSON.parse(JSON.stringify(poemSeq(seq))));
  const led = PoetLedger.fromJSON(arr);
  assert.equal(led.list().length, POET_LEDGER_CAP);
  assert.equal(led.list()[0].seq, POET_LEDGER_CAP + 20);
  assert.equal(led.list()[POET_LEDGER_CAP - 1].seq, 21);
});
