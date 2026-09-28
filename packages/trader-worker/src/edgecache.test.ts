// Wave-6b — table-driven tests for the DO quota shield (edgecache.ts).
// Injectable clock: no real sleeps; the timeline advances by hand.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEdgeCache, policyFor } from "./edgecache.js";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getRequest(path: string, opts: { nocache?: boolean; noCacheHeader?: boolean } = {}): Request {
  const url = new URL(`https://flyx402.xyz${path}${opts.nocache ? "?nocache=1" : ""}`);
  const headers = new Headers(opts.noCacheHeader ? { "Cache-Control": "no-cache" } : {});
  return new Request(url, { method: "GET", headers });
}

describe("edgecache — policy table", () => {
  it("covers the hot read surface", () => {
    for (const p of ["/state", "/population", "/annals", "/bourse", "/meme/snapshot", "/war", "/economy", "/announcements"]) {
      assert.ok(policyFor(p), `${p} should be cached`);
    }
  });
  it("leaves the write/ops surface untouched", () => {
    for (const p of ["/tick", "/reset", "/stimulus", "/breed", "/history", "/openapi.json", "/unknown"]) {
      assert.equal(policyFor(p), null, `${p} must not be cached`);
    }
  });
});

describe("edgecache — wrap behaviour", () => {
  it("caches a GET within the TTL window (second read = hit, doFetch ran once)", async () => {
    let t = 1_000_000;
    const cache = makeEdgeCache(() => t);
    let calls = 0;
    const doFetch = async () => { calls += 1; return jsonResp({ ok: true, n: calls }); };
    const r1 = await cache.wrap(getRequest("/state"), "/state", doFetch);
    assert.equal(r1.headers.get("X-Cache"), "miss");
    assert.equal((await r1.json()).n, 1);
    t += 1_000;                                     // 1s later — still fresh (ttl 5s)
    const r2 = await cache.wrap(getRequest("/state"), "/state", doFetch);
    assert.equal(r2.headers.get("X-Cache"), "hit");
    assert.equal((await r2.json()).n, 1);           // same stored body
    assert.equal(calls, 1);
  });

  it("distinct query strings are distinct entries", async () => {
    let t = 2_000_000;
    const cache = makeEdgeCache(() => t);
    let calls = 0;
    const doFetch = async () => { calls += 1; return jsonResp({ call: calls }); };
    await cache.wrap(getRequest("/snapshot?flyId=1"), "/snapshot?flyId=1", doFetch);
    await cache.wrap(getRequest("/snapshot?flyId=2"), "/snapshot?flyId=2", doFetch);
    assert.equal(calls, 2);
  });

  it("POST bypasses the cache entirely", async () => {
    let t = 3_000_000;
    const cache = makeEdgeCache(() => t);
    let calls = 0;
    const doFetch = async () => { calls += 1; return jsonResp({ ok: true }); };
    const post = new Request("https://flyx402.xyz/stimulus", { method: "POST" });
    await cache.wrap(post, "/stimulus", doFetch);
    await cache.wrap(post, "/stimulus", doFetch);
    assert.equal(calls, 2);
  });

  it("?nocache=1 and Cache-Control: no-cache both bypass", async () => {
    let t = 4_000_000;
    const cache = makeEdgeCache(() => t);
    let calls = 0;
    const doFetch = async () => { calls += 1; return jsonResp({ ok: true }); };
    await cache.wrap(getRequest("/state"), "/state", doFetch);
    await cache.wrap(getRequest("/state", { nocache: true }), "/state", doFetch);
    await cache.wrap(getRequest("/state", { noCacheHeader: true }), "/state", doFetch);
    assert.equal(calls, 3);
  });

  it("past TTL but inside the stale window: a 500 replays the stale copy", async () => {
    let t = 5_000_000;
    const cache = makeEdgeCache(() => t);
    let fail = false;
    const doFetch = async () => {
      if (fail) return jsonResp({ error: "quota" }, 500);
      return jsonResp({ ok: true, data: "last-good" });
    };
    await cache.wrap(getRequest("/state"), "/state", doFetch);        // warm
    t += 30_000;                                                      // 30s: past ttl(5s), inside stale(300s)
    fail = true;
    const r = await cache.wrap(getRequest("/state"), "/state", doFetch);
    assert.equal(r.headers.get("X-Cache"), "stale");
    assert.equal((await r.json()).data, "last-good");
  });

  it("past TTL + stale on a live 500 without a copy: passes the 500 through", async () => {
    let t = 6_000_000;
    const cache = makeEdgeCache(() => t);
    const doFetch = async () => jsonResp({ error: "quota" }, 500);
    const r = await cache.wrap(getRequest("/bourse"), "/bourse", doFetch);
    assert.equal(r.status, 500);
    assert.equal(r.headers.get("X-Cache"), null);
  });

  it("a thrown DO (the 1101 wall) becomes an honest 503 JSON with no copy", async () => {
    let t = 7_000_000;
    const cache = makeEdgeCache(() => t);
    const doFetch = async () => { throw new Error("Exceeded allowed volume of requests in Durable Objects free tier."); };
    const r = await cache.wrap(getRequest("/state"), "/state", doFetch);
    assert.equal(r.status, 503);
    const body = await r.json() as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.equal(body.error, "upstream-unavailable");
  });

  it("4xx answers pass through untouched and are never cached", async () => {
    let t = 8_000_000;
    const cache = makeEdgeCache(() => t);
    let calls = 0;
    const doFetch = async () => { calls += 1; return jsonResp({ error: "nope" }, 404); };
    const r1 = await cache.wrap(getRequest("/flies/99"), "/flies/99", doFetch);
    assert.equal(r1.status, 404);
    assert.equal(r1.headers.get("X-Cache"), null);
    await cache.wrap(getRequest("/flies/99"), "/flies/99", doFetch);
    assert.equal(calls, 2);                                           // not cached
  });

  it("entries beyond ttl+stale stop serving (and get pruned)", async () => {
    let t = 9_000_000;
    const cache = makeEdgeCache(() => t);
    let calls = 0;
    const doFetch = async () => { calls += 1; return jsonResp({ ok: true }); };
    await cache.wrap(getRequest("/market"), "/market", doFetch);      // ttl 10s + stale 300s
    t += 400_000;                                                     // past everything
    await cache.wrap(getRequest("/market"), "/market", doFetch);
    assert.equal(calls, 2);
    assert.equal(cache.size, 1);                                      // only the fresh one remains
  });

  it("the entry cap holds (MAX_ENTRIES=64)", async () => {
    let t = 10_000_000;
    const cache = makeEdgeCache(() => t);
    const doFetch = async () => jsonResp({ ok: true });
    for (let i = 0; i < 80; i++) {
      await cache.wrap(getRequest(`/snapshot?flyId=${i}`), `/snapshot?flyId=${i}`, doFetch);
    }
    assert.ok(cache.size <= 64);
  });
});
