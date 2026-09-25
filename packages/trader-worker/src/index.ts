// Cloudflare Worker entry — forwards HTTP requests to the Durable Object and handles Cron.

import { loadConfig, type Env } from "./config.js";
import { FlyStateDO } from "./state.js";
import { OPENAPI_SPEC } from "./openapi.js";
import { handleCommunity } from "./community.js";
import { handleHistoryDirect } from "./history.js";

// 冻结治理（P0）：scheduled→DO /tick 自调用的壁钟上限（远小于 Workers cron 的 900s 墙）。
const CRON_SELF_TIMEOUT_MS = 600_000;

// FlyStateDO is the coordinator (public fetch + cron route here). FlyShardDO holds one slice of the
// swarm and is reachable ONLY from the coordinator over the FLY_SHARD binding when SHARD_COUNT > 1
// (see swarm.ts / shard.ts). Both must be exported so wrangler registers the DO classes; with the
// default SHARD_COUNT = "1" no shard is ever instantiated and the piece runs exactly as before.
export { FlyStateDO };
export { FlyShardDO } from "./shard.js";

const DO_NAME = "fly-main";   // Singleton DO: the whole swarm shares one state store

function getDO(env: Env) {
  const id = env.FLY_STATE.idFromName(DO_NAME);
  return env.FLY_STATE.get(id);
}

function corsHeaders(req: Request, env: Env) {
  // v1.4 (audit F-6): with CORS_ALLOW_ORIGINS set, only whitelisted Origins get an ACAO header —
  // unlisted origins get none (the browser blocks them). Unset = legacy behaviour (reflect any Origin),
  // so the public read-only API surface stays byte-for-byte compatible unless the operator opts in.
  const origin = req.headers.get("Origin");
  const allowList = (env.CORS_ALLOW_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const base = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    // X-PAYMENT carries the browser-signed x402 payload for the paid /signal/pulse product.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-PAYMENT",
    // Let the browser read the x402 settlement result + the 402 requirements.
    "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE, PAYMENT-REQUIRED, X-PAYMENT-VERSION",
    "Access-Control-Max-Age": "86400",
  };
  if (!origin) return base;                                   // non-browser / same-origin: CORS not applicable
  if (allowList.length > 0 && !allowList.includes(origin)) return base;  // strict mode: not whitelisted
  return { ...base, "Access-Control-Allow-Origin": origin };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Non-breaking versioning: an optional /v1 prefix serves the identical surface
    // (/v1/population === /population). Strip it once here so neither the root handler nor the
    // DO router needs to know about it.
    // Same-origin bundling: when the frontend ships inside this same Worker (Workers static
    // assets, [assets] in wrangler.toml) its default API base is "/api" on THIS origin — strip
    // that prefix too so /api/* routes to the identical surface (/api/state === /state). Only
    // GET/HEAD asset-path matches are served from [assets]; /api/* never matches an asset, and
    // POSTs always reach the script, so nothing is shadowed.
    const rawPath = url.pathname;
    const path = rawPath === "/v1" || rawPath === "/api" ? "/"
      : rawPath.startsWith("/v1/") ? rawPath.slice(3)
      : rawPath.startsWith("/api/") ? rawPath.slice(4)
      : rawPath;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    // The OpenAPI 3.1 contract — served straight from the worker (no DO round-trip), free + CORS-open.
    if (path === "/openapi.json") {
      return new Response(JSON.stringify(OPENAPI_SPEC), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ...corsHeaders(request, env) },   // 二次开发: F-6 白名单签名
      });
    }

    // Root path: health check + simple endpoint navigation
    if (path === "/" || path === "/health") {
      // /health 特性清单：P1 同步层按旗动态追加（前端读它决定 Bourse/Faith/Poetry 卷是否显示）。
      const healthCfg = loadConfig(env);
      const features = [
        "population", "market-temperature", "neural-sim", "stimulus", "agent-economy-x402", "prediction-market", "human-arena-murmur", "community-governance", "d1-history-archive", "brain-manifest-provenance", "connectome-breeding-lineage", "public-api-openapi", "meme-monitoring-optional", "external-execution-shadow-optional",
        ...(healthCfg.bourse.enabled ? ["bourse-optional"] : []),
        ...(healthCfg.religion.enabled ? ["faith-optional"] : []),
        ...(healthCfg.poet.enabled ? ["laureate-optional"] : []),
      ];
      return new Response(
        JSON.stringify({
          ok: true,
          name: "murmur",
          version: "1.5.0",
          chain: "arc",
          apiVersion: "v1",
          openapi: "/openapi.json",
          docs: "/developers.html",
          transparency: "/transparency.html",
          features,
          endpoints: [
            "GET  /openapi.json (this API's OpenAPI 3.1 contract — free, no key, CORS-enabled; human docs at /developers.html)",
            "GET  /state",
            "GET  /population   (collective mood + per-fly drives + economy summary — the frontend feed)",
            "GET  /market       (current Arc activity → temperature / regime)",
            "GET  /economy      (agent wallets + x402 settlement ledger + totals)",
            "GET  /leaderboard  (trustless per-agent PnL ranking + paid-signal revenue)",
            "GET  /signal/pulse (x402 paywall: 402 → pay USDC → the machine-readable Arc-activity signal)",
            "GET  /signal/requirements (the x402 payment requirements a browser signs to buy the signal)",
            "GET  /predictions  (on-chain prediction market: live book + parimutuel odds + hit-rate leaderboard)",
            "GET  /predictions/verify?round=N (recompute a round's receipt hash + read its on-chain registry commitment)",
            "GET  /manifest      (the swarm's brain manifest + its sha256 identity — trustless 'prove the brain': real connectomes, no LLM)",
            "GET  /manifest/replay (server-side offline replay: rebuild every connectome from the committed seeds → PASS/FAIL)",
            "GET  /lineage      (the connectome breeding market: every genome + its on-chain ancestry — genesis roots + bred individuals)",
            "GET  /lineage/:hash (one bred brain: genome body + parents/children + re-derived structural spec + on-chain commit)",
            "GET  /lineage/verify?hash=0x… (recompute a genome's hash, replay its brain, confirm its on-chain ancestry → PASS/FAIL)",
            "GET  /arena        (human-vs-swarm MURMUR arena: live book + parimutuel odds + you-vs-the-swarm hit rate)",
            "GET  /community  (token-gated governance forum: browse free; post/propose/vote need a MURMUR-holding wallet signature — see /community for the sub-endpoints)",
            "GET  /history      (D1 long-term archive: one row per cron — temperature/regime/deals/volume/gini/topStates; served worker-direct off the DO queue)",
            "GET  /bourse       (⑲ our coin's tape: fever/whales/treasury inflow/silence — read-only Transfer-log narration; 501 while BOURSE_ENABLED=false)",
            "GET  /poem         (the Laureate: deterministic neuron-born poems, no LLM; 501 while POET_ENABLED=false)",
            "GET  /execution/logs (二次开发 layer: external execution audit feed — shadow fills + D1 audit rows)",
            "GET  /stimuli",
            "GET  /snapshot?flyId=N   (full neural state of one fly + its agent wallet)",
            "GET  /flies/:id",
            "POST /stimulus     (poke the swarm)",
            "POST /breed        (apply a genetic operator to committed parents → record the offspring; ADMIN_TOKEN gated)",
            "POST /tick         (debug: run one cron now)",
            "POST /reset        (debug: fresh founding population + funded wallets)",
          ],
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders(request, env) } },
      );
    }

    // Community governance page API — handled in the Worker (never a DO round-trip): it is orthogonal to the
    // tick/swarm and only reads the chain (balanceOf) + writes D1, so it must NOT contend for the swarm DO's
    // single-threaded input queue. Inert (501) unless cfg.community.enabled; CORS re-applied like the DO path.
    if (path === "/community" || path.startsWith("/community/")) {
      const cfg = loadConfig(env);
      const communityResp = await handleCommunity({ path, url, request, env, cfg });
      const communityHeaders = new Headers(communityResp.headers);
      for (const [k, v] of Object.entries(corsHeaders(request, env))) communityHeaders.set(k, v);   // 二次开发: F-6 白名单签名
      return new Response(communityResp.body, { status: communityResp.status, headers: communityHeaders });
    }

    // 冻结治理（P0）：/history 直读 D1（绕开 DO 单线程输入队列）；D1 不可用时返回 null，
    // 继续走下方 DO 原路径（保留为 fallback，行为不变）。
    if (path === "/history" && request.method === "GET") {
      const direct = await handleHistoryDirect(url, env);
      if (direct) {
        const headers = new Headers(direct.headers);
        for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);   // 二次开发: F-6 白名单签名
        return new Response(direct.body, { status: direct.status, headers });
      }
    }

    // ── 差异化层（自有实现）：上游把公开结算遥测独立成 /canary；我方把它并入"主权+遥测"信任总页
    // /transparency.html#telemetry（六合约主权与结算遥测同框叙事）。v1.5.2 起放行独立实时页：
    // frontend/public/canary.html（七板块结算遥测，自有实现）由 assets 先行命中 /canary(/canary.html)，
    // worker 这条 301 只兜底 assets 未命中的边缘情形（老书签/上游对比流量永不 404）。
    if (path === "/canary") {
      return new Response(null, {
        status: 301,
        headers: { location: "/transparency.html#telemetry", "cache-control": "public, max-age=86400" },
      });
    }

    // Forward every other request to the DO (with the /v1 prefix already stripped)
    const stub = getDO(env);
    const doUrl = new URL(request.url);
    doUrl.pathname = path;
    const resp = await stub.fetch(new Request(doUrl.toString(), request));

    // Re-apply CORS headers (the DO already adds them once; keep it idempotent here)
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(corsHeaders(request, env))) headers.set(k, v);
    return new Response(resp.body, { status: resp.status, headers });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = getDO(env);
    // Trigger the cron via the internal /tick path (DOs have no direct scheduled hook). Present
    // ADMIN_TOKEN when configured so this trusted internal tick clears the same guard that blocks
    // anonymous callers from the public POST /tick + /reset endpoints — otherwise arming the token
    // would 403 the cron and freeze the live swarm.
    const token = (env.ADMIN_TOKEN ?? "").trim();
    const headers: Record<string, string> = token ? { "x-admin-token": token } : {};
    const url = `https://do.internal/tick`;
    // 冻结治理（P0）：cron 自调用也要限时 —— 一个卡死的 DO tick 不能把 scheduled 挂在 900s 壁钟
    // 墙上。超时只解除调用方的等待（DO 内部该跑的还会跑完/被内部超时截断），且永不向上抛噪音。
    try {
      await stub.fetch(
        new Request(url, { method: "POST", headers, signal: AbortSignal.timeout(CRON_SELF_TIMEOUT_MS) }),
      );
    } catch (e) {
      console.error("[cron] self-call failed or timed out:", (e as Error).message);
    }
  },
} satisfies ExportedHandler<Env>;
