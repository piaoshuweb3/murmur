// Sell/exit-layer tests (P2-1) — the exit rails, the position book, and the sell short-circuit.
//
// Contracts under test (all offline, deterministic via the explicit `now`):
//   1. the five exit rules fire at the right thresholds, in the documented priority order;
//   2. "no mark → no price-based decision" — the conservative default (time exits still fire);
//   3. EXITS ARE NEVER THROTTLED: the risk rails' sell short-circuit passes full-size exits even
//      with the daily budget exhausted, the cooldown hot, and zero confidence floor clearance;
//   4. the PositionBook keeps an honest ledger across average-ins, marks and closes, survives a
//      serialize/restore round-trip (the DO-storage persistence path), and computes realised P&L.

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateExit, buildExitIntents, exitRulesFromEnv, DEFAULT_EXIT_RULES, type ExitRules, type TokenMark } from "./exits.js";
import { PositionBook, type Position } from "./positions.js";
import { evaluateRisk } from "./risk.js";
import type { ExecutionIntent, ExecutionResult } from "./types.js";

const NOW = 1_800_000_000_000;
const TOKEN = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

const rules = (over: Partial<ExitRules> = {}): ExitRules => ({ ...DEFAULT_EXIT_RULES, ...over });

function position(over: Partial<Position> = {}): Position {
  return {
    token: TOKEN,
    chain: "solana",
    entryAt: NOW - 60_000,              // one minute old by default (no time exit)
    entryUsd: 3,
    entryPriceUsd: 1,                   // normalised: rules below speak in multiples of entry
    tokenAmount: 3,
    peakPriceUsd: 1,
    lastMarkUsd: 1,
    updatedAt: NOW - 60_000,
    ...over,
  };
}

function sellIntent(over: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    id: "ext-1-exit-sell",
    token: TOKEN,
    chain: "solana",
    side: "sell",
    strength: 1,
    confidence: 1,
    maxSlippageBps: 300,
    deadline: Math.floor(NOW / 1000) + 60,
    sourceFlyIds: [],
    suggestedAmountUsd: 3,
    note: "exit: test",
    ...over,
  };
}

const shadowSell = (usd = 3): ExecutionResult => ({
  status: "shadow", intentId: "x", amountIn: usd.toFixed(4), amountUsd: usd,
  reason: "REAL_SPEND=false", timestamp: NOW,
});

// ---------- the five exit rules ----------

test("stop-loss: fires at/below entry×(1−stop), silent above it", () => {
  // peak kept below entry so the trailing stop stays DISARMED and the hard stop is the only candidate.
  const r = rules({ stopLossPct: 0.2 });
  const p = position({ peakPriceUsd: 0.95 });
  assert.equal(evaluateExit(p, r, NOW, { priceUsd: 0.79 }).exit, true);   // −21%
  assert.equal(evaluateExit(p, r, NOW, { priceUsd: 0.81 }).exit, false);  // −19%
  const d = evaluateExit(position(), r, NOW, { priceUsd: 0.5 });
  assert.ok(d.exit && d.reason.includes("stop-loss"));
});

test("rug exit: liquidity below the floor fires regardless of P&L", () => {
  const r = rules({ rugLiquidityUsd: 5_000 });
  const d = evaluateExit(position(), r, NOW, { priceUsd: 1.2, liquidityUsd: 3_000 });
  assert.ok(d.exit && d.reason.includes("rug-risk"));
  // Liquidity above the floor never trips it.
  assert.equal(evaluateExit(position(), r, NOW, { priceUsd: 1.2, liquidityUsd: 30_000 }).exit, false);
});

test("trailing stop: protects the round-trip off the peak, peak-gated", () => {
  // takeProfitPct raised so the TP rail can't fire and the trail is the rule under test.
  const r = rules({ trailingStopPct: 0.15, takeProfitPct: 0.9 });
  // Rode to 1.80, now 1.50 (−16.7% off peak) → exit; 1.60 (−11%) → hold.
  const peaked = position({ peakPriceUsd: 1.8 });
  const d = evaluateExit(peaked, r, NOW, { priceUsd: 1.5 });
  assert.ok(d.exit && d.reason.includes("trailing"));
  assert.equal(evaluateExit(peaked, r, NOW, { priceUsd: 1.6 }).exit, false);

  // Under water with a below-entry peak: the hard stop owns the downside, the trail stays silent
  // (otherwise a tiny bounce+fade would sell the absolute bottom). Entry 0.7 → stop floor 0.56;
  // peak 0.9 → trail threshold 0.765; mark 0.78 clears both.
  assert.equal(
    evaluateExit(position({ entryPriceUsd: 0.7, peakPriceUsd: 0.9 }), r, NOW, { priceUsd: 0.78 }).exit,
    false,
  );
});

test("take-profit: banks the move above entry×(1+tp)", () => {
  // peak kept below entry so the trailing stop can't interfere; 1.51 vs 1.40 isolates the TP rail.
  const r = rules({ takeProfitPct: 0.5 });
  const p = position({ peakPriceUsd: 0.95 });
  const d = evaluateExit(p, r, NOW, { priceUsd: 1.51 });
  assert.ok(d.exit && d.reason.includes("take-profit"));
  assert.equal(evaluateExit(p, r, NOW, { priceUsd: 1.4 }).exit, false);
});

test("time exit: fires on age even with NO marks at all (never-priced position)", () => {
  const r = rules({ maxHoldMs: 6 * 3_600_000 });
  const aged = position({ entryAt: NOW - 7 * 3_600_000, entryPriceUsd: 0, tokenAmount: 0, lastMarkUsd: 0, peakPriceUsd: 0 });
  const d = evaluateExit(aged, r, NOW, {}); // no mark, no price history
  assert.ok(d.exit && d.reason.includes("time-exit"));

  // Young + unpriced ⇒ everything stays silent (hold is the conservative default).
  assert.equal(evaluateExit(position({ entryPriceUsd: 0, tokenAmount: 0, lastMarkUsd: 0, peakPriceUsd: 0 }), r, NOW, {}).exit, false);
});

test("priority: stop-loss outranks take-profit/rug signals when several could fire", () => {
  const d = evaluateExit(position(), rules(), NOW, { priceUsd: 0.5, liquidityUsd: 100 });
  assert.ok(d.exit && d.reason.includes("stop-loss"));
});

test("exitRulesFromEnv: env overrides + coded defaults", () => {
  const r = exitRulesFromEnv({ EXIT_STOP_LOSS_PCT: "0.3", EXIT_MAX_HOLD_MIN: "90" });
  assert.equal(r.stopLossPct, 0.3);
  assert.equal(r.maxHoldMs, 90 * 60_000);
  assert.equal(r.takeProfitPct, DEFAULT_EXIT_RULES.takeProfitPct); // untouched default
  // Garbage values fall back to the defaults, never to NaN.
  assert.equal(exitRulesFromEnv({ EXIT_STOP_LOSS_PCT: "banana" }).stopLossPct, DEFAULT_EXIT_RULES.stopLossPct);
});

// ---------- buildExitIntents ----------

test("buildExitIntents: mints full-size sell intents with provenance, updates marks, caps fan-out", () => {
  const book = new PositionBook();
  book.restore([
    position({ token: "AAAA1111", entryPriceUsd: 1, peakPriceUsd: 1, lastMarkUsd: 1 }),
    position({ token: "BBBB2222", entryPriceUsd: 1, peakPriceUsd: 1, lastMarkUsd: 1, entryAt: NOW - 10 * 3_600_000 }),
    position({ token: "CCCC3333", entryPriceUsd: 1, peakPriceUsd: 1, lastMarkUsd: 1 }),
    position({ token: "DDDD4444", entryPriceUsd: 1, peakPriceUsd: 1, lastMarkUsd: 1, entryAt: NOW - 20 * 3_600_000 }),
  ]);
  const marks = new Map<string, TokenMark>([
    // AAAA: −50% → stop-loss. BBBB: time exit. CCCC: healthy, holds. DDDD: time exit.
    ["AAAA1111", { priceUsd: 0.5, liquidityUsd: 50_000 }],
    ["BBBB2222", { priceUsd: 1.0, liquidityUsd: 50_000 }],
    ["CCCC3333", { priceUsd: 1.05, liquidityUsd: 50_000 }],
    ["DDDD4444", {}], // no mark — the time exit STILL fires (the rule's whole point)
  ]);

  // Uncapped: AAAA (stop-loss), BBBB (time), DDDD (time, mark-less); CCCC holds.
  const all = buildExitIntents(book, marks, rules({ maxExitsPerTick: 10 }), NOW);
  assert.deepEqual(all.map((i) => i.token), ["AAAA1111", "BBBB2222", "DDDD4444"]);
  assert.ok(all.every((i) => i.side === "sell" && i.confidence === 1 && (i.note?.startsWith("exit: ") ?? false)));
  // Marks were written back into the book even for held positions (the trail advances).
  assert.equal(book.get("solana", "CCCC3333")?.lastMarkUsd, 1.05);

  // Capped at 2: the worst offenders go first (book insertion order).
  const capped = buildExitIntents(book, marks, rules({ maxExitsPerTick: 2 }), NOW);
  assert.deepEqual(capped.map((i) => i.token), ["AAAA1111", "BBBB2222"]);
});

// ---------- PositionBook ----------

test("PositionBook: shadow buy opens a paper position with the intent's entry price", () => {
  const book = new PositionBook();
  const intent = sellIntent({ side: "buy", entryPriceUsd: 0.002, suggestedAmountUsd: 4 });
  const pos = book.openFromFill(intent, shadowSell(4));
  assert.ok(pos);
  assert.equal(pos!.entryUsd, 4);
  assert.equal(pos!.tokenAmount, 4 / 0.002);
  assert.equal(pos!.entryPriceUsd, 0.002);
  assert.equal(pos!.peakPriceUsd, 0.002);
});

test("PositionBook: average-in blends the cost basis and lifts the peak", () => {
  const book = new PositionBook();
  book.openFromFill(sellIntent({ side: "buy", entryPriceUsd: 1, suggestedAmountUsd: 3 }), shadowSell(3));
  book.mark("solana", TOKEN, 2, NOW + 1); // the price doubled → peak 2
  const merged = book.openFromFill(sellIntent({ side: "buy", entryPriceUsd: 3, suggestedAmountUsd: 3 }), shadowSell(3));
  assert.ok(merged);
  assert.equal(merged!.entryUsd, 6);
  assert.equal(merged!.tokenAmount, 4);        // 3/1 + 3/3
  assert.equal(merged!.entryPriceUsd, 1.5);    // 6 USD / 4 tokens
  assert.equal(merged!.peakPriceUsd, 3);       // max(prev peak 2, new mark 3)
});

test("PositionBook: close removes the position and reports realised P&L", () => {
  const book = new PositionBook();
  book.openFromFill(sellIntent({ side: "buy", entryPriceUsd: 1, suggestedAmountUsd: 3 }), shadowSell(3));
  const pnl = book.closeFromFill(sellIntent({ suggestedAmountUsd: 4.5 }), shadowSell(4.5));
  assert.equal(pnl, 1.5);
  assert.equal(book.size, 0);
  // Closing a position that isn't there is honest: null P&L, no state change.
  assert.equal(book.closeFromFill(sellIntent(), shadowSell(1)), null);
});

test("PositionBook: serialize/restore round-trips exactly (the DO-storage persistence path)", () => {
  const book = new PositionBook();
  book.openFromFill(sellIntent({ side: "buy", entryPriceUsd: 0.002, suggestedAmountUsd: 4 }), shadowSell(4));
  book.mark("solana", TOKEN, 0.0026, NOW + 5);

  const book2 = new PositionBook();
  book2.restore(JSON.parse(JSON.stringify(book.serialize()))); // through real JSON, like storage
  assert.equal(book2.size, 1);
  const p = book2.get("solana", TOKEN)!;
  assert.equal(p.entryUsd, 4);
  assert.equal(p.peakPriceUsd, 0.0026);
  assert.equal(p.lastMarkUsd, 0.0026);
});

// ---------- the sell short-circuit in the risk rails ----------

test("risk rails: EXITS ARE NEVER THROTTLED — full-size sells pass exhausted budgets, hot cooldowns and any confidence", () => {
  const portfolio = {
    totalUsd: 100,
    availableUsd: 0,             // even with zero available balance
    positions: [{ token: TOKEN, chain: "solana", amount: "3", valueUsd: 3 }],
    dailyVolumeUsd: 50,          // the daily cap is FULLY spent
    lastTradeAt: { [TOKEN]: NOW - 1000 }, // and the cooldown is hot
  };
  const d = evaluateRisk(
    sellIntent({ confidence: 0.01, suggestedAmountUsd: 3 }), // exits carry confidence 1 in prod; even 0.01 must pass
    portfolio,
    { ...{ maxDailyVolumeUsdc: 50, maxPerTradeUsdc: 5, maxPositionPct: 10, minLiquidityUsd: 10000, maxHolderConcentration: 0.35, tradeCooldownSeconds: 300, minConfidence: 0.45 } },
    NOW,
  );
  assert.ok(d.allow);
  if (d.allow) assert.equal(d.adjustedAmountUsd, 3); // FULL size — never shrunk to a partial stop-loss
});

test("risk rails: degenerate zero-value sells are rejected (nothing to route)", () => {
  const d = evaluateRisk(
    sellIntent({ suggestedAmountUsd: 0 }),
    { totalUsd: 100, availableUsd: 0, positions: [], dailyVolumeUsd: 0, lastTradeAt: {} },
    { maxDailyVolumeUsdc: 50, maxPerTradeUsdc: 5, maxPositionPct: 10, minLiquidityUsd: 10000, maxHolderConcentration: 0.35, tradeCooldownSeconds: 300, minConfidence: 0.45 },
    NOW,
  );
  assert.ok(!d.allow);
  if (!d.allow) assert.match(d.reason, /zero-value sell/);
});

test("risk rails: buys are STILL fully gated (the short-circuit is sell-only)", () => {
  const d = evaluateRisk(
    sellIntent({ side: "buy", confidence: 0.2 }),
    { totalUsd: 100, availableUsd: 0, positions: [], dailyVolumeUsd: 0, lastTradeAt: {} },
    { maxDailyVolumeUsdc: 50, maxPerTradeUsdc: 5, maxPositionPct: 10, minLiquidityUsd: 10000, maxHolderConcentration: 0.35, tradeCooldownSeconds: 300, minConfidence: 0.45 },
    NOW,
  );
  assert.ok(!d.allow);
  if (!d.allow) assert.match(d.reason, /confidence/);
});
