import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBriefing, type BriefingInput } from "./briefing.js";

const BASE: BriefingInput = {
  site: "https://flyx402.xyz",
  tokenCa: "0x43D84EfE7174637cdA55Ae1560cd4BFf4BaAB490",
  explorer: "https://explorer.arc.io",
  reddit: "https://www.reddit.com/r/flyx402/",
  generatedAt: 1790243868126,
  temperature: 0.9,
  regime: "HOT",
  era: "the Fever",
  eraSeq: 27,
  tick: 7764,
  liveAgents: 22,
  behaviors: [
    { label: "agitate", count: 13 },
    { label: "explore", count: 9 },
  ],
  fever: 0.5,
  bourseLive: true,
  poem: { seq: 2, eraName: "the Fever", firstLine: "they name this passage the fever" },
  annals: [
    { kind: "MARKET_SHIFT", text: "the tape turned and the huddle tightened", ts: 1790240000000 },
    { kind: "ERA_PASSAGE", text: "the era bell rang and the flock kept its name", ts: 1790239000000 },
  ],
  totals: { trades: 28, settled: 3, volumeUsdc: 0.42 },
  weekly: { days: 10080, tempMin: 0.2, tempMax: 0.91, tempAvg: 0.55, settles: 12, deals: 900, volumeUsdc: 3.7 },
};

test("determinism: same input → byte-identical output", () => {
  const a = buildBriefing(BASE);
  const b = buildBriefing(BASE);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("posts are bilingual, linked, and Reddit-ready", () => {
  const b = buildBriefing(BASE);
  assert.equal(b.redditPost.length, 2);
  const [en, zh] = b.redditPost;
  assert.equal(en.lang, "en");
  assert.equal(zh.lang, "zh");
  for (const p of b.redditPost) {
    assert.ok(p.body.includes("flyx402.xyz"));
    assert.ok(p.body.includes("reddit.com/r/flyx402"));
    assert.ok(p.body.includes("explorer.arc.io"));
    assert.ok(p.body.includes("0x43D84EfE7174637cdA55Ae1560cd4BFf4BaAB490"));
    assert.ok(p.body.length <= 4000);
    assert.ok(p.title.length <= 300);
  }
  assert.ok(en.body.includes("28 trades folded → **3 on-chain settlements**"));
  assert.ok(en.body.includes("The Laureate's poem #2"));
  assert.ok(zh.body.includes("28 笔交易折叠为 **3 笔链上结算**"));
  assert.ok(zh.body.includes("桂冠诗人第 2 首"));
  assert.ok(zh.body.includes("灼热"));
});

test("empty-state degrades honestly (no invented numbers, no crash)", () => {
  const b = buildBriefing({
    ...BASE,
    temperature: null,
    regime: null,
    era: null,
    eraSeq: null,
    tick: null,
    liveAgents: null,
    behaviors: [],
    fever: null,
    bourseLive: false,
    poem: null,
    annals: [],
    totals: { trades: 0, settled: 0, volumeUsdc: 0 },
    weekly: { days: 0, tempMin: null, tempMax: null, tempAvg: null, settles: 0, deals: 0, volumeUsdc: 0 },
  });
  const en = b.redditPost[0].body;
  assert.ok(en.includes("awaiting the first settled net"));
  assert.ok(!en.includes("Bourse fever"));
  assert.ok(!en.includes("The Laureate's poem"));
  assert.ok(!en.includes("Week in review")); // days=0 → 周报段落整体省略
  assert.equal(b.daily.temperature, null);
  assert.equal(b.daily.topBehaviors.length, 0);
  assert.equal(b.weekly.days, 0);
});

test("settled==0 with folded trades still tells the fold story", () => {
  const b = buildBriefing({ ...BASE, totals: { trades: 41, settled: 0, volumeUsdc: 0 } });
  assert.ok(b.redditPost[0].body.includes("41 trades folded, awaiting the first settled net"));
});

test("post body hard-capped at 4000 chars even with a hostile input", () => {
  const b = buildBriefing({
    ...BASE,
    annals: Array.from({ length: 3 }, (_, i) => ({
      kind: "X",
      text: "word ".repeat(2000) + i,
      ts: 1790240000000 + i,
    })),
  });
  for (const p of b.redditPost) assert.ok(p.body.length <= 4000);
});
