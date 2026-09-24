// execution/shadow.ts — paper-trade records for the shadow path (spec: "只记录，不广播").
//
// Shadow records are the DEPLOYED-DEFAULT output of the execution layer: every intent that passes
// evaluate() while REAL_SPEND is off lands here instead of on a DEX. They live in a bounded
// in-memory ring (newest first) AND, when a D1 binding exists, in the execution_log table (log.ts).
// The ring gives GET /execution/logs something honest to serve in local/keyless dev where no D1 is
// bound — paper results must be visible exactly where real results would appear, or the shadow mode
// teaches the operator nothing.

import type { ExecutionIntent, ExecutionResult } from "./types.js";

/** One shadow (paper) fill. Mirrors the fields a real fill would report, plus the mark price. */
export interface ShadowRecord {
  intentId: string;
  token: string;
  chain: string;
  side: string;
  amountUsd: number;         // the adjusted (risk-shrunk) size that WOULD have been spent
  reason: string;            // why it stayed paper ("REAL_SPEND=false" | "shadow forced")
  createdAt: number;         // unix ms
}

const RING_CAPACITY = 200;
const ring: ShadowRecord[] = [];

/** Record a shadow fill (newest first, bounded). Called by the adapter's shadow path only. */
export function recordShadowFill(rec: ShadowRecord): void {
  ring.unshift(rec);
  if (ring.length > RING_CAPACITY) ring.length = RING_CAPACITY;
}

/** Newest-first view of the recent shadow fills (a copy — callers can't mutate the ring). */
export function recentShadowRecords(limit = 50): ShadowRecord[] {
  return ring.slice(0, Math.max(0, limit));
}

/**
 * Build the paper ExecutionResult the shadow path returns. The deterministic fake hash marks the
 * record AS paper at a glance (it is never a real tx and must never be shown under a real explorer
 * link — the frontend renders shadow rows without a tx link). amountUsd carries the notional in
 * USD (buys: what would have been spent · sells: what the position was marked at) so the
 * PositionBook can keep the ledger honest without re-parsing unit strings.
 */
export function shadowResult(intent: ExecutionIntent, amountUsd: number, reason: string): ExecutionResult {
  return {
    status: "shadow",
    intentId: intent.id,
    amountIn: amountUsd.toFixed(4),
    amountUsd,
    reason,
    timestamp: Date.now(),
  };
}
