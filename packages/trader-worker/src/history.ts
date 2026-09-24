// 冻结治理（P0）：/history 直读 D1 —— 把这个纯只读的长期历史端点从 FlyStateDO 的单线程输入队列上
// 摘下来。此前 /history 要排队等 DO（正在跑每分钟 cron / 分片推进），一次慢查询就能让历史页和
// 前端 ribbon 挤占 tick 的调度窗口。Worker 直连 D1 后与 DO 版响应逐字段同形；D1 不可用或查询失败
// 时返回 null，由 index.ts 回落到 DO 原路径（DO 版保留为 fallback，行为不变）。
//
// 汇总聚合按 isolate 缓存 60s（ticks 表每 cron 只增一行，60s 缓存永远新鲜到分钟级），避免每次
// 请求都全表聚合 —— 与 DO 侧“缓存的运行汇总”同一成本量级。

import type { Env } from "./config.js";

const COLS = "tick, ts, temperature, regime, size, deals, settlements, volume_usdc, gini, top_state, top_states";

interface HistSummary {
  ticks: number;
  firstTick: number | null;
  lastTick: number | null;
  firstTs: number | null;
  lastTs: number | null;
  settlements: number | null;
  volumeUsdc: number | null;
}

let cachedSummary: { at: number; s: HistSummary } | null = null;
const SUMMARY_TTL_MS = 60_000;

/** 与 state.ts 的 parseHistoryRow 同形的行整形（自有实现，字段一一对应）。 */
function shapeRow(r: any) {
  let topStates: Record<string, number> | null = null;
  if (r?.top_states) {
    try {
      topStates = JSON.parse(r.top_states);
    } catch {
      topStates = null;
    }
  }
  return {
    tick: r?.tick ?? null,
    ts: r?.ts ?? null,
    temperature: r?.temperature ?? null,
    regime: r?.regime ?? null,
    size: r?.size ?? null,
    deals: r?.deals ?? null,
    settlements: r?.settlements ?? null,
    volumeUsdc: r?.volume_usdc ?? null,
    gini: r?.gini ?? null,
    topState: r?.top_state ?? null,
    topStates,
  };
}

async function summaryOf(db: D1Database): Promise<HistSummary> {
  if (cachedSummary && Date.now() - cachedSummary.at < SUMMARY_TTL_MS) return cachedSummary.s;
  const agg = await db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(tick) AS firstTick, MAX(tick) AS lastTick, MIN(ts) AS firstTs,
              MAX(ts) AS lastTs, MAX(settlements) AS settlements, MAX(volume_usdc) AS volumeUsdc FROM ticks`,
    )
    .all();
  const a: any = (agg.results ?? [])[0] ?? {};
  const s: HistSummary = {
    ticks: Number(a.n ?? 0),
    firstTick: a.firstTick ?? null,
    lastTick: a.lastTick ?? null,
    firstTs: a.firstTs ?? null,
    lastTs: a.lastTs ?? null,
    settlements: a.settlements ?? null,
    volumeUsdc: a.volumeUsdc ?? null,
  };
  cachedSummary = { at: Date.now(), s };
  return s;
}

/**
 * GET /history 直连 D1 版。返回 Response 表示已应答；返回 null 表示“本路径不应答”（无 DB 绑定 /
 * 查询失败），调用方回落 DO 原实现。查询参数与 DO 版完全一致：limit / before / order。
 */
export async function handleHistoryDirect(url: URL, env: Env): Promise<Response | null> {
  const db = env.DB;
  if (!db) return null;
  try {
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? "500") || 500));
    const order = url.searchParams.get("order") === "asc" ? "ASC" : "DESC";
    const beforeRaw = url.searchParams.get("before");
    const hasBefore = beforeRaw != null && Number.isFinite(Number(beforeRaw));
    const page = hasBefore
      ? await db
          .prepare(`SELECT ${COLS} FROM ticks WHERE tick < ? ORDER BY tick ${order} LIMIT ?`)
          .bind(Number(beforeRaw), limit)
          .all()
      : await db
          .prepare(`SELECT ${COLS} FROM ticks ORDER BY tick ${order} LIMIT ?`)
          .bind(limit)
          .all();
    const rows = (page.results ?? []).map(shapeRow);
    const a = await summaryOf(db);
    return new Response(
      JSON.stringify({
        enabled: true,
        order,
        count: rows.length,
        summary: {
          ticks: a.ticks,
          firstTick: a.firstTick,
          lastTick: a.lastTick,
          firstTs: a.firstTs,
          lastTs: a.lastTs,
          settlements: a.settlements,
          volumeUsdc: a.volumeUsdc,
        },
        rows,
      }),
      { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
    );
  } catch {
    return null;   // D1 抖动/表未建：交给 DO 原路径（其内部还有建表兜底）
  }
}
