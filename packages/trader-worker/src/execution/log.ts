// execution/log.ts — D1 persistence for the execution layer (spec §4: "可审计：每次 evaluate +
// execute 完整日志写入 D1").
//
// EVERY terminal status (executed | shadow | rejected | failed) is written — rejections especially,
// because "why didn't it trade" is the question that matters when tuning the swarm's decision
// quality. Writes are strictly best-effort: a missing binding (local dev) or a D1 hiccup logs a
// warning and moves on, never blocking the live tick (same philosophy as archiveTick in state.ts).

import type { ExecutionIntent, ExecutionResult } from "./types.js";
import type { Env } from "../config.js";
import type { RiskDecision } from "./types.js";

/**
 * The execution_log schema — also mirrored in schema.sql and lazily created by state.ts's
 * ensureD1Schema, so a fresh deployment works without a manual migration step.
 */
export const EXECUTION_LOG_DDL = `
CREATE TABLE IF NOT EXISTS execution_log (
  id              TEXT PRIMARY KEY,   -- intent.id
  status          TEXT NOT NULL,      -- executed | shadow | rejected | failed
  chain           TEXT,
  token           TEXT,
  side            TEXT,
  amount_in       TEXT,
  amount_out      TEXT,
  tx_hash         TEXT,
  reason          TEXT,
  source_fly_ids  TEXT,               -- JSON array of the voting fly ids
  strength        REAL,
  confidence      REAL,
  created_at      INTEGER NOT NULL,   -- unix ms
  gas_used        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_execution_log_created ON execution_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_log_status  ON execution_log(status);
CREATE INDEX IF NOT EXISTS idx_execution_log_token   ON execution_log(token);
`;

/** Create the execution_log table + indexes if absent (idempotent, best-effort). */
export async function ensureExecutionSchema(db: D1Database): Promise<void> {
  for (const stmt of EXECUTION_LOG_DDL.split(";")) {
    const sql = stmt.trim();
    if (sql) await db.prepare(sql).run();
  }
}

/** Persist one terminal execution record. NEVER throws. */
export async function writeExecutionLog(
  env: Env,
  intent: ExecutionIntent,
  result: ExecutionResult,
): Promise<void> {
  const db = env.DB;
  if (!db) return; // D1 not bound (local dev / keyless run) — the shadow ring still records it
  try {
    await db
      .prepare(
        `INSERT OR REPLACE INTO execution_log
           (id, status, chain, token, side, amount_in, amount_out, tx_hash, reason,
            source_fly_ids, strength, confidence, created_at, gas_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        result.intentId,
        result.status,
        intent.chain,
        intent.token,
        intent.side,
        result.amountIn ?? null,
        result.amountOut ?? null,
        result.txHash ?? null,
        result.reason ?? null,
        JSON.stringify(intent.sourceFlyIds),
        intent.strength,
        intent.confidence,
        result.timestamp,
        result.gasUsed ?? null,
      )
      .run();
  } catch (e) {
    console.warn("[execution] D1 log write failed (non-fatal):", (e as Error).message);
  }
}

/** One audit row for an evaluate() rejection (before execute() short-circuits). */
export async function writeRejectionLog(
  env: Env,
  intent: ExecutionIntent,
  decision: RiskDecision,
): Promise<void> {
  if (decision.allow) return;
  await writeExecutionLog(env, intent, {
    status: "rejected",
    intentId: intent.id,
    reason: decision.reason,
    timestamp: Date.now(),
  });
}

export interface ExecutionLogRow {
  id: string;
  status: string;
  chain: string | null;
  token: string | null;
  side: string | null;
  amount_in: string | null;
  amount_out: string | null;
  tx_hash: string | null;
  reason: string | null;
  source_fly_ids: string | null;
  strength: number | null;
  confidence: number | null;
  created_at: number;
  gas_used: number | null;
}

/** Read the newest execution records for GET /execution/logs (best-effort; [] on any failure). */
export async function queryExecutionLogs(env: Env, limit = 30): Promise<ExecutionLogRow[]> {
  const db = env.DB;
  if (!db) return [];
  try {
    const capped = Math.max(1, Math.min(100, Math.floor(limit)));
    const { results } = await db
      .prepare(`SELECT * FROM execution_log ORDER BY created_at DESC LIMIT ?`)
      .bind(capped)
      .all<ExecutionLogRow>();
    return results ?? [];
  } catch (e) {
    console.warn("[execution] D1 log query failed (non-fatal):", (e as Error).message);
    return [];
  }
}
