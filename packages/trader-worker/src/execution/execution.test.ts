// Execution-layer tests — the risk rails and the shadow-first contract.
//
// The 二次开发 spec asks for the pure rule set to be "可单独测试" and for the adapter to shadow-first.
// These tests turn both requirements into enforced contracts, entirely offline: no network, no keys,
// no D1 (writeExecutionLog no-ops without a binding), no clock surprises (the rules take an explicit
// `now`). The one-directional-read-out philosophy extends here: nothing in the execution layer can
// mutate the neural layer, and with the shipped flags nothing here can move money either —
// `execute()` MUST return status "shadow" whenever EXECUTION_REAL_SPEND is not "true".

import test from "node:test";
import assert from "node:assert/strict";

import { ExecutionAdapter } from "./adapter.js";
import { evaluateRisk, riskRulesFromEnv, DEFAULT_RISK_RULES } from "./risk.js";
import { buildExternalIntents } from "./intents.js";
import { recordShadowFill, recentShadowRecords, shadowResult } from "./shadow.js";
import type { ExecutionIntent, PortfolioSnapshot } from "./types.js";
import type { FlyReading } from "../population.js";
import type { MemeSnapshot } from "../meme/types.js";

// ---------- fixtures ----------

const NOW = 1_800_000_000_000; // fixed wall clock — the rules are deterministic against it

function env(over: Record<string, string> = {}): Record<string, string> {
  return {
    MEME_ENABLED: "true",
    EXECUTION_ENABLED: "true",
    EXECUTION_REAL_SPEND: "false",
    EXECUTION_SHADOW: "true",
    MAX_DAILY_VOLUME_USDC: "50",
    MAX_PER_TRADE_USDC: "5",
    MAX_POSITION_PCT: "10",
    MIN_LIQUIDITY_USD: "10000",
    MAX_HOLDER_CONCENTRATION: "0.35",
    TRADE_COOLDOWN_SECONDS: "300",
    MIN_CONFIDENCE: "0.45",
    MAX_SLIPPAGE_BPS: "150",
    ...over,
  };
}

function intent(over: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    id: "test-intent-001",
    token: "So11111111111111111111111111111111111111112",
    chain: "solana",
    side: "buy",
    strength: 0.8,
    confidence: 0.7,
    maxSlippageBps: 100,
    deadline: Math.floor(NOW / 1000) + 60,
    sourceFlyIds: [1],
    suggestedAmountUsd: 3,
    ...over,
  };
}

function portfolio(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    totalUsd: 100,
    availableUsd: 80,
    positions: [],
    dailyVolumeUsd: 10,
    lastTradeAt: {},
    ...over,
  };
}

// ---------- pure risk rules ----------

test("risk rules: a valid intent under the limits is allowed and shrunk-to-fit", () => {
  const d = evaluateRisk(intent(), portfolio(), DEFAULT_RISK_RULES, NOW);
  assert.ok(d.allow);
  if (d.allow) {
    assert.ok(d.adjustedAmountUsd <= 5);                       // never grows past the per-trade cap
    assert.ok(d.adjustedAmountUsd > 0);
  }
});

test("risk rules: daily volume cap rejects", () => {
  const d = evaluateRisk(intent(), portfolio({ dailyVolumeUsd: 60 }), DEFAULT_RISK_RULES, NOW);
  assert.ok(!d.allow);
  if (!d.allow) assert.match(d.reason, /daily volume cap/);
});

test("risk rules: remaining daily budget shrinks the size instead of rejecting a small trade", () => {
  // cap 50, spent 48 ⇒ only 2 left; the suggested 3 must shrink to 2, not reject.
  const d = evaluateRisk(intent(), portfolio({ dailyVolumeUsd: 48 }), DEFAULT_RISK_RULES, NOW);
  assert.ok(d.allow);
  if (d.allow) assert.ok(Math.abs(d.adjustedAmountUsd - 2) < 1e-9);
});

test("risk rules: low confidence rejects", () => {
  const d = evaluateRisk(intent({ confidence: 0.2 }), portfolio(), DEFAULT_RISK_RULES, NOW);
  assert.ok(!d.allow);
  if (!d.allow) assert.match(d.reason, /confidence/);
});

test("risk rules: cooldown rejects a same-token rebuy inside the window", () => {
  const p = portfolio({ lastTradeAt: { [intent().token]: NOW - 10_000 } });
  const d = evaluateRisk(intent(), p, DEFAULT_RISK_RULES, NOW);
  assert.ok(!d.allow);
  if (!d.allow) assert.match(d.reason, /cooldown/);
});

test("risk rules: position ceiling rejects when one token would dominate the portfolio", () => {
  // cap 10% of 100 = 10; existing 8 + new 3 = 11 > 10 ⇒ reject.
  const p = portfolio({ positions: [{ token: intent().token, chain: "solana", amount: "8", valueUsd: 8 }] });
  const d = evaluateRisk(intent(), p, DEFAULT_RISK_RULES, NOW);
  assert.ok(!d.allow);
  if (!d.allow) assert.match(d.reason, /position %/);
});

test("risk rules: pool-quality gates — thin liquidity and whale concentration reject", () => {
  const thin = evaluateRisk(intent({ liquidityUsd: 500 }), portfolio(), DEFAULT_RISK_RULES, NOW);
  assert.ok(!thin.allow);
  if (!thin.allow) assert.match(thin.reason, /liquidity/);

  const whales = evaluateRisk(intent({ holderConcentration: 0.6 }), portfolio(), DEFAULT_RISK_RULES, NOW);
  assert.ok(!whales.allow);
  if (!whales.allow) assert.match(whales.reason, /concentration/);
});

test("risk rules: expired deadline rejects", () => {
  const d = evaluateRisk(intent({ deadline: Math.floor(NOW / 1000) - 1 }), portfolio(), DEFAULT_RISK_RULES, NOW);
  assert.ok(!d.allow);
  if (!d.allow) assert.match(d.reason, /deadline/);
});

test("risk rules: env parsing applies coded defaults for absent vars", () => {
  const r = riskRulesFromEnv({});
  assert.equal(r.maxPerTradeUsdc, 5);
  assert.equal(r.minConfidence, 0.45);
  assert.equal(r.maxHolderConcentration, 0.35);
  const tuned = riskRulesFromEnv({ MAX_PER_TRADE_USDC: "1", TRADE_COOLDOWN_SECONDS: "60" });
  assert.equal(tuned.maxPerTradeUsdc, 1);
  assert.equal(tuned.tradeCooldownSeconds, 60);
});

// ---------- the adapter: shadow-first contract ----------

test("adapter: with REAL_SPEND=false every accepted intent is a SHADOW paper fill", async () => {
  const a = new ExecutionAdapter(env() as any);
  const r = await a.execute(intent({ id: "shadow-check-1", token: "TokenShadowCheck1" }));
  assert.equal(r.status, "shadow");
  assert.equal(r.intentId, "shadow-check-1");
  assert.match(r.reason ?? "", /REAL_SPEND|shadow/i);
});

test("adapter: a rule-violating intent is REJECTED with the rule's reason", async () => {
  const a = new ExecutionAdapter(env() as any);
  const r = await a.execute(intent({ id: "reject-check-1", token: "TokenRejectCheck1", confidence: 0.1 }));
  assert.equal(r.status, "rejected");
  assert.match(r.reason ?? "", /confidence/);
});

test("adapter: EXECUTION_ENABLED=false rejects everything at the gate", async () => {
  const a = new ExecutionAdapter(env({ EXECUTION_ENABLED: "false" }) as any);
  const r = await a.execute(intent({ id: "disabled-check-1", token: "TokenDisabledCheck1" }));
  assert.equal(r.status, "rejected");
  assert.match(r.reason ?? "", /EXECUTION_ENABLED/);
});

// ---------- the intent builder: neural read-out → external intents ----------

function reading(id: number, state: FlyReading["state"], arousal: number): FlyReading {
  return {
    id, state, arousal, turnBias: 0.2, cohesion: 0.5, wingbeat: 0.7, rest: 0.05,
    temperament: 0.5, fingerprint: `fp${id}`,
  };
}

function meme(over: Partial<MemeSnapshot> = {}): MemeSnapshot {
  return {
    overallHeat: 0.8,
    regime: "PUMP",
    topSignals: [{
      token: "MemeTokenMemeToken",
      chain: "solana",
      score: 0.9,
      reasons: ["volumeSpike 80%"],
      liquidityUsd: 50_000,
      holderConcentration: 0.2,
    }],
    raw: { launchHeat: 0.7, volumeSpike: 0.8, smartMoneyFlow: 0.6, socialMomentum: 0.4, liquidityHealth: 0.9 },
    ...over,
  };
}

test("intents: disabled flags ⇒ zero intents (the shipped default is a no-op)", () => {
  const envOff = env({ EXECUTION_ENABLED: "false" }) as any;
  assert.deepEqual(buildExternalIntents([reading(0, "AGITATE", 0.9)], meme(), envOff), []);
  assert.deepEqual(buildExternalIntents([reading(0, "AGITATE", 0.9)], meme(), env({ MEME_ENABLED: "false" }) as any), []);
});

test("intents: RUG_RISK ⇒ zero intents, no matter how hot the swarm is", () => {
  const i = buildExternalIntents(
    [reading(0, "AGITATE", 0.95), reading(1, "EXPLORE", 0.9)],
    meme({ regime: "RUG_RISK" }),
    env() as any,
  );
  assert.deepEqual(i, []);
});

test("intents: top-arousal EXPLORE/AGITATE flies vote; confidence blends signal × arousal", () => {
  const flies = [
    reading(0, "AGITATE", 0.95),
    reading(1, "EXPLORE", 0.9),
    reading(2, "REST", 0.99),      // REST never votes
    reading(3, "AGGREGATE", 0.98), // AGGREGATE never votes
  ];
  const i = buildExternalIntents(flies, meme(), env() as any);
  assert.equal(i.length, 1);
  const it = i[0];
  assert.equal(it.side, "buy");
  assert.equal(it.token, "MemeTokenMemeToken");
  assert.deepEqual(it.sourceFlyIds, [0, 1]);          // the two eligible voters, arousal-ranked
  const expected = Math.min(0.95, 0.9 * 0.7 + (0.95 + 0.9) / 2 * 0.3);
  assert.ok(Math.abs(it.confidence - expected) < 1e-9);
  assert.equal(it.holderConcentration, 0.2);          // signal metadata rides along for the risk gates
  assert.equal(it.liquidityUsd, 50_000);
  assert.ok(it.suggestedAmountUsd! > 0);
});

test("intents: sub-threshold confidence never mints an intent", () => {
  const i = buildExternalIntents(
    [reading(0, "EXPLORE", 0.1)],   // arousal 0.1 ⇒ confidence ≈ 0.9*0.7 + 0.03 = 0.66? no: score*0.7=0.63, +0.03 = 0.66 — still above
    meme({ topSignals: [meme().topSignals[0]] }),
    env({ MIN_CONFIDENCE: "0.9" }) as any,
  );
  assert.deepEqual(i, []);
});

// ---------- the shadow ring ----------

test("shadow ring: newest-first, bounded, and shapes paper results", () => {
  const before = recentShadowRecords(1000).length;
  const it = intent({ id: "ring-check-1" });
  recordShadowFill({
    intentId: it.id, token: it.token, chain: it.chain, side: it.side,
    amountUsd: 1.5, reason: "REAL_SPEND=false", createdAt: NOW,
  });
  const ring = recentShadowRecords(1);
  assert.equal(ring.length, 1);
  assert.equal(ring[0].intentId, "ring-check-1");
  assert.equal(ring[0].amountUsd, 1.5);
  assert.ok(recentShadowRecords(1000).length === before + 1);

  const paper = shadowResult(it, 1.5, "REAL_SPEND=false");
  assert.equal(paper.status, "shadow");
  assert.equal(paper.amountIn, "1.5000");
});
