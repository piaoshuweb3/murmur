// Wave-6b — the DO quota shield: an in-isolate TTL cache over the hot read surface.
//
// Why: 2026-09-28 the production DO tripped the free-tier daily request ceiling
// ("Exceeded allowed volume of requests in Durable Objects free tier") — every HTTP request
// except /health /openapi.json /community /history forwards to the singleton DO, and each
// open tab polls /state every few seconds, so N tabs = N× the DO volume. The isolate-local
// cache collapses that fan-out inside one isolate (same-region tabs mostly share warm
// isolates), and — more important for the incident itself — when the DO errors out (quota,
// hiccup) a still-fresh STALE copy is served instead of a raw 1101: the page keeps painting
// honest, slightly-old data while the platform recovers.
//
// Design rules:
// · GET-only, JSON-ish bodies < 512 KB, exact-path TTL table (+ a few prefixes); everything
//   else passes straight through — zero behavioural change for the write/ops surface.
// · 4xx answers pass through untouched (a 404 is a real answer — never stale-masked);
//   only 5xx / transport failure may serve stale.
// · Bypass: ?nocache=1 or Cache-Control: no-cache (ops escape hatch).
// · Never throws: a DO failure with no stale copy surfaces as a plain 503 JSON — an honest
//   degradation the frontend's fail-soft banners already know how to render.
// · Injectable clock for table-driven tests; entries pruned on insert; hard entry cap.

export type CachePolicy = { ttlMs: number; staleMs: number };

/** ttl = fresh window; stale = extra window where the copy may serve on DO failure only. */
const POLICY_TABLE: Record<string, CachePolicy> = {
  "/state": { ttlMs: 5_000, staleMs: 300_000 },
  "/population": { ttlMs: 5_000, staleMs: 300_000 },
  "/annals": { ttlMs: 30_000, staleMs: 600_000 },
  "/bourse": { ttlMs: 30_000, staleMs: 600_000 },
  "/meme/snapshot": { ttlMs: 60_000, staleMs: 600_000 },
  "/war": { ttlMs: 30_000, staleMs: 600_000 },
  "/telemetry": { ttlMs: 30_000, staleMs: 600_000 },
  "/economy": { ttlMs: 60_000, staleMs: 600_000 },
  "/leaderboard": { ttlMs: 60_000, staleMs: 600_000 },
  "/market": { ttlMs: 10_000, staleMs: 300_000 },
  "/predictions": { ttlMs: 30_000, staleMs: 600_000 },
  "/arena": { ttlMs: 30_000, staleMs: 600_000 },
  "/proofs": { ttlMs: 60_000, staleMs: 600_000 },
  "/stimuli": { ttlMs: 30_000, staleMs: 600_000 },
  "/announcements": { ttlMs: 120_000, staleMs: 600_000 },
  "/manifest": { ttlMs: 300_000, staleMs: 3_600_000 },
};
const POLICY_PREFIX: Array<{ prefix: string; policy: CachePolicy }> = [
  { prefix: "/flies/", policy: { ttlMs: 5_000, staleMs: 60_000 } },
  { prefix: "/snapshot", policy: { ttlMs: 5_000, staleMs: 60_000 } },
  { prefix: "/lineage", policy: { ttlMs: 60_000, staleMs: 600_000 } },
  { prefix: "/execution/logs", policy: { ttlMs: 10_000, staleMs: 60_000 } },
];

const MAX_BODY_BYTES = 512 * 1024;
const MAX_ENTRIES = 64;

type Entry = {
  body: string;
  status: number;
  contentType: string;
  storedAt: number;
  policy: CachePolicy;
};

export function policyFor(path: string): CachePolicy | null {
  const exact = POLICY_TABLE[path];
  if (exact) return exact;
  for (const { prefix, policy } of POLICY_PREFIX) {
    if (path.startsWith(prefix)) return policy;
  }
  return null;
}

export function makeEdgeCache(now: () => number = Date.now) {
  const entries = new Map<string, Entry>();

  function prune(t: number): void {
    for (const [k, e] of entries) {
      if (t - e.storedAt > e.policy.ttlMs + e.policy.staleMs) entries.delete(k);
    }
    while (entries.size > MAX_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, e] of entries) {
        if (e.storedAt < oldestAt) { oldestAt = e.storedAt; oldestKey = k; }
      }
      if (oldestKey === null) break;
      entries.delete(oldestKey);
    }
  }

  function replay(entry: Entry, kind: "hit" | "stale"): Response {
    const headers = new Headers();
    headers.set("Content-Type", entry.contentType);
    headers.set("X-Cache", kind);
    headers.set("Cache-Control", "no-store");
    return new Response(entry.body, { status: entry.status, headers });
  }

  return {
    /** test/ops introspection */
    get size(): number { return entries.size; },
    clear(): void { entries.clear(); },

    /**
     * The wrapper the worker forwards through. `doFetch` runs only on fresh-miss.
     * CORS re-application stays the caller's job (unchanged contract with index.ts).
     */
    async wrap(request: Request, path: string, doFetch: () => Promise<Response>): Promise<Response> {
      const url = new URL(request.url);
      const bypass =
        request.method !== "GET" ||
        url.searchParams.has("nocache") ||
        (request.headers.get("Cache-Control") ?? "").includes("no-cache");
      const policy = bypass ? null : policyFor(path);
      if (!policy) return doFetch();

      const key = path + (url.search || "");
      const t = now();
      const cached = entries.get(key) ?? null;
      if (cached && t - cached.storedAt <= cached.policy.ttlMs) {
        return replay(cached, "hit");
      }
      try {
        const resp = await doFetch();
        if (resp.status >= 500) {
          if (cached && t - cached.storedAt <= cached.policy.ttlMs + cached.policy.staleMs) {
            return replay(cached, "stale");
          }
          return resp;
        }
        if (!resp.ok) return resp;                       // 4xx: a real answer — pass through
        const body = await resp.text();
        if (body.length <= MAX_BODY_BYTES) {
          entries.set(key, {
            body,
            status: resp.status,
            contentType: resp.headers.get("Content-Type") ?? "application/json",
            storedAt: t,
            policy,
          });
          prune(now());
        }
        const headers = new Headers(resp.headers);
        headers.set("X-Cache", "miss");
        return new Response(body, { status: resp.status, headers });
      } catch (e) {
        // The DO is unreachable (quota wall, isolate crash, network). Serve the stale copy
        // when one exists — the page keeps its honest last-good state instead of a 1101.
        if (cached && t - cached.storedAt <= cached.policy.ttlMs + cached.policy.staleMs) {
          return replay(cached, "stale");
        }
        return new Response(
          JSON.stringify({ ok: false, error: "upstream-unavailable", detail: (e as Error)?.message ?? String(e) }),
          { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
        );
      }
    },
  };
}

export const edgeCache = makeEdgeCache();
