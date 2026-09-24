// execution/intents.ts — the decision → execution bridge (spec §1 of the "economy 接入 Intent" block).
//
// The doc's diff placed buildExternalIntents() on AgentEconomy; this port keeps the LOGIC identical
// but hosts it in execution/ instead, honouring the doc's own 改动原则: "所有真实资金相关逻辑全部集
// 中在 execution/，原有 economy 继续只做内部结算" — economy.ts stays byte-for-byte untouched. The
// data it needs (per-fly arousal + behaviour) already arrives in the tick's FlyReading[], so no
// Population changes are required either (the doc's getAllDrives/getAllBehaviors shim is unnecessary
// in this codebase — see state.ts's call site).
//
// Strategy (v1, from the doc): the top-3 most aroused EXPLORE/AGITATE flies vote on the top-2 meme
// signals; each (signal × quorum) pair mints ONE buy intent whose confidence blends the signal's
// risk-discounted score with the voters' mean arousal. Sub-0.45-confidence pairs are dropped. Sell
// logic is a documented v2 extension.

import type { Env } from "../config.js";
import type { FlyReading } from "../population.js";
import type { MemeSnapshot } from "../meme/types.js";
import type { ExecutionIntent } from "./types.js";

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface IntentBuildOptions {
  /** Max signals to trade per cron (spec: top 2). */
  maxSignals?: number;
  /** Max voting flies considered (spec: top 3 by arousal). */
  quorumSize?: number;
  /** Confidence under which an intent is not even minted (mirrors the risk gate). */
  minConfidence?: number;
  /** Slippage cap handed to the router (spec default 150 bps = 1.5%). */
  maxSlippageBps?: number;
  /** Intent time-to-live, seconds (spec default 90). */
  ttlSeconds?: number;
}

/**
 * Build the external buy intents for this tick. Returns [] unless BOTH the meme channel and the
 * execution layer are enabled (MEME_ENABLED + EXECUTION_ENABLED) — with the shipped defaults this
 * function is a pure no-op, which is what makes the integration safe to merge.
 */
export function buildExternalIntents(
  readings: FlyReading[],
  meme: MemeSnapshot | null,
  env: Env,
  opts: IntentBuildOptions = {},
): ExecutionIntent[] {
  if (env.MEME_ENABLED !== "true" || env.EXECUTION_ENABLED !== "true") return [];
  if (!meme || meme.regime === "RUG_RISK") return []; // rug risk ⇒ no new buys, ever

  const topSignals = meme.topSignals ?? [];
  if (topSignals.length === 0) return [];

  const maxSignals = opts.maxSignals ?? 2;
  const quorumSize = opts.quorumSize ?? 3;
  const minConfidence = opts.minConfidence ?? Number(env.MIN_CONFIDENCE ?? "0.45");
  const maxSlippageBps = opts.maxSlippageBps ?? Number(env.MAX_SLIPPAGE_BPS ?? "150");
  const ttlSeconds = opts.ttlSeconds ?? 90;
  const maxPerTrade = Number(env.MAX_PER_TRADE_USDC ?? "5");

  // The voters: the most aroused flies that are EXPLORING or AGITATING (spec's candidate rule).
  const candidates = readings
    .filter((r) => r.state === "EXPLORE" || r.state === "AGITATE")
    .sort((a, b) => b.arousal - a.arousal)
    .slice(0, quorumSize);
  if (candidates.length === 0) return [];

  const avgArousal = candidates.reduce((s, f) => s + f.arousal, 0) / candidates.length;

  const intents: ExecutionIntent[] = [];
  for (const signal of topSignals.slice(0, maxSignals)) {
    // Spec's blend: signal quality dominates (0.7), neural heat seasons it (0.3), capped at 0.95 so
    // no single tick ever claims certainty.
    const confidence = Math.min(0.95, signal.score * 0.7 + avgArousal * 0.3);
    if (confidence < minConfidence) continue;

    intents.push({
      id: `ext-${Date.now()}-${signal.token.slice(0, 6)}`,
      token: signal.token,
      chain: signal.chain,
      side: "buy", // v1: buys only; sell/exit logic is the documented v2 extension
      strength: clamp01(avgArousal),
      confidence,
      maxSlippageBps,
      deadline: Math.floor(Date.now() / 1000) + ttlSeconds,
      sourceFlyIds: candidates.map((f) => f.id),
      suggestedAmountUsd: maxPerTrade * avgArousal,
      liquidityUsd: signal.liquidityUsd,
      holderConcentration: signal.holderConcentration,
      entryPriceUsd: signal.priceUsd, // the PositionBook's cost-basis reference (P2-1 exit layer)
    });
  }
  return intents;
}
