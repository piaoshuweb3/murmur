// W8-1a — Circle Onramp session mint (the /fund page's server half).
//
// WHY THIS EXISTS. The /fund page lets a visitor buy USDC (card / Apple Pay / Google Pay) straight into
// their own wallet through Circle's HOSTED onramp widget (https://onramp.arc.io). Circle requires the
// session to be minted server-side with an API key — the browser never sees the key, only a short-lived
// sessionToken (~30 min). This module is the thin, PURE layer between that page and Circle's
// `POST /v1/stablecoinKits/sessions` contract, so it is fully unit-testable with no network. The worker
// route itself lives in index.ts (worker-direct, like /community — it never contends for the swarm DO's
// single-threaded input queue).
//
// HARD CONTRACT FACTS (probed against the LIVE api.circle.com + read from @circle-fin/app-kit 1.16.0
// source, 2026-10-01):
//   · Endpoint : POST {baseUrl}/v1/stablecoinKits/sessions   (prod https://api.circle.com)
//   · Auth     : Authorization: Bearer <key>. A TEST_API_KEY mints SANDBOX sessions (no real money);
//                a LIVE_API_KEY mints real ones. Both pass the same endpoint (probed 201 on both paths).
//   · Body     : { walletAddress, referrerDomain? } — walletAddress is the ONLY required field
//                ({} → 400 "expected string … path walletAddress"); referrerDomain is accepted and
//                needed for card rails. The upstream does NOT validate the address shape ("not-an-address"
//                still returns 201), so WE reject malformed destinations before ever calling out.
//   · Response : 201 {data:{sessionToken, expiresAt}}. Widget launch URL = widget base + "/?sessionToken=…"
//                (the app-kit composeWidgetUrl contract; sessionToken is the only required query field —
//                NEVER put the wallet address in the URL: launch URLs land in browser history + logs).
//   · Failure  : 401 bad key · 403 scope/region · other 4xx/5xx — all mapped to honest machine reasons,
//                never thrown, and the key never appears in any message.
//
// KEY ISOLATION (deliberate refinement of the Wave-8 plan §2.1 "same CIRCLE_API_KEY"): the onramp key
// lives in its OWN secret (CIRCLE_ONRAMP_API_KEY) so arming the /fund page can NEVER flip the settlement
// facilitator's auth mode (circle.ts switches the x402 path to Bearer the moment CIRCLE_API_KEY is set —
// see circle.ts/circleAuthHeaders). Two money-adjacent toggles must not share one switch: a bad or
// sandbox-only onramp key must be unable to break live settlement, and vice versa. Zero var budget either
// way (secrets do not occupy the 64-slot free-tier budget).

/** Circle's hosted onramp widget origin — the session's launch URL is composed from it (app-kit contract). */
export const ONRAMP_WIDGET_BASE = "https://onramp.arc.io";

/** Upstream route appended to the Circle base URL. */
export const ONRAMP_SESSION_PATH = "/v1/stablecoinKits/sessions";

/** Rejection reasons — the browser maps these to localized, honest copy. Kept stable: they are API. */
export type OnrampRejection =
  | "not_configured"      // CIRCLE_ONRAMP_API_KEY unset → the page explains the operator must arm it
  | "bad_request"         // malformed destinationAddress (rejected locally, upstream never called)
  | "rate_limited"        // too many sessions from one IP in the window
  | "circle_auth_failed"  // upstream 401 — the configured key is not accepted
  | "circle_forbidden"    // upstream 403 — scope/region refusal
  | "upstream_rejected"   // other upstream 4xx — request-level rejection
  | "upstream_error";     // upstream 5xx or transport failure

export interface OnrampSessionSuccess {
  ok: true;
  /** true when the configured key is a Circle TEST key → sandbox sessions, no real money moves. */
  sandbox: boolean;
  sessionToken: string;
  expiresAt: string | null;
  widgetUrl: string;
}
export interface OnrampSessionFailure {
  ok: false;
  reason: OnrampRejection;
  /** Short human-readable upstream note when available; NEVER contains the key. */
  message?: string;
}
export type OnrampSessionResult = OnrampSessionSuccess | OnrampSessionFailure;

/** EVM destination shape: 0x-prefixed (lowercase prefix) + 40 hex digits, checksum case allowed. */
export function isValidEvmAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

/**
 * The launch URL: `${ONRAMP_WIDGET_BASE}/?sessionToken=<url-encoded token>`.
 * Deliberately the ONLY query field — wallet addresses and user identifiers must never appear in a URL
 * that ends up in browser history and access logs (app-kit's own warning).
 */
export function composeWidgetUrl(sessionToken: string): string {
  const url = new URL("/", ONRAMP_WIDGET_BASE);
  url.searchParams.set("sessionToken", sessionToken);
  return url.toString();
}

/**
 * Tiny per-isolate IP rate limiter for the session mint (stateless upstream call — the only thing worth
 * throttling is key-burn and widget spam). Sliding window of timestamps per IP; fully-expired IPs are
 * pruned lazily once the map grows. Isolate eviction resets it — acceptable for a throttle, not a ledger.
 */
export class IpRateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}
  allow(ip: string, now = Date.now()): boolean {
    const fresh = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (fresh.length >= this.max) {
      this.hits.set(ip, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(ip, fresh);
    if (this.hits.size > 4096) {
      for (const [k, v] of this.hits) if (v.length && now - v[v.length - 1] >= this.windowMs) this.hits.delete(k);
    }
    return true;
  }
}

/** The upstream request body — asserted verbatim by the tests (walletAddress + fixed referrerDomain). */
export function buildSessionBody(address: string, referrerDomain: string): { walletAddress: string; referrerDomain: string } {
  return { walletAddress: address, referrerDomain };
}

/**
 * Mint one hosted-onramp session. NEVER throws — every failure mode collapses into an
 * {ok:false, reason} the route turns into an honest JSON status.
 */
export async function createOnrampSession(opts: {
  apiKey: string | null;
  address: string;
  referrerDomain: string;
  baseUrl?: string; // default https://api.circle.com
  fetchImpl?: typeof fetch; // injectable for tests
}): Promise<OnrampSessionResult> {
  if (!opts.apiKey) return { ok: false, reason: "not_configured" };
  const base = (opts.baseUrl ?? "https://api.circle.com").replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await doFetch(base + ONRAMP_SESSION_PATH, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(buildSessionBody(opts.address, opts.referrerDomain)),
    });
  } catch {
    return { ok: false, reason: "upstream_error" };
  }
  if (resp.status === 201) {
    let data: any;
    try {
      data = await resp.json();
    } catch {
      return { ok: false, reason: "upstream_error" };
    }
    const token = data?.data?.sessionToken;
    if (typeof token !== "string" || token.length === 0) {
      return { ok: false, reason: "upstream_error" };
    }
    const expiresAt = typeof data?.data?.expiresAt === "string" ? data.data.expiresAt : null;
    return {
      ok: true,
      sandbox: opts.apiKey.startsWith("TEST_API_KEY:"),
      sessionToken: token,
      expiresAt,
      widgetUrl: composeWidgetUrl(token),
    };
  }
  // Failure mapping — pull Circle's one-line `message` when present (never the key, never a stack).
  let note: string | undefined;
  try {
    const body: any = await resp.json();
    if (typeof body?.message === "string" && body.message) note = body.message.slice(0, 200);
  } catch { /* body-less rejection is fine */ }
  if (resp.status === 401) return { ok: false, reason: "circle_auth_failed", message: note };
  if (resp.status === 403) return { ok: false, reason: "circle_forbidden", message: note };
  if (resp.status >= 400 && resp.status < 500) return { ok: false, reason: "upstream_rejected", message: note };
  return { ok: false, reason: "upstream_error", message: note };
}

/** HTTP status for each outcome — exported so the tests can pin the whole mapping. */
export function onrampStatus(r: OnrampSessionResult): number {
  if (r.ok) return 201;
  switch (r.reason) {
    case "bad_request": return 400;
    case "rate_limited": return 429;
    case "not_configured": return 503;
    default: return 502; // circle_auth_failed / circle_forbidden / upstream_* — operator-visible, honest
  }
}

/** Per-isolate default throttle shared by every call that doesn't inject its own gate (12 mints / 10 min / IP). */
const DEFAULT_LIMITER = new IpRateLimiter(10 * 60_000, 12);

/**
 * The worker-direct route body: parse → validate → throttle → mint. Returns a Response with CORS-free
 * JSON (index.ts re-applies the shared CORS headers exactly like the /community path). Never throws.
 * Request body contract: { destinationAddress } — one field, mirrored from the Wave-8 plan §2.1.
 */
export async function handleOnrampSession(
  request: Request,
  cfg: { apiKey: string | null },
  fetchImpl?: typeof fetch,
  limiter?: IpRateLimiter,
): Promise<Response> {
  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  // 1) read the (tiny) body — refuse anything oversized before parsing
  let address = "";
  try {
    const raw = await request.text();
    if (raw.length > 1024) return json(400, { ok: false, reason: "bad_request" });
    const parsed = JSON.parse(raw) as { destinationAddress?: unknown };
    address = typeof parsed?.destinationAddress === "string" ? parsed.destinationAddress.trim() : "";
  } catch {
    return json(400, { ok: false, reason: "bad_request" });
  }

  // 2) shape-check LOCALLY — the upstream mints sessions even for garbage ("not-an-address" → 201),
  //    so the guard must live here, before the key is spent.
  if (!isValidEvmAddress(address)) {
    return json(400, { ok: false, reason: "bad_request" });
  }

  // 3) throttle per IP (best-effort; a missing IP header degrades to a shared bucket, never a crash)
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const gate = limiter ?? DEFAULT_LIMITER;
  if (!gate.allow(ip)) return json(429, { ok: false, reason: "rate_limited" });

  // 4) mint — referrerDomain is injected SERVER-side (the page cannot forge it): the requesting host.
  let origin = "flyx402.xyz";
  try {
    origin = new URL(request.url).hostname || origin;
  } catch { /* keep the default */ }
  const result = await createOnrampSession({
    apiKey: cfg.apiKey,
    address,
    referrerDomain: origin,
    fetchImpl,
  });
  return json(onrampStatus(result), result);
}
