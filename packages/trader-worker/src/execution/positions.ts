// execution/positions.ts — the position ledger for the sell/exit layer (P2-1, brought forward).
//
// Buys alone are half a strategy: without a ledger of WHAT we hold, at WHAT cost basis, and HOW it
// has moved since entry, no stop-loss can be evaluated. This module is that ledger — deliberately
// dumb, deliberately pure-ish (no I/O of its own), and shadow-compatible: paper fills open paper
// positions exactly like real fills would, so the 24–48h shadow run per §9 exercises the SAME
// accounting code a live deployment would trust.
//
// Persistence: the book is plain JSON-serialisable state; state.ts snapshots it into the DO's
// transactional storage (KEY_POSITIONS) after each cron and restores it on wake. That survives DO
// restarts mid-shadow (deploys, isolate eviction) which would otherwise silently zero the books.
// (D1 aggregation for the daily budget stays P0-6's concern — different data, different store.)
//
// Semantics (v1):
//   · buys average into an existing position (weighted cost basis; peak resets to the blended mark)
//   · exits always close the FULL remaining position (partial scale-outs are a documented v3 idea)
//   · peakPriceUsd is the high-water mark since entry — the trailing stop's reference
//   · a position with entryPriceUsd = 0 (no mark at entry) still tracks cost + holding time; the
//     price-based exit rules skip it but TIME and RUG exits stay fully functional

import type { ExecChain, ExecutionIntent, ExecutionResult } from "./types.js";

/** One open position (JSON-serialisable — this exact shape goes into DO storage). */
export interface Position {
  token: string;
  chain: ExecChain;
  entryAt: number;           // unix ms of the FIRST entry (the clock the time-exit runs on)
  entryUsd: number;          // total cost basis (buys accumulated, USD)
  entryPriceUsd: number;     // weighted average entry price (0 = unknown — no mark at entry time)
  tokenAmount: number;       // decimal token units held (cost ÷ entry price; 0 while price unknown)
  peakPriceUsd: number;      // high-water mark since entry (trailing-stop reference; 0 until marked)
  lastMarkUsd: number;       // most recent mark price (0 until marked)
  updatedAt: number;         // unix ms of the last mutation (observability)
}

const key = (chain: string, token: string): string => `${chain}:${token}`;

export class PositionBook {
  private map = new Map<string, Position>();

  /**
   * Record a fill. Buys with a known entry price accumulate amount + weighted basis; buys without
   * one still open/accumulate the cost basis (amount stays 0 → price-based exits stay dormant).
   * Returns the mutated position (or null when the fill wasn't an executed/shadow buy).
   */
  openFromFill(intent: ExecutionIntent, result: ExecutionResult): Position | null {
    if (intent.side !== "buy") return null;
    if (result.status !== "executed" && result.status !== "shadow") return null;
    const spentUsd = this.usdOf(intent, result);
    if (!(spentUsd > 0)) return null;

    const k = key(intent.chain, intent.token);
    const now = result.timestamp;
    const prev = this.map.get(k);
    const price = intent.entryPriceUsd && intent.entryPriceUsd > 0 ? intent.entryPriceUsd : 0;

    if (!prev) {
      const amount = price > 0 ? spentUsd / price : 0;
      const pos: Position = {
        token: intent.token,
        chain: intent.chain,
        entryAt: now,
        entryUsd: spentUsd,
        entryPriceUsd: price,
        tokenAmount: amount,
        peakPriceUsd: price,
        lastMarkUsd: price,
        updatedAt: now,
      };
      this.map.set(k, pos);
      return pos;
    }

    // Average in: weighted basis + amount grow together when the new price is known; a 0-price buy
    // adds cost but no amount (the average stays the previous best estimate).
    const entryUsd = prev.entryUsd + spentUsd;
    const amount = prev.tokenAmount + (price > 0 ? spentUsd / price : 0);
    const entryPriceUsd = price > 0 && amount > 0 ? entryUsd / amount : prev.entryPriceUsd;
    const merged: Position = {
      ...prev,
      entryUsd,
      tokenAmount: amount,
      entryPriceUsd,
      // The high-water mark blends the pre-existing peak with the new mark — a DCA into a higher
      // price lifts the trail's anchor to the new mark (never backwards).
      peakPriceUsd: Math.max(prev.peakPriceUsd, price, prev.lastMarkUsd),
      lastMarkUsd: Math.max(prev.lastMarkUsd, price),
      updatedAt: now,
    };
    this.map.set(k, merged);
    return merged;
  }

  /** Record an exit fill: removes the position and returns the realised P&L in USD (null = unknown). */
  closeFromFill(intent: ExecutionIntent, result: ExecutionResult): number | null {
    if (intent.side !== "sell") return null;
    if (result.status !== "executed" && result.status !== "shadow") return null;
    const k = key(intent.chain, intent.token);
    const pos = this.map.get(k);
    if (!pos) return null;
    this.map.delete(k);
    const proceeds = this.usdOf(intent, result);
    return proceeds > 0 ? proceeds - pos.entryUsd : null;
  }

  /** Update the mark + high-water mark for one position (no-op when unknown). */
  mark(chain: ExecChain, token: string, priceUsd: number | undefined, now: number): void {
    if (priceUsd == null || !(priceUsd > 0)) return;
    const pos = this.map.get(key(chain, token));
    if (!pos) return;
    pos.lastMarkUsd = priceUsd;
    pos.peakPriceUsd = Math.max(pos.peakPriceUsd, priceUsd);
    pos.updatedAt = now;
  }

  get(chain: string, token: string): Position | undefined {
    return this.map.get(key(chain, token));
  }

  all(): Position[] {
    return [...this.map.values()];
  }

  get size(): number {
    return this.map.size;
  }

  /** Restore a persisted snapshot (the exact array serialize() produced). */
  restore(positions: Position[]): void {
    for (const p of positions) {
      if (p && typeof p.token === "string" && typeof p.chain === "string") {
        this.map.set(key(p.chain, p.token), p);
      }
    }
  }

  /** JSON-serialisable snapshot (DO storage / logging). */
  serialize(): Position[] {
    return this.all();
  }

  /**
   * The USD notional of a fill from the result record. The adapter + shadow path both set
   * result.amountUsd explicitly; the fallbacks keep older-shaped records honest:
   * shadow rows carry amountIn as a USD string, executed buys carry raw USDC (6 decimals).
   */
  private usdOf(intent: ExecutionIntent, result: ExecutionResult): number {
    if (result.amountUsd != null && Number.isFinite(result.amountUsd)) return result.amountUsd;
    if (result.status === "shadow" && result.amountIn != null) {
      const n = Number(result.amountIn);
      if (Number.isFinite(n)) return n;
    }
    if (result.status === "executed" && result.amountIn != null) {
      const n = Number(result.amountIn);
      if (Number.isFinite(n) && n > 1000) return n / 1_000_000; // raw USDC units heuristic
    }
    return intent.side === "buy" ? intent.suggestedAmountUsd ?? 0 : 0;
  }
}
