// W8-1a — Circle Onramp session mint tests (see onramp.ts).
//
// The module is a PURE translation layer between the /fund page and Circle's
// `POST /v1/stablecoinKits/sessions` contract, so every rule can be pinned here with no network:
// the local address-shape guard (the upstream mints sessions even for garbage), the exact upstream
// body (walletAddress + server-injected referrerDomain, nothing else), the Bearer header (the key
// NEVER leaks into a message), the 201 → sessionToken → widget-URL composition, the failure mapping
// (401/403/4xx/5xx/transport → honest reasons with statuses), the not_configured short-circuit, and
// the per-IP sliding-window throttle.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ONRAMP_WIDGET_BASE,
  ONRAMP_SESSION_PATH,
  isValidEvmAddress,
  composeWidgetUrl,
  buildSessionBody,
  createOnrampSession,
  onrampStatus,
  IpRateLimiter,
  handleOnrampSession,
  type OnrampSessionResult,
} from "./onramp.js";

// ---------- helpers ----------

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const ADDR_MIXED = "0x1234567890AbCdEf1234567890abCdEf12345678"; // checksummed case is legal hex
const TEST_KEY = "TEST_API_KEY:aa:bb";
const LIVE_KEY = "LIVE_API_KEY:aa:bb";

/** Mock fetch that records the call and answers with a scripted response. */
function mockFetch(status: number, body: unknown, throws = false) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    if (throws) throw new Error("network down");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const SESSION_201 = { data: { sessionToken: "tok-123", expiresAt: "2026-10-01T07:40:12.000Z" } };

// ---------- constants + pure helpers ----------

test("Onramp endpoints + widget base match the probed contract", () => {
  assert.equal(ONRAMP_WIDGET_BASE, "https://onramp.arc.io");
  assert.equal(ONRAMP_SESSION_PATH, "/v1/stablecoinKits/sessions");
});

test("isValidEvmAddress accepts 0x+40hex (checksummed) and rejects everything else", () => {
  assert.equal(isValidEvmAddress(ADDR), true);
  assert.equal(isValidEvmAddress(ADDR_MIXED), true, "uppercase hex digits are valid (EIP-55)");
  assert.equal(isValidEvmAddress("not-an-address"), false);
  assert.equal(isValidEvmAddress("0x123"), false, "too short");
  assert.equal(isValidEvmAddress("0x" + "a".repeat(39)), false, "39 hex digits");
  assert.equal(isValidEvmAddress("0X" + "a".repeat(40)), false, "uppercase 0X prefix");
  assert.equal(isValidEvmAddress(""), false);
  assert.equal(isValidEvmAddress(("0x" + "g").repeat(1) + "a".repeat(39)), false, "non-hex digit");
});

test("composeWidgetUrl carries ONLY the session token (never the wallet address)", () => {
  const url = composeWidgetUrl("tok-1");
  assert.equal(url, "https://onramp.arc.io/?sessionToken=tok-1");
  assert.ok(!url.includes(ADDR));
});

test("buildSessionBody is exactly {walletAddress, referrerDomain}", () => {
  assert.deepEqual(buildSessionBody(ADDR, "flyx402.xyz"), { walletAddress: ADDR, referrerDomain: "flyx402.xyz" });
});

// ---------- createOnrampSession ----------

test("success: 201 → sessionToken + sandbox flag + composed widgetUrl, exact upstream call", async () => {
  const { impl, calls } = mockFetch(201, SESSION_201);
  const r = await createOnrampSession({ apiKey: TEST_KEY, address: ADDR, referrerDomain: "flyx402.xyz", fetchImpl: impl });
  assert.ok(r.ok);
  assert.equal((r as any).sessionToken, "tok-123");
  assert.equal((r as any).expiresAt, "2026-10-01T07:40:12.000Z");
  assert.equal((r as any).sandbox, true, "TEST_… prefix ⇒ sandbox");
  assert.equal((r as any).widgetUrl, "https://onramp.arc.io/?sessionToken=tok-123");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.circle.com/v1/stablecoinKits/sessions");
  const headers = new Headers((calls[0].init as any).headers);
  assert.equal(headers.get("Authorization"), `Bearer ${TEST_KEY}`);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { walletAddress: ADDR, referrerDomain: "flyx402.xyz" });
});

test("success with a LIVE key reports sandbox:false (real-money sessions)", async () => {
  const { impl } = mockFetch(201, SESSION_201);
  const r = await createOnrampSession({ apiKey: LIVE_KEY, address: ADDR, referrerDomain: "flyx402.xyz", fetchImpl: impl });
  assert.ok(r.ok);
  assert.equal((r as any).sandbox, false);
});

test("not_configured short-circuits BEFORE any network call", async () => {
  const { impl, calls } = mockFetch(201, SESSION_201);
  const r = await createOnrampSession({ apiKey: null, address: ADDR, referrerDomain: "x", fetchImpl: impl });
  assert.deepEqual(r, { ok: false, reason: "not_configured" });
  assert.equal(calls.length, 0, "no fetch when unarmed");
});

test("upstream 401 → circle_auth_failed; 403 → circle_forbidden; message carried, key never leaks", async () => {
  for (const [status, reason] of [
    [401, "circle_auth_failed"],
    [403, "circle_forbidden"],
  ] as const) {
    const { impl, calls } = mockFetch(status, { code: 3, message: `${status} Forbidden. errId: deadbeef` });
    const r = await createOnrampSession({ apiKey: TEST_KEY, address: ADDR, referrerDomain: "x", fetchImpl: impl });
    assert.deepEqual(r, { ok: false, reason, message: `${status} Forbidden. errId: deadbeef` });
    const bodyText = JSON.stringify(r);
    assert.ok(!bodyText.includes(TEST_KEY), "the key must never appear in any result");
  }
});

test("upstream 400 (validation) → upstream_rejected; 500 → upstream_error; transport throw → upstream_error", async () => {
  const a = mockFetch(400, { code: 331001, message: "Validation error" });
  assert.deepEqual(await createOnrampSession({ apiKey: TEST_KEY, address: ADDR, referrerDomain: "x", fetchImpl: a.impl }),
    { ok: false, reason: "upstream_rejected", message: "Validation error" });
  const b = mockFetch(500, { message: "boom" });
  assert.equal((await createOnrampSession({ apiKey: TEST_KEY, address: ADDR, referrerDomain: "x", fetchImpl: b.impl })).reason,
    "upstream_error");
  const c = mockFetch(200, {}, true);
  assert.equal((await createOnrampSession({ apiKey: TEST_KEY, address: ADDR, referrerDomain: "x", fetchImpl: c.impl })).reason,
    "upstream_error");
});

test("201 with a malformed body (no sessionToken) → upstream_error, never a partial success", async () => {
  const { impl } = mockFetch(201, { data: {} });
  const r = await createOnrampSession({ apiKey: TEST_KEY, address: ADDR, referrerDomain: "x", fetchImpl: impl });
  assert.deepEqual(r, { ok: false, reason: "upstream_error" });
});

test("status mapping is pinned for every outcome", () => {
  const ok: OnrampSessionResult = { ok: true, sandbox: true, sessionToken: "t", expiresAt: null, widgetUrl: "w" };
  assert.equal(onrampStatus(ok), 201);
  for (const [reason, status] of [
    ["bad_request", 400],
    ["rate_limited", 429],
    ["not_configured", 503],
    ["circle_auth_failed", 502],
    ["circle_forbidden", 502],
    ["upstream_rejected", 502],
    ["upstream_error", 502],
  ] as const) {
    assert.equal(onrampStatus({ ok: false, reason } as any), status, reason);
  }
});

// ---------- IpRateLimiter ----------

test("IpRateLimiter: sliding window admits max then 429s, and expires old hits", () => {
  const gate = new IpRateLimiter(10_000, 3);
  let now = 1_000_000;
  assert.equal(gate.allow("ip-a", now), true);
  assert.equal(gate.allow("ip-a", now + 1), true);
  assert.equal(gate.allow("ip-a", now + 2), true);
  assert.equal(gate.allow("ip-a", now + 3), false, "4th hit inside the window");
  now += 10_001;
  assert.equal(gate.allow("ip-a", now), true, "all three hits expired → admitted again");
  assert.equal(gate.allow("ip-b", now), true, "independent per-IP buckets");
});

// ---------- handleOnrampSession (the route body) ----------

function postReq(body: unknown, ip = "1.2.3.4"): Request {
  return new Request("https://flyx402.xyz/onramp/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("route: happy path → 201 + widgetUrl; referrerDomain derived from the request host", async () => {
  const { impl, calls } = mockFetch(201, SESSION_201);
  const resp = await handleOnrampSession(postReq({ destinationAddress: ADDR }), { apiKey: TEST_KEY }, impl);
  assert.equal(resp.status, 201);
  const out = await resp.json();
  assert.equal(out.ok, true);
  assert.equal(out.sandbox, true);
  assert.equal(out.widgetUrl, "https://onramp.arc.io/?sessionToken=tok-123");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { walletAddress: ADDR, referrerDomain: "flyx402.xyz" });
});

test("route: malformed destination rejected LOCALLY with 400 — upstream never sees garbage, key never spent", async () => {
  for (const bad of ["not-an-address", "0x123", "", 42, undefined]) {
    const { impl, calls } = mockFetch(201, SESSION_201);
    const resp = await handleOnrampSession(postReq({ destinationAddress: bad }), { apiKey: TEST_KEY }, impl);
    assert.equal(resp.status, 400);
    const out = await resp.json();
    assert.equal(out.reason, "bad_request");
    assert.equal(calls.length, 0, `no upstream call for ${JSON.stringify(bad)}`);
  }
});

test("route: broken JSON and oversized bodies → 400 bad_request", async () => {
  const { impl } = mockFetch(201, SESSION_201);
  const broken = await handleOnrampSession(postReq("{nope"), { apiKey: TEST_KEY }, impl);
  assert.equal(broken.status, 400);
  const big = await handleOnrampSession(
    new Request("https://flyx402.xyz/onramp/session", { method: "POST", body: "x".repeat(2048) }),
    { apiKey: TEST_KEY }, impl,
  );
  assert.equal(big.status, 400, ">1KB body refused before parse");
});

test("route: unarmed key → 503 not_configured (honest empty state, no upstream call)", async () => {
  const { impl, calls } = mockFetch(201, SESSION_201);
  const resp = await handleOnrampSession(postReq({ destinationAddress: ADDR }), { apiKey: null }, impl);
  assert.equal(resp.status, 503);
  assert.equal((await resp.json()).reason, "not_configured");
  assert.equal(calls.length, 0);
});

test("route: per-IP throttle → 429 after the 12th mint in the window", async () => {
  const { impl } = mockFetch(201, SESSION_201);
  for (let i = 0; i < 12; i++) {
    const resp = await handleOnrampSession(postReq({ destinationAddress: ADDR }, "9.9.9.9"), { apiKey: TEST_KEY }, impl);
    assert.equal(resp.status, 201, `mint ${i + 1} should pass`);
  }
  const blocked = await handleOnrampSession(postReq({ destinationAddress: ADDR }, "9.9.9.9"), { apiKey: TEST_KEY }, impl);
  assert.equal(blocked.status, 429);
  const otherIp = await handleOnrampSession(postReq({ destinationAddress: ADDR }, "8.8.8.8"), { apiKey: TEST_KEY }, impl);
  assert.equal(otherIp.status, 201, "a different IP is unaffected");
});

test("route: upstream failure surfaces as 502 with the mapped reason (never throws, never leaks the key)", async () => {
  const { impl } = mockFetch(403, { message: "forbidden" });
  const resp = await handleOnrampSession(postReq({ destinationAddress: ADDR }), { apiKey: TEST_KEY }, impl);
  assert.equal(resp.status, 502);
  const out = await resp.json();
  assert.equal(out.reason, "circle_forbidden");
  assert.ok(!JSON.stringify(out).includes(TEST_KEY));
});
