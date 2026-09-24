// execution/exits.ts — the sell/stop-loss layer (P2-1, brought forward ahead of schedule).
//
// Buys are gated by eight pure risk rails; this module is the sell-side counterpart: a pure exit
// evaluator over the PositionBook plus the marks feed, and the orchestrator that mints SELL intents
// for state.ts's cron. Design invariants (mirroring the buy side's safety philosophy):
//
//   · EXITS ARE RISK REDUCTION — they are never throttled by the daily budget, per-trade caps,
//     cooldowns or confidence floors (risk.ts short-circuits the sell side before those rails).
//     A stop-loss that only works "while budget remains" is not a stop-loss.
//   · NO MARK → NO PRICE-BASED DECISION — if the marks feed fails, price exits stay silent; the
//     TIME exit (and the RUG exit, which needs only the liquidity field) still fire. Holding is
//     the conservative default; the next cron re-evaluates.
//   · EVERY exit intent carries machine provenance (`note`) so the D1 audit log answers
//     "why did it sell" with the exact rule and the numbers behind it.
//
// Rules (evaluated in priority order, first hit wins):
//   1. STOP_LOSS  — mark ≤ entry × (1 − stopLossPct)             (hard floor, default −20%)
//   2. RUG_EXIT   — pool liquidity collapsed below the floor      (exit while exit liquidity exists)
//   3. TRAILING   — mark ≤ peak × (1 − trailingStopPct)          (protects round-trips; peak-gated)
//   4. TAKE_PROFIT— mark ≥ entry × (1 + takeProfitPct)           (default +50%)
//   5. TIME_EXIT  — held longer than maxHoldMs                   (meme books rot; default 6h)

import type { ExecutionIntent } from "./types.js";
import type { Position, PositionBook } from "./positions.js";
import { fetchDexScreenerPairs } from "../meme/sources-dexscreener.js";
import { toRawAmount } from "./decimals.js";

// ----------------------------- rules -----------------------------

/** The tunable exit rails. Defaults are the meme-book compromises the 二次开发 doc recommends. */
export interface ExitRules {
  stopLossPct: number;        // hard stop, fraction below entry (default 0.20)
  takeProfitPct: number;      // take-profit, fraction above entry (default 0.50)
  trailingStopPct: number;    // trail distance off the peak, fraction (default 0.15)
  maxHoldMs: number;          // time exit (default 6h — meme momentum decays faster than it builds)
  rugLiquidityUsd: number;    // pool liquidity below which an immediate exit fires (default 5000)
  maxExitsPerTick: number;    // cron-level cap (bounds the sell fan-out; default 3)
  slippageBps: number;        // exit slippage cap — wider than buys, meme books are thin (default 300)
  ttlSeconds: number;         // exit intent time-to-live (default 60 — stale exits re-mint next cron)
}

export const DEFAULT_EXIT_RULES: ExitRules = {
  stopLossPct: 0.2,
  takeProfitPct: 0.5,
  trailingStopPct: 0.15,
  maxHoldMs: 6 * 3_600_000,
  rugLiquidityUsd: 5_000,
  maxExitsPerTick: 3,
  slippageBps: 300,
  ttlSeconds: 60,
};

/** Parse the exit rails out of an env-like record, applying the coded defaults. */
export function exitRulesFromEnv(env: Record<string, string | undefined>): ExitRules {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    stopLossPct: num(env.EXIT_STOP_LOSS_PCT, DEFAULT_EXIT_RULES.stopLossPct),
    takeProfitPct: num(env.EXIT_TAKE_PROFIT_PCT, DEFAULT_EXIT_RULES.takeProfitPct),
    trailingStopPct: num(env.EXIT_TRAILING_STOP_PCT, DEFAULT_EXIT_RULES.trailingStopPct),
    maxHoldMs: num(env.EXIT_MAX_HOLD_MIN, DEFAULT_EXIT_RULES.maxHoldMs / 60_000) * 60_000,
    rugLiquidityUsd: num(env.EXIT_RUG_LIQUIDITY_USD, DEFAULT_EXIT_RULES.rugLiquidityUsd),
    maxExitsPerTick: num(env.EXIT_MAX_PER_TICK, DEFAULT_EXIT_RULES.maxExitsPerTick),
    slippageBps: num(env.EXIT_SLIPPAGE_BPS, DEFAULT_EXIT_RULES.slippageBps),
    ttlSeconds: num(env.EXIT_TTL_SECONDS, DEFAULT_EXIT_RULES.ttlSeconds),
  };
}

// ----------------------------- marks -----------------------------

/** The per-token mark the exit rules evaluate against (price for P&L, liquidity for the RUG exit). */
export interface TokenMark {
  priceUsd?: number;
  liquidityUsd?: number;
}

/**
 * Fetch marks for the book's tokens via the keyless DexScreener aggregated-pairs feed (one batched
 * call per ≤30 tokens; the deepest pair per token wins). Fail-soft: any failure → fewer marks, and
 * the exit evaluator treats a missing mark as "no price-based decision this tick".
 */
export async function fetchTokenMarks(
  items: Array<{ token: string; chain: string }>,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<Map<string, TokenMark>> {
  const out = new Map<string, TokenMark>();
  const tokens = [...new Set(items.map((i) => i.token.trim()).filter(Boolean))];
  if (tokens.length === 0) return out;

  // Only pairs whose BASE token is one of ours: the API also returns pairs where a watchlist token
  // is merely the QUOTE side — those belong to other tokens and must not price our book.
  const requested = new Set(tokens.map((t) => t.toLowerCase()));
  const pairs = (await fetchDexScreenerPairs(tokens, fetchImpl)).filter((p) =>
    requested.has(p.token.toLowerCase()),
  );
  // Deepest pair per token wins (same rule the provider uses for observations).
  for (const p of pairs) {
    const prev = out.get(p.token);
    if (prev != null && (prev.liquidityUsd ?? 0) >= (p.liquidityUsd ?? 0)) continue;
    out.set(p.token, { priceUsd: p.priceUsd ?? undefined, liquidityUsd: p.liquidityUsd ?? undefined });
  }
  return out;
}

// ----------------------------- pure evaluator -----------------------------

export type ExitDecision = { exit: true; reason: string } | { exit: false; reason?: string };

/**
 * Evaluate ONE position against the exit rails. PURE: explicit `now`, explicit marks — the exact
 * function unit tests exercise is the one production runs. Priority: STOP_LOSS > RUG > TRAILING >
 * TAKE_PROFIT > TIME. Positions without a known entry price or mark only get the TIME exit (and
 * the RUG exit, which is liquidity-driven, not price-driven).
 */
export function evaluateExit(
  p: Position,
  rules: ExitRules,
  now: number,
  mark: TokenMark = {},
): ExitDecision {
  const price = mark.priceUsd ?? p.lastMarkUsd;
  const priced = price > 0 && p.entryPriceUsd > 0;

  // 1. Hard stop — the non-negotiable floor.
  if (priced && price <= p.entryPriceUsd * (1 - rules.stopLossPct)) {
    const drop = ((price / p.entryPriceUsd - 1) * 100).toFixed(1);
    return { exit: true, reason: `stop-loss ${drop}%` };
  }

  // 2. Rug exit — liquidity collapsed. Fires regardless of P&L: the window to leave at all is
  //    closing, and a -10% sale beats a -100% rug.
  const liq = mark.liquidityUsd;
  if (liq != null && liq < rules.rugLiquidityUsd) {
    return { exit: true, reason: `rug-risk liquidity $${Math.round(liq)}` };
  }

  // 3. Trailing stop — only meaningful once the trade has been ABOVE water (peak ≥ entry); while
  //    under water the hard stop owns the downside. Protects the classic meme round-trip
  //    (+80% → −0% → −40%) by locking in from the peak.
  if (priced && p.peakPriceUsd >= p.entryPriceUsd && price <= p.peakPriceUsd * (1 - rules.trailingStopPct)) {
    const off = ((price / p.peakPriceUsd - 1) * 100).toFixed(1);
    return { exit: true, reason: `trailing-stop ${off}% off peak` };
  }

  // 4. Take profit — banks the move before the crowd finds the exit.
  if (priced && price >= p.entryPriceUsd * (1 + rules.takeProfitPct)) {
    const gain = ((price / p.entryPriceUsd - 1) * 100).toFixed(1);
    return { exit: true, reason: `take-profit +${gain}%` };
  }

  // 5. Time exit — works even without marks: an aged meme position is a decaying option.
  if (now - p.entryAt >= rules.maxHoldMs) {
    const hours = ((now - p.entryAt) / 3_600_000).toFixed(1);
    return { exit: true, reason: `time-exit ${hours}h held` };
  }

  return { exit: false };
}

// ----------------------------- sell-intent builder -----------------------------

/**
 * Mint the SELL intents for this cron: refresh marks over the open book, evaluate every position,
 * cap the fan-out at maxExitsPerTick. Book marks are updated in passing (the book is the caller's)
 * so the trailing stop's high-water mark advances even on ticks that mint no exits.
 *
 * P0-3: `decimals` (token → verified decimals, resolved by the caller/state.ts via
 * execution/decimals.ts) lets every exit intent carry the EXACT raw sell amount —
 * PositionBook tokenAmount × 10^decimals — so the adapter never has to size from a USD notional.
 * Tokens without verified decimals mint an intent WITHOUT sellTokenAmount: the adapter's hard gate
 * then decides (live ⇒ block with the P0-3 reason; shadow ⇒ unaffected), never a silent guess.
 */
export function buildExitIntents(
  book: PositionBook,
  marks: Map<string, TokenMark>,
  rules: ExitRules,
  now: number = Date.now(),
  decimals?: Map<string, number>,
): ExecutionIntent[] {
  const intents: ExecutionIntent[] = [];
  for (const p of book.all()) {
    if (intents.length >= rules.maxExitsPerTick) break;
    const mark = marks.get(p.token) ?? {};
    book.mark(p.chain, p.token, mark.priceUsd, now);

    const decision = evaluateExit(book.get(p.chain, p.token) as Position, rules, now, mark);
    if (!decision.exit) continue;

    const pos = book.get(p.chain, p.token) as Position;
    const valueUsd = priceValueOf(pos, mark);
    const dec = decimals?.get(p.token);
    const sellTokenAmount =
      dec != null && pos.tokenAmount > 0 ? toRawAmount(pos.tokenAmount, dec) : undefined;
    intents.push({
      id: `ext-${now}-exit-${p.token.slice(0, 6)}`,
      token: p.token,
      chain: p.chain,
      side: "sell",
      strength: 1,
      confidence: 1, // exits are risk reduction; risk.ts never judges them on confidence
      maxSlippageBps: rules.slippageBps,
      deadline: Math.floor(now / 1000) + rules.ttlSeconds,
      sourceFlyIds: [],
      suggestedAmountUsd: valueUsd,
      sellTokenAmount, // P0-3: exact raw units when decimals are verified; absent ⇒ adapter gate decides
      note:
        `exit: ${decision.reason}` +
        (sellTokenAmount != null ? ` · raw=${sellTokenAmount} (dec=${dec})` : " · decimals unverified"),
    });
  }
  return intents;
}

/** Mark-to-market value of a position, falling back to the cost basis when never priced. */
function priceValueOf(p: Position, mark: TokenMark): number {
  const price = mark.priceUsd ?? p.lastMarkUsd;
  if (price > 0 && p.tokenAmount > 0) return price * p.tokenAmount;
  return p.entryUsd; // never-priced position: sell for what we put in (the best estimate there is)
}
