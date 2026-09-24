// execution/risk.ts — the PURE risk-rule set for the external execution layer (spec §3: "可单独测试").
//
// Every rule from the spec's safety-constraint table lives here as a pure function of
// (intent, portfolio, rules) — no I/O, no clock dependence beyond the explicit `now` argument, no
// env reads. The adapter delegates ALL evaluation to evaluateRisk(), so unit tests exercise the
// exact code path production uses. Rule order matters: cheapest, most-global checks first so a
// rejected intent costs nothing.

import type { ExecutionIntent, PortfolioSnapshot, RiskDecision } from "./types.js";

/** The tunable rails. Defaults mirror the spec's "推荐默认配置（生产前）". */
export interface RiskRules {
  maxDailyVolumeUsdc: number;       // global daily spend ceiling (spec default 50)
  maxPerTradeUsdc: number;          // per-trade ceiling (spec default 5)
  maxPositionPct: number;           // max % of total portfolio per single token (spec default 10)
  minLiquidityUsd: number;          // min pool liquidity for a buy (spec default 10000)
  maxHolderConcentration: number;   // top-10 holder share ceiling (spec default 0.35)
  tradeCooldownSeconds: number;     // per-token cooldown (spec default 300)
  minConfidence: number;            // minimum intent confidence (spec default 0.45)
}

export const DEFAULT_RISK_RULES: RiskRules = {
  maxDailyVolumeUsdc: 50,
  maxPerTradeUsdc: 5,
  maxPositionPct: 10,
  minLiquidityUsd: 10_000,
  maxHolderConcentration: 0.35,
  tradeCooldownSeconds: 300,
  minConfidence: 0.45,
};

/** Parse the risk rails out of an env-like record (wrangler vars), applying the coded defaults. */
export function riskRulesFromEnv(env: Record<string, string | undefined>): RiskRules {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    maxDailyVolumeUsdc: num(env.MAX_DAILY_VOLUME_USDC, DEFAULT_RISK_RULES.maxDailyVolumeUsdc),
    maxPerTradeUsdc: num(env.MAX_PER_TRADE_USDC, DEFAULT_RISK_RULES.maxPerTradeUsdc),
    maxPositionPct: num(env.MAX_POSITION_PCT, DEFAULT_RISK_RULES.maxPositionPct),
    minLiquidityUsd: num(env.MIN_LIQUIDITY_USD, DEFAULT_RISK_RULES.minLiquidityUsd),
    maxHolderConcentration: num(env.MAX_HOLDER_CONCENTRATION, DEFAULT_RISK_RULES.maxHolderConcentration),
    tradeCooldownSeconds: num(env.TRADE_COOLDOWN_SECONDS, DEFAULT_RISK_RULES.tradeCooldownSeconds),
    minConfidence: num(env.MIN_CONFIDENCE, DEFAULT_RISK_RULES.minConfidence),
  };
}

/**
 * Evaluate one intent against the full rule set. Pure: the ONLY wall-clock use is the explicit
 * `now` argument (injected by the adapter), so cooldown behaviour is deterministic in tests.
 *
 * Rules, in order:
 *   0. intent sanity        — deadline in the future, bounds-correct fields (both sides)
 *   0b. SELL short-circuit  — exits are risk reduction: never judged on confidence, budget,
 *                             size caps or cooldown (a throttled stop-loss is not a stop-loss)
 *   1. confidence floor     — the swarm must mean it (buys)
 *   2. daily volume cap     — global budget (buys)
 *   3. per-trade cap        — size shrunk to fit, never grown (buys)
 *   4. position ceiling     — one token can't dominate the portfolio (buys)
 *   5. cooldown             — same-token churn throttle (buys)
 *   6. liquidity + holder   — pool-quality gates (signal-carried metadata, buys)
 *   7. available balance    — the money must actually be there (buys)
 */
export function evaluateRisk(
  intent: ExecutionIntent,
  portfolio: PortfolioSnapshot,
  rules: RiskRules,
  now: number = Date.now(),
): RiskDecision {
  // 0. Sanity: a malformed intent must never squeeze past on a technicality (both sides).
  if (!intent.token || intent.strength < 0 || intent.strength > 1 || intent.confidence < 0) {
    return { allow: false, reason: "malformed intent" };
  }
  if (intent.deadline > 0 && intent.deadline * 1000 < now) {
    return { allow: false, reason: "intent deadline expired" };
  }

  // 0b. SELL short-circuit (P2-1): the full position value passes at full size. Reducing exposure
  //     can never violate the daily budget (sells REDUCE risk, they don't spend), never waits out a
  //     cooldown, and is never shrunk to a partial exit — cutting a stop-loss in half because the
  //     daily cap is spent would be the worst possible behaviour in exactly the scenario that
  //     matters. The empty-sell guard keeps a degenerate zero-value intent out of the routers.
  if (intent.side === "sell") {
    const amount = intent.suggestedAmountUsd ?? 0;
    if (!(amount > 0)) return { allow: false, reason: "zero-value sell" };
    return { allow: true, adjustedAmountUsd: amount };
  }

  // 1. Confidence floor — the neural read-out must clear the bar (spec: 0.45).
  if (intent.confidence < rules.minConfidence) {
    return { allow: false, reason: "confidence too low" };
  }

  // 2. Daily volume cap.
  if (portfolio.dailyVolumeUsd >= rules.maxDailyVolumeUsdc) {
    return { allow: false, reason: `daily volume cap ${rules.maxDailyVolumeUsdc} reached` };
  }

  // 3. Per-trade cap: suggested size is SHRUNK to fit, never grown (spec behaviour).
  let amount = intent.suggestedAmountUsd ?? rules.maxPerTradeUsdc * intent.strength;
  amount = Math.min(amount, rules.maxPerTradeUsdc);
  amount = Math.min(amount, rules.maxDailyVolumeUsdc - portfolio.dailyVolumeUsd);
  if (amount <= 0) {
    return { allow: false, reason: "no remaining daily budget" };
  }

  // 4. Position ceiling (buys only): (existing + new) / total must stay under the % cap.
  if (intent.side === "buy") {
    const maxPosFrac = rules.maxPositionPct / 100;
    const currentPos = portfolio.positions.find((p) => p.token === intent.token);
    const currentValue = currentPos?.valueUsd ?? 0;
    if (portfolio.totalUsd > 0 && (currentValue + amount) / portfolio.totalUsd > maxPosFrac) {
      return { allow: false, reason: "max position % exceeded" };
    }

    // 5. Per-token cooldown (buys only — selling out of a position must never be throttled).
    const cooldownMs = rules.tradeCooldownSeconds * 1000;
    const last = portfolio.lastTradeAt[intent.token] ?? 0;
    if (now - last < cooldownMs) {
      return { allow: false, reason: "cooldown active" };
    }

    // 6. Pool-quality gates, carried on the intent by the signal that produced it.
    const liquidity = intent.liquidityUsd;
    if (liquidity != null && liquidity < rules.minLiquidityUsd) {
      return { allow: false, reason: `liquidity below ${rules.minLiquidityUsd} USD` };
    }
    const concentration = intent.holderConcentration;
    if (concentration != null && concentration > rules.maxHolderConcentration) {
      return { allow: false, reason: "holder concentration above limit" };
    }

    // 7. Available balance.
    if (amount > portfolio.availableUsd) {
      return { allow: false, reason: "insufficient available balance" };
    }
  }


  return { allow: true, adjustedAmountUsd: amount };
}
