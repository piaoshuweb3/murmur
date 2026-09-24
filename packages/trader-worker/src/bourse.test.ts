// Bourse tests — pinning the ⑲ token-exchange weather module's pure core.
//
// The bourse folds OUR token's Transfer logs into a fever dial and four narrative moments. It is
// strictly read-only (no wallet, no settlement, no genome write, no manifest rotation), and its
// decision core is pure: clock, randomness and chain data all arrive as parameters, so every test
// below runs offline and byte-identically on any engine. What MUST hold:
//   1. ROUTING — reduceBourseLegs sends every leg to exactly one of {community, treasuryIn, dropped},
//      case-insensitively, with treasury-outflow (airdrop) legs fully excluded (防污染).
//   2. CALIBRATION — the first observation is the norm (fever 0.5); the slow EWMA baseline tracks the
//      regime, so ONE spike bends the fever without maxing it or sticking (anti-whale / anti-sybil).
//   3. EDGES — FEVER_BREAKOUT fires once per rising edge (latch + hysteresis), whales are community-only,
//      treasury milestones fire per cumulative step, LONG_SILENCE counts then clears.
//   4. MAPPING — coinStimuli is deterministic, hard-capped, and neutral markets emit nothing.
//   5. PERSISTENCE — toJSON → fromJSON round-trips state and the restored meter continues identically.

import test from "node:test";
import assert from "node:assert/strict";

import { keccak256, toBytes } from "viem";
import type { PublicClient } from "viem";

import {
  BourseMeter,
  FEVER_BREAKOUT_LEVEL,
  LONG_SILENCE_TICKS,
  TRANSFER_TOPIC,
  TREASURY_MILESTONE_STEP_RAW,
  coinStimuli,
  reduceBourseLegs,
  sampleBourseTransfers,
  type BourseConfig,
  type BourseReadOut,
  type RawTransfer,
} from "./bourse.js";

// ---------- fixtures (obviously synthetic addresses — the module hardcodes none) ----------

const TOKEN = "0x1111111111111111111111111111111111111111";
const TREASURY = "0xc0ffee0000000000000000000000000000000022";
const TREASURY_MIXED = "0xC0FFEE0000000000000000000000000000000022"; // checksummed same address
const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE_MIXED = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc";

const ETH = 10n ** 18n;
const WHALE_MIN = 1000n * ETH;

function cfg(over: Partial<BourseConfig> = {}): BourseConfig {
  return { token: TOKEN, treasury: TREASURY, whaleMinRaw: WHALE_MIN, lookbackBlocks: 2000n, ...over };
}

function leg(from: string, to: string, valueRaw: bigint, block = 100n, txHash = "0xtx1"): RawTransfer {
  return { from, to, valueRaw, txHash, blockNumber: block };
}

/** One community page of `n` legs (all alice→bob) of `tokens` MURMUR each, at consecutive blocks. */
function communityPage(n: number, tokens: bigint, baseBlock: bigint): RawTransfer[] {
  return Array.from({ length: n }, (_, i) =>
    leg(ALICE, BOB, tokens * ETH, baseBlock + BigInt(i), `0xtx${i}`),
  );
}

const eventsOf = (rs: BourseReadOut[], kind: BourseReadOut["events"][number]["kind"]) =>
  rs.flatMap((r) => r.events).filter((e) => e.kind === kind);

// ---------- 1. reduceBourseLegs routing ----------

test("reduceBourseLegs routes every leg into exactly one bucket, case-insensitively", () => {
  const s = reduceBourseLegs(
    [
      leg(ALICE, BOB, 5n * ETH, 100n, "0xa1"),              // community
      leg(BOB, CAROL, 2n * ETH, 101n, "0xa2"),              // community
      leg(ALICE, TREASURY, 7n * ETH, 102n, "0xa3"),         // treasuryIn
      leg(ALICE_MIXED, TREASURY_MIXED, 3n * ETH, 103n, "0xa4"), // mixed-case ⇒ still treasuryIn
    ],
    cfg(),
  );
  assert.equal(s.community.length, 2);
  assert.equal(s.treasuryIn.length, 2);
  assert.equal(s.treasuryIn[0].valueRaw, 7n * ETH);
  assert.equal(s.treasuryIn[1].valueRaw, 3n * ETH);
  assert.equal(s.blockNumber, 103n, "high-water block = max over all legs");
});

test("reduceBourseLegs drops treasury-out legs entirely (airdrop 防污染) — including self-transfers", () => {
  const s = reduceBourseLegs(
    [
      leg(TREASURY, BOB, 999n * ETH, 100n, "0xb1"),            // airdrop out ⇒ nothing at all
      leg(TREASURY_MIXED, ALICE, 500n * ETH, 101n, "0xb2"),    // case-insensitive drop
      leg(TREASURY, TREASURY, 4n * ETH, 107n, "0xb3"),         // self-transfer hits rule 1 ⇒ dropped
      leg(ALICE, BOB, 1n * ETH, 106n, "0xb4"),                 // the only surviving community leg
    ],
    cfg(),
  );
  assert.equal(s.community.length, 1, "airdrop legs are neither community nor treasury inflow");
  assert.equal(s.community[0].valueRaw, 1n * ETH);
  assert.equal(s.treasuryIn.length, 0);
  assert.equal(s.blockNumber, 107n, "high-water = max over ALL legs — here set by a DROPPED leg (cursor never re-scans)");
});

test("reduceBourseLegs folds an empty page to an empty sample at block 0n", () => {
  const s = reduceBourseLegs([], cfg());
  assert.equal(s.blockNumber, 0n);
  assert.equal(s.community.length, 0);
  assert.equal(s.treasuryIn.length, 0);
});

// ---------- 2. cold-start calibration & spike resistance ----------

test("cold start calibrates: first observation is the norm (fever 0.5) and same-tx legs count as legs", () => {
  const meter = new BourseMeter(cfg());
  // Two legs share tx 0xt1 (同一 tx 多腿算多腿) + one treasury inflow on a separate tx.
  const sample = reduceBourseLegs(
    [
      leg(ALICE, BOB, 3n * ETH, 10n, "0xt1"),
      leg(BOB, CAROL, 2n * ETH, 11n, "0xt1"),
      leg(ALICE, TREASURY, 5n * ETH, 12n, "0xt2"),
    ],
    cfg(),
  );
  const r = meter.update(sample, 1000);
  assert.equal(r.fever, 0.5, "冷首观测 = 定标");
  assert.equal(r.txCount, 2, "same tx twice ⇒ two legs (EWMA + cap absorb the sybil risk)");
  assert.equal(r.volumeRaw, (5n * ETH).toString());
  assert.equal(r.treasuryInRaw, (5n * ETH).toString());
  assert.equal(r.whale, false);
  assert.deepEqual(r.events, [], "the calibrating tick narrates nothing");
  assert.equal(r.silentTicks, 0);

  // A second identical tick sits exactly on the learned norm ⇒ still 0.5.
  const r2 = meter.update(reduceBourseLegs([leg(ALICE, BOB, 3n * ETH, 20n, "0xt3"), leg(BOB, CAROL, 2n * ETH, 21n, "0xt3")], cfg()), 2000);
  assert.equal(r2.fever, 0.5);
});

test("a single spike bends fever but cannot max it (EWMA smoothing), and it does not stick", () => {
  const meter = new BourseMeter(cfg());
  // Establish a quiet norm: 1 leg × 1 token per tick.
  for (let i = 1; i <= 10; i++) {
    meter.update(reduceBourseLegs(communityPage(1, 1n, BigInt(i)), cfg()), i * 1000);
  }
  // One enormous spike: 300 legs × 10 tokens (still below the whale threshold ⇒ no WHALE_MOVE noise).
  const spike = meter.update(reduceBourseLegs(communityPage(300, 10n, 1000n), cfg()), 11000);
  assert.ok(spike.fever > 0.6, "the spike registered (fever reacted)");
  assert.ok(spike.fever < 0.95, `a single spike must not max the dial (got ${spike.fever})`);
  assert.ok(spike.fever < 1, "never saturated to exactly 1");

  // The next quiet tick falls right back — the spike did not re-baseline the fever upward.
  const after = meter.update(reduceBourseLegs(communityPage(1, 1n, 1001n), cfg()), 12000);
  assert.ok(after.fever < 0.7, `fever unsticks after a spike (got ${after.fever})`);
});

// ---------- 3. narrative edges ----------

test("FEVER_BREAKOUT fires once per rising edge — latched through the hot run, re-armed after cooling", () => {
  const meter = new BourseMeter(cfg());
  const readouts: BourseReadOut[] = [];

  // Prime: 3 quiet ticks (1 leg × 1 token) ⇒ fever 0.5.
  for (let i = 1; i <= 3; i++) readouts.push(meter.update(reduceBourseLegs(communityPage(1, 1n, BigInt(i)), cfg()), i));

  // Phase B: sustained elevation (8 legs × 1 token × 5 ticks) — crosses 0.8 once and stays hot.
  for (let i = 4; i <= 8; i++) readouts.push(meter.update(reduceBourseLegs(communityPage(8, 1n, BigInt(i)), cfg()), i));
  assert.equal(eventsOf(readouts, "FEVER_BREAKOUT").length, 1, "exactly one breakout on the rising edge");
  assert.ok(readouts.every((r) => r.fever <= 0.99), "sustained heat never saturates to 1.0");
  assert.ok(eventsOf(readouts, "FEVER_BREAKOUT")[0].ts === 4, "event carries the injected tick ts");

  // Phase C: 15 silent ticks — fever decays below the reset level; the latch re-arms; no new breakout,
  // and 15 < 60 so LONG_SILENCE stays out of the way.
  const bCount = eventsOf(readouts, "FEVER_BREAKOUT").length;
  for (let i = 9; i <= 23; i++) readouts.push(meter.update(reduceBourseLegs([], cfg()), i));
  assert.equal(eventsOf(readouts, "FEVER_BREAKOUT").length, bCount, "no re-fire while latched / cooling");

  // Phase D: heat again ⇒ a fresh rising edge ⇒ a second breakout.
  for (let i = 24; i <= 28; i++) readouts.push(meter.update(reduceBourseLegs(communityPage(8, 1n, BigInt(i)), cfg()), i));
  assert.equal(eventsOf(readouts, "FEVER_BREAKOUT").length, bCount + 1, "re-armed after falling below reset");
  assert.ok(readouts[readouts.length - 1].fever > FEVER_BREAKOUT_LEVEL);
});

test("whale legs are detected on community legs only", () => {
  const meter = new BourseMeter(cfg());
  // Below threshold ⇒ no whale.
  let r = meter.update(reduceBourseLegs([leg(ALICE, BOB, 999n * ETH, 10n)], cfg()), 1);
  assert.equal(r.whale, false);
  assert.equal(eventsOf([r], "WHALE_MOVE").length, 0);

  // Exactly at threshold ⇒ whale (>= semantics), one event narrating the largest leg.
  r = meter.update(reduceBourseLegs([leg(ALICE, BOB, 1000n * ETH, 11n, "0xwhale")], cfg()), 2);
  assert.equal(r.whale, true);
  const whales = eventsOf([r], "WHALE_MOVE");
  assert.equal(whales.length, 1);
  assert.ok(whales[0].detail.includes("1000.0000"), "detail names the largest whale leg in MURMUR");
  assert.ok(whales[0].detail.includes("0xwhale"), "detail cites the tx for audit");

  // Multiple whale legs in one tick ⇒ still one event (per-kind per-tick cap).
  r = meter.update(
    reduceBourseLegs([leg(ALICE, BOB, 1000n * ETH, 12n), leg(BOB, CAROL, 2000n * ETH, 13n)], cfg()),
    3,
  );
  assert.equal(eventsOf([r], "WHALE_MOVE").length, 1);
  assert.ok(eventsOf([r], "WHALE_MOVE")[0].detail.includes("2 whale legs"));
  // A treasury INFLOW of whale size is not a whale (adaptation #3), and a treasury OUTFLOW of any
  // size never even reaches the meter (reduceBourseLegs drops it).
  r = meter.update(
    reduceBourseLegs(
      [leg(ALICE, TREASURY, 9999n * ETH, 14n), leg(TREASURY, BOB, 9999n * ETH, 15n)],
      cfg(),
    ),
    4,
  );
  assert.equal(r.whale, false);
  assert.equal(eventsOf([r], "WHALE_MOVE").length, 0);
});

test("TREASURY_MILESTONE fires on each cumulative crossing of the 1000-MURMUR step", () => {
  const meter = new BourseMeter(cfg());
  assert.equal(TREASURY_MILESTONE_STEP_RAW, 1000n * ETH);

  // 2500 tokens in one tick crosses milestones #1 and #2 ⇒ ONE event naming the highest.
  let r = meter.update(
    reduceBourseLegs([leg(ALICE, TREASURY, 500n * ETH, 10n), leg(BOB, TREASURY, 2000n * ETH, 11n)], cfg()),
    1,
  );
  assert.equal(r.treasuryInRaw, (2500n * ETH).toString());
  const ms1 = eventsOf([r], "TREASURY_MILESTONE");
  assert.equal(ms1.length, 1);
  assert.ok(ms1[0].detail.includes("#2"), ms1[0].detail);
  assert.ok(ms1[0].detail.includes("2500.0000"));

  // +800 crosses #3.
  r = meter.update(reduceBourseLegs([leg(ALICE, TREASURY, 800n * ETH, 12n)], cfg()), 2);
  assert.equal(eventsOf([r], "TREASURY_MILESTONE").length, 1);
  assert.ok(eventsOf([r], "TREASURY_MILESTONE")[0].detail.includes("#3"));

  // +500 stays inside milestone #3 ⇒ silent.
  r = meter.update(reduceBourseLegs([leg(ALICE, TREASURY, 500n * ETH, 13n)], cfg()), 3);
  assert.equal(eventsOf([r], "TREASURY_MILESTONE").length, 0);
});

test("LONG_SILENCE counts silent ticks, fires exactly at the threshold, then clears", () => {
  const meter = new BourseMeter(cfg());
  meter.update(reduceBourseLegs(communityPage(1, 1n, 1n), cfg()), 0); // one active tick first

  const readouts: BourseReadOut[] = [];
  for (let i = 1; i <= LONG_SILENCE_TICKS - 1; i++) {
    readouts.push(meter.update(reduceBourseLegs([], cfg()), i));
  }
  assert.equal(eventsOf(readouts, "LONG_SILENCE").length, 0, "no firing before the threshold");
  assert.equal(readouts[readouts.length - 1].silentTicks, LONG_SILENCE_TICKS - 1);

  const atThreshold = meter.update(reduceBourseLegs([], cfg()), LONG_SILENCE_TICKS);
  assert.equal(atThreshold.silentTicks, LONG_SILENCE_TICKS, "the firing tick reports the true run length");
  assert.equal(eventsOf([atThreshold], "LONG_SILENCE").length, 1);

  const next = meter.update(reduceBourseLegs([], cfg()), LONG_SILENCE_TICKS + 1);
  assert.equal(next.silentTicks, 1, "the counter cleared after firing and restarted");
  assert.equal(eventsOf([next], "LONG_SILENCE").length, 0);

  // Community activity resets silence immediately.
  const active = meter.update(reduceBourseLegs(communityPage(1, 1n, 200n), cfg()), LONG_SILENCE_TICKS + 2);
  assert.equal(active.silentTicks, 0);

  // And a full silent stretch later fires again — exactly 2 LONG_SILENCE events over 121 silent
  // ticks (one event per 60 silent ticks, forever, never a flood).
  const meter2 = new BourseMeter(cfg());
  meter2.update(reduceBourseLegs(communityPage(1, 1n, 1n), cfg()), 0);
  let fired = 0;
  for (let i = 1; i <= LONG_SILENCE_TICKS * 2 + 1; i++) {
    fired += eventsOf([meter2.update(reduceBourseLegs([], cfg()), i)], "LONG_SILENCE").length;
  }
  assert.equal(fired, 2, "one event per 60 silent ticks, forever (never a flood)");
});

// ---------- 4. coinStimuli ----------

test("coinStimuli maps the read-out onto the four channels deterministically and hard-capped", () => {
  // Neutral market emits nothing at all.
  const neutral: BourseReadOut = { fever: 0.5, txCount: 0, volumeRaw: "0", treasuryInRaw: "0", whale: false, events: [], silentTicks: 0 };
  assert.deepEqual(coinStimuli(neutral), []);

  // fever 高 → food (scaled above the midline).
  const hot = coinStimuli({ ...neutral, fever: 0.9 });
  assert.equal(hot.length, 1);
  assert.equal(hot[0].type, "food");
  assert.ok(Math.abs(hot[0].intensity - 0.35 * 0.8) < 1e-12);
  assert.equal(hot[0].from, "bourse");

  // fever 极低 → dark; 长静默 → dark at the cap.
  const cold = coinStimuli({ ...neutral, fever: 0.1 });
  assert.equal(cold.length, 1);
  assert.equal(cold[0].type, "dark");
  assert.ok(Math.abs(cold[0].intensity - 0.35 * (0.2 / 0.3)) < 1e-12);
  const dead = coinStimuli({ ...neutral, silentTicks: LONG_SILENCE_TICKS });
  assert.deepEqual(dead.map((s) => s.type), ["dark"]);
  assert.ok(Math.abs(dead[0].intensity - 0.35) < 1e-12);

  // whale → threat, light-handed (half cap); breakout → light at the full cap.
  const scared = coinStimuli({ ...neutral, whale: true });
  assert.deepEqual(scared.map((s) => s.type), ["threat"]);
  assert.ok(Math.abs(scared[0].intensity - 0.175) < 1e-12);
  const lit = coinStimuli({ ...neutral, events: [{ kind: "FEVER_BREAKOUT", detail: "", ts: 0 }] });
  assert.deepEqual(lit.map((s) => s.type), ["light"]);
  assert.ok(Math.abs(lit[0].intensity - 0.35) < 1e-12);

  // Everything at once ⇒ all four channels, every intensity ≤ cap (and ≤ an explicitly smaller cap).
  const all: BourseReadOut = { ...neutral, fever: 1, whale: true, silentTicks: LONG_SILENCE_TICKS, events: [{ kind: "FEVER_BREAKOUT", detail: "", ts: 0 }] };
  for (const cap of [undefined, 0.1, 1]) {
    const stim = coinStimuli(all, cap);
    assert.equal(stim.length, 4);
    for (const s of stim) {
      assert.ok(s.intensity <= (cap ?? 0.35) + 1e-12, `intensity ${s.intensity} capped at ${cap ?? 0.35}`);
      assert.ok(s.intensity > 0);
      assert.equal(s.from, "bourse");
    }
  }

  // Determinism: same input ⇒ byte-identical output.
  assert.equal(JSON.stringify(coinStimuli(all)), JSON.stringify(coinStimuli(all)));
});

// ---------- 5. persistence ----------

test("toJSON → fromJSON round-trips state and the restored meter continues identically", () => {
  const meter = new BourseMeter(cfg());
  // A mixed history: community + treasury inflow + a whale, then quiet ticks, then more activity.
  meter.update(
    reduceBourseLegs(
      [
        leg(ALICE, BOB, 50n * ETH, 10n, "0xp1"),
        leg(BOB, CAROL, 1200n * ETH, 11n, "0xp2"),   // whale
        leg(ALICE, TREASURY, 1500n * ETH, 12n, "0xp3"), // milestone #1
        leg(TREASURY, ALICE, 8n * ETH, 13n, "0xp4"), // airdrop ⇒ dropped upstream
      ],
      cfg(),
    ),
    1,
  );
  for (let i = 2; i <= 10; i++) meter.update(reduceBourseLegs([], cfg()), i);
  meter.update(reduceBourseLegs(communityPage(2, 3n, 100n), cfg()), 11);

  const snap1 = JSON.parse(JSON.stringify(meter.toJSON()));
  const restored = BourseMeter.fromJSON(snap1);
  const snap2 = JSON.parse(JSON.stringify(restored.toJSON()));
  assert.deepEqual(snap2, snap1, "structural round-trip (bigint thresholds survive as strings)");

  // Behavioural continuation: both meters fold the SAME new pages into identical read-outs.
  const pageA = reduceBourseLegs(
    [
      ...communityPage(4, 2n, 200n),
      leg(ALICE, TREASURY, 2000n * ETH, 205n, "0xq9"), // another milestone, identical on both
      leg(TREASURY, BOB, 77n * ETH, 206n, "0xq8"),     // airdrop ⇒ dropped on both (cfg restored)
      leg(ALICE, BOB, 5000n * ETH, 207n, "0xq7"),      // whale on both (whaleMinRaw restored)
    ],
    cfg(),
  );
  const a = meter.update(pageA, 12);
  const b = restored.update(pageA, 12); // same array object: the fold must not mutate its input
  assert.deepEqual(b, a, "restored meter continues byte-identically");
  assert.ok(a.whale, "whale threshold survived the round-trip");
  assert.ok(a.events.some((e) => e.kind === "TREASURY_MILESTONE"), "cumulative treasury inflow survived");
});

// ---------- 6. chain-facing thin wrapper ----------

test("TRANSFER_TOPIC is the canonical ERC-20 Transfer signature hash", () => {
  assert.equal(TRANSFER_TOPIC, keccak256(toBytes("Transfer(address,address,uint256)")));
  assert.equal(TRANSFER_TOPIC, "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
});

test("sampleBourseTransfers decodes a getLogs page into normalized RawTransfers", async () => {
  const LOGS = [
    {
      args: { from: ALICE_MIXED, to: BOB, value: 3n },
      transactionHash: "0xh1",
      blockNumber: 41n,
    },
    {
      // pending-ish log: no hash/block yet; mixed-case treasury destination lowercases.
      args: { from: BOB, to: TREASURY_MIXED, value: 7n },
      transactionHash: null,
      blockNumber: null,
    },
  ];
  let captured: Record<string, unknown> | null = null;
  const stub = {
    getLogs: async (args: Record<string, unknown>) => {
      captured = args;
      return LOGS;
    },
  } as unknown as PublicClient;

  const out = await sampleBourseTransfers(stub, TOKEN, 40n, 45n);
  assert.ok(captured, "getLogs was called exactly once for the page");
  assert.equal(captured.address, TOKEN, "token address passes through");
  assert.equal(captured.fromBlock, 40n);
  assert.equal(captured.toBlock, 45n);
  assert.ok(captured.event, "the parsed Transfer event is passed to getLogs");
  assert.deepEqual(out, [
    { from: ALICE, to: BOB, valueRaw: 3n, txHash: "0xh1", blockNumber: 41n },
    { from: BOB, to: TREASURY, valueRaw: 7n, txHash: "", blockNumber: 0n },
  ]);
});
