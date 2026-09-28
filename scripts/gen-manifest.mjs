#!/usr/bin/env node
// Wave-6 R3 — the deploy manifest: a deterministic content hash of everything we serve.
// Hashes every file under packages/frontend/public/ (deploy.json itself excluded — it
// carries the hash), writes public/deploy.json. Same inputs → same manifest, so the chip
// on the page, the repo and the served bundle stay mutually verifiable (upstream shows a
// "connectome manifest" chip; ours is the same honesty, our own hash).
// Run: node scripts/gen-manifest.mjs   (before `wrangler deploy`; commit the output)
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("../packages/frontend/public/", import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (!p.endsWith("deploy.json")) files.push(p);
  }
})(ROOT);
files.sort();

const h = createHash("sha256");
for (const f of files) {
  h.update(relative(ROOT, f).split(sep).join("/"));
  h.update(createHash("sha256").update(readFileSync(f)).digest());
}
const manifest = h.digest("hex").slice(0, 8);

let prev = null;
try { prev = JSON.parse(readFileSync(join(ROOT, "deploy.json"), "utf8")); } catch { /* first run */ }
const next = { manifest, wave: prev?.wave ?? "6" };
writeFileSync(join(ROOT, "deploy.json"), JSON.stringify(next, null, 2) + "\n");
console.log(`deploy.json: manifest=${manifest} (${files.length} files hashed, wave=${next.wave})`);
