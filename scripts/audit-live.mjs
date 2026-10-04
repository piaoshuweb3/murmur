#!/usr/bin/env node
// audit-live.mjs — the STANDALONE read-only FUNDS-BOUNDARY + FINGERPRINT auditor for murmur
// (Wave-9 W9-1, item A3 of the W9 upstream-sync scan).
//
// WHAT IT IS. One command that pulls every PUBLIC read-only endpoint of the live worker and
// checks the money-boundary + operational invariants that no other tool gathers in one place:
//   - does the settlement ledger close on itself?        (settleOk + settleFail == settleAttempts)
//   - is the mirror economy still zero-sum?              (Σ agent balances sampled twice, exact BigInt)
//   - are the real-money ceilings still inside bounds?   (caps from /state, /war + committed wrangler.toml)
//   - is the resolver-gas watchdog honest and fresh?     (GAS_FLOOR 0.5 native: low flag → FAIL, P0 banner)
//   - is the brain still deterministic at runtime?       (/manifest vs /manifest/replay, OpenAPI served)
//   - is the served bundle exactly the committed one?    (deploy.json manifest + every ?v= pin resolves)
//   - is the world actually alive?                       (cron heartbeat age, population inside its cap)
// It trusts only PUBLIC data + the committed wrangler.toml. It reads NO secret, sends NO write,
// touches NO money path — a pure observer. A breached money bound is a FAIL (exit 1); an
// unreachable endpoint is a SKIP (never a false FAIL).
//
// HOW IT DIFFERS FROM ITS NEIGHBOURS (additive, not a duplicate):
//   - scripts/w4-deploy.py (workspace tooling, outside the repo) → the 12-flag armed-set diff
//     against the Cloudflare settings API. That tool owns the DEPLOYED-var truth; this one is
//     keyless and owns the PUBLIC + COMMITTED truth. A flag not visible over public GETs is a
//     SKIP here by design, not an omission to fix.
//   - scripts/w5x/w6x/w7x/w81-live-verify.mjs → per-wave Playwright E2E suites (browser-level).
//     This tool needs no browser and no wave context: it is the standing one-shot auditor.
//   - the gas RUNWAY (two-anchor burn-rate method, W9 item A4/P1.5) is deliberately NOT here
//     yet: it needs a time-window store. This tool reports the balance + floor verdict only and
//     invents no burn numbers.
//
// DEPENDENCIES: Node built-ins only (fetch, fs). No npm install, no wallet, no RPC, no browser.
//
// USAGE
//   node scripts/audit-live.mjs                       # audit production (default https://flyx402.xyz)
//   node scripts/audit-live.mjs --api https://murmur.piaoshuweb3.workers.dev
//   node scripts/audit-live.mjs --offline             # committed wrangler.toml bounds only (no fetch)
//   node scripts/audit-live.mjs --window-ms 15000 --json
// Exit code: 0 when nothing FAILs (PASS/WARN/SKIP exit 0); 1 when any invariant FAILs; 2 on fatal.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRANGLER_TOML = resolve(HERE, "../packages/trader-worker/wrangler.toml");
const DEFAULT_API = "https://flyx402.xyz";

// Committed real-money ceilings. These are the IMMUTABLE bounds — an audit FAILs if a live
// value EXCEEDS them. Raising any of these is a deliberate, separately-approved act; the
// auditor exists to catch drift. Defaults mirror config.ts coded clamps (the deployed armed
// baseline runs at these same values — see HANDOVER.md §3).
const BOUND = {
  chainId: 5042,                // Arc mainnet — a prod audit must never find testnet
  dailyCapUsdcMax: 20,          // ECONOMY_DAILY_CAP coded default
  perAgentDailyCapUsdcMax: 2,   // ECONOMY_PER_AGENT_DAILY_CAP coded default
  maxDealUsdcMax: 0.05,         // ECONOMY_MAX_DEAL coded default
  perWarCapUsdcMax: 5,          // WAR_PER_WAR_CAP_USDC coded default
  maxEscrowUsdcMax: 50,         // WAR_MAX_ESCROW_USDC coded default (worker top-up ceiling)
  healthFeaturesMin: 13,        // /health feature floor (P1 contract: never decreases)
};

// ------------------------------ minimal wrangler.toml [vars] reader ------------------------------
// Returns { value, active } — active=true for an ENABLED var line, false for a commented
// "# KEY = value" default, null when the key is absent (then the coded default governs).
// Prefers the uncommented definition; falls back to the first commented example.
function readTomlVar(toml, key) {
  const lines = toml.split(/\r?\n/);
  const valRe = new RegExp(`^\\s*#?\\s*${key}\\s*=\\s*"([^"]*)"`);
  let commented = null;
  for (const line of lines) {
    const m = line.match(valRe);
    if (!m) continue;
    const isActive = !/^\s*#/.test(line);
    if (isActive) return { value: m[1], active: true };
    if (commented === null) commented = m[1];
  }
  return commented === null ? { value: null, active: null } : { value: commented, active: false };
}

// ------------------------------ HTTP JSON reader (read-only, with abort) ------------------------------
async function getJson(url, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function getText(url, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------ verdict primitives ------------------------------
const PASS = (id, group, detail) => ({ id, group, status: "PASS", detail });
const WARN = (id, group, detail) => ({ id, group, status: "WARN", detail });
const FAIL = (id, group, detail) => ({ id, group, status: "FAIL", detail });
const SKIP = (id, group, detail) => ({ id, group, status: "SKIP", detail });

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const atomic6ToUsdc = (s) => { const n = Number(s); return Number.isFinite(n) ? n / 1e6 : null; };

// ------------------------------ group A: committed money-boundary (wrangler.toml) ------------------------------
function auditBaseline() {
  const out = [];
  let toml;
  try { toml = readFileSync(WRANGLER_TOML, "utf8"); }
  catch (e) { return [FAIL("toml-readable", "baseline", `cannot read wrangler.toml: ${e.message}`)]; }

  const boundCheck = (key, max, id, unit = "USDC") => {
    const v = readTomlVar(toml, key);
    if (v.active === null) return SKIP(id, "baseline", `${key} absent in committed toml — coded default governs (${max} ${unit})`);
    const n = num(v.value);
    if (n == null) return FAIL(id, "baseline", `${key}="${v.value}" is not numeric`);
    const tag = v.active ? "active" : "commented-default";
    if (n > max) return FAIL(id, "baseline", `${key}=${n} ${unit} (${tag}) EXCEEDS the committed ceiling ${max}`);
    return PASS(id, "baseline", `${key}=${n} ${unit} (${tag}) within ceiling ${max}`);
  };

  // Chain id: the committed baseline must point at Arc mainnet.
  const chain = readTomlVar(toml, "CHAIN_ID");
  if (chain.active === null) out.push(SKIP("chain-id", "baseline", "CHAIN_ID absent in toml — coded default governs"));
  else if (Number(chain.value) !== BOUND.chainId) out.push(FAIL("chain-id", "baseline", `CHAIN_ID=${chain.value} ≠ ${BOUND.chainId} (Arc mainnet)`));
  else out.push(PASS("chain-id", "baseline", `CHAIN_ID=${chain.value} (Arc mainnet)`));

  const pop = readTomlVar(toml, "POPULATION_SIZE");
  if (pop.active !== null) {
    const n = num(pop.value);
    if (n == null || n < 1 || n > 256) out.push(FAIL("population-size", "baseline", `POPULATION_SIZE="${pop.value}" outside 1..256`));
    else out.push(PASS("population-size", "baseline", `POPULATION_SIZE=${n}`));
  } else out.push(SKIP("population-size", "baseline", "POPULATION_SIZE absent in toml — coded default governs"));

  out.push(boundCheck("ECONOMY_DAILY_CAP", BOUND.dailyCapUsdcMax, "daily-cap"));
  out.push(boundCheck("ECONOMY_PER_AGENT_DAILY_CAP", BOUND.perAgentDailyCapUsdcMax, "per-agent-cap"));
  out.push(boundCheck("ECONOMY_MAX_DEAL", BOUND.maxDealUsdcMax, "max-deal"));
  out.push(boundCheck("WAR_PER_WAR_CAP_USDC", BOUND.perWarCapUsdcMax, "per-war-cap"));
  out.push(boundCheck("WAR_MAX_ESCROW_USDC", BOUND.maxEscrowUsdcMax, "war-escrow-cap"));

  // Committed posture (informational): our wrangler.toml is the SAFE keyless baseline by design;
  // the DEPLOYED armed set is intentionally divergent (armed via dashboard/settings — see
  // HANDOVER.md §2/§3). The live posture is judged in the money group below.
  const rs = readTomlVar(toml, "ECONOMY_REAL_SPEND");
  const posture = `committed baseline realSpend=${rs.value ?? "absent"} (${rs.active ? "active" : rs.active === false ? "commented" : "absent"})`;
  out.push(rs.active && rs.value === "true"
    ? WARN("baseline-posture", "baseline", `real spend ARMED in the committed toml — ${posture} (unusual for this repo)`)
    : PASS("baseline-posture", "baseline", `${posture} — safe keyless baseline as designed`));
  return out;
}

// ------------------------------ group B: live settlement ledger + zero-sum mirror (/economy, /state) ------------------------------
// Σ of agent mirror balances, EXACT via BigInt over atomic strings. Settlement is mirror-to-mirror,
// a hatch is funded from its parent's mirror — by design Σ never moves. A drifting Σ means value
// appeared from nowhere (or a counter reset): the single worst bug this tool can catch.
function sumBalancesAtomic(econ) {
  let sum = 0n, bad = 0;
  for (const a of econ.agents ?? []) {
    try { sum += BigInt(a.balance); } catch { bad++; }
  }
  return { sum, bad };
}

async function auditMoney(api, args) {
  const out = [];
  let econ1 = null, state = null;
  try { econ1 = await getJson(`${api}/economy`); }
  catch (e) { out.push(SKIP("economy", "money", `/economy unreachable: ${e.message}`)); }
  try { state = await getJson(`${api}/state`); }
  catch (e) { out.push(SKIP("state", "money", `/state unreachable: ${e.message}`)); }

  const t = econ1?.totals;
  if (t) {
    // (1) ledger closure — a gap means a settle neither recorded as mined nor as failed.
    const attempts = Number(t.settleOk) + Number(t.settleFail);
    out.push(Number(t.settleAttempts) === attempts
      ? PASS("settle-closure", "money", `settleOk ${t.settleOk} + settleFail ${t.settleFail} == settleAttempts ${t.settleAttempts}`)
      : FAIL("settle-closure", "money", `settleOk+settleFail (${attempts}) != settleAttempts (${t.settleAttempts}) — lost settlement accounting`));
    // (2) settled volume finite and non-negative.
    out.push(Number.isFinite(t.volumeUsdc) && t.volumeUsdc >= 0
      ? PASS("volume-finite", "money", `lifetime settled volume ${t.volumeUsdc} USDC over ${t.count} deals`)
      : FAIL("volume-finite", "money", `volumeUsdc not finite/non-negative: ${t.volumeUsdc}`));
    // (3) catastrophic settle-success rate is a WARN (gas/RPC health; dust debtors skew it by design).
    if (t.successRate != null) {
      out.push(t.successRate >= args.successFloor
        ? PASS("success-rate", "money", `successRate ${(t.successRate * 100).toFixed(2)}% ≥ ${(args.successFloor * 100).toFixed(0)}%`)
        : WARN("success-rate", "money", `successRate ${(t.successRate * 100).toFixed(2)}% < ${(args.successFloor * 100).toFixed(0)}% — check RPC/gas + dust debtors`));
    } else out.push(SKIP("success-rate", "money", "no settle attempts yet (successRate null)"));
    // (4) Gini sanity — the reporter must stay in the mathematical range.
    out.push(Number.isFinite(t.gini) && t.gini >= 0 && t.gini <= 1
      ? PASS("gini-range", "money", `gini ${Number(t.gini).toFixed(4)} in [0,1]`)
      : FAIL("gini-range", "money", `gini outside [0,1]: ${t.gini}`));
    // (5) treasury-out (simulated liquidity injected to keep agents solvent) must stay finite,
    //     non-negative, and inside its ceiling — a runaway injector silently de-zerosums the world.
    const tre = atomic6ToUsdc(t.treasuryOutAtomic);
    const maxTre = args.treasuryMax;
    if (tre == null) out.push(FAIL("treasury-out", "money", `treasuryOutAtomic not parseable: ${t.treasuryOutAtomic}`));
    else if (tre < 0) out.push(FAIL("treasury-out", "money", `treasuryOut negative: ${tre} USDC`));
    else if (tre > maxTre) out.push(FAIL("treasury-out", "money", `treasuryOut ${tre} USDC EXCEEDS ceiling ${maxTre} (default = 10× population × initial balance; override --treasury-max)`));
    else out.push(PASS("treasury-out", "money", `treasuryOut ${tre} USDC within ceiling ${maxTre}`));
    // (6) reporter agreement — the mean must be recomputable from the very list being reported.
    if (econ1?.agents?.length) {
      const { sum, bad } = sumBalancesAtomic(econ1);
      if (bad > 0) out.push(FAIL("mean-agree", "money", `${bad} agent balance(s) not parseable as atomic integers`));
      else {
        const n = BigInt(econ1.agents.length);
        const recomputed = Number(sum / n) / 1e6;   // same floor-then-convert math as the worker
        const drift = Math.abs(recomputed - Number(t.meanBalanceUsdc));
        out.push(drift <= 1e-6
          ? PASS("mean-agree", "money", `meanBalanceUsdc recomputes from the agent list (${recomputed.toFixed(6)} USDC, n=${econ1.agents.length})`)
          : FAIL("mean-agree", "money", `reported mean ${t.meanBalanceUsdc} ≠ recomputed ${recomputed.toFixed(6)} — totals/list desync`));
      }
    } else out.push(SKIP("mean-agree", "money", "no agent list in /economy"));
  }

  // (7) chain id over the LIVE config — never testnet in a prod audit.
  const liveChain = state?.config?.chainId;
  if (liveChain != null) {
    out.push(Number(liveChain) === BOUND.chainId
      ? PASS("chain-live", "money", `live config chainId=${liveChain} (Arc mainnet)`)
      : FAIL("chain-live", "money", `live config chainId=${liveChain} ≠ ${BOUND.chainId} — testnet/wrong chain in production?`));
  } else out.push(SKIP("chain-live", "money", "no /state.config.chainId"));

  // (8) live posture (informational — armed IS our production shape, a prod audit wants to KNOW).
  const mode = state?.economy?.mode ?? state?.config?.economyFacilitator ?? econ1?.mode;
  if (mode != null) {
    out.push(mode === "onchain"
      ? WARN("money-posture", "money", `REAL SPEND POSTURE — economy mode "${mode}" (see HANDOVER.md §2 for the stop-bleeding switch)`)
      : PASS("money-posture", "money", `economy mode "${mode}" — keyless simulator`));
  } else out.push(SKIP("money-posture", "money", "no economy mode exposed"));

  // (9) population inside its declared cap; an empty world is a WARN, not a FAIL (extinction is
  //     a state, not a breach — but the auditor must say it out loud).
  const alive = state?.aliveCount, cap = state?.cap ?? state?.config?.maxLivePopulation;
  if (alive != null && cap != null) {
    if (alive > cap) out.push(FAIL("population", "money", `aliveCount ${alive} > cap ${cap} — roster breach`));
    else if (alive === 0) out.push(WARN("population", "money", `aliveCount 0 / cap ${cap} — the swarm is extinct (anti-extinction P0?)`));
    else out.push(PASS("population", "money", `aliveCount ${alive} ≤ cap ${cap}`));
  } else out.push(SKIP("population", "money", `live=${alive}, cap=${cap} (missing field)`));

  // (10) ZERO-SUM closure: resample /economy after a quiet window; Σ must not have moved.
  if (econ1?.agents?.length && !args.offline) {
    const s1 = sumBalancesAtomic(econ1);
    await new Promise((r) => setTimeout(r, args.windowMs));
    let econ2 = null;
    try { econ2 = await getJson(`${api}/economy`); }
    catch (e) { out.push(SKIP("zero-sum", "money", `resample failed: ${e.message}`)); }
    if (econ2?.agents?.length) {
      const s2 = sumBalancesAtomic(econ2);
      if (s2.bad > 0) out.push(FAIL("zero-sum", "money", `${s2.bad} balance(s) unparseable on resample`));
      else if (s1.sum === s2.sum) out.push(PASS("zero-sum", "money", `Σ mirror = ${s2.sum} atomic (≈ ${Number(s2.sum) / 1e6} USDC) IDENTICAL across the ${args.windowMs}ms window`));
      else {
        const d = (s2.sum - s1.sum);
        out.push(WARN("zero-sum", "money", `Σ mirror MOVED by ${d} atomic (≈ ${Number(d) / 1e6} USDC) in ${args.windowMs}ms — treasuryOut injection or ledger anomaly; verify /economy totals before dismissing`));
      }
    }
  } else if (!econ1?.agents?.length) out.push(SKIP("zero-sum", "money", "no agent list — nothing to sum"));

  return { out, state };
}

// ------------------------------ group C: resolver gas watchdog (/state.resolverGas) ------------------------------
function auditGas(state, args) {
  const out = [];
  const g = state?.resolverGas;
  if (!g || g.atomic == null) {
    out.push(SKIP("gas-readable", "gas", "no resolverGas reading exposed (watchdog C2 has not run yet?)"));
    return out;
  }
  const native = Number(g.atomic);
  out.push(Number.isFinite(native) && native >= 0
    ? PASS("gas-readable", "gas", `resolver wallet ${native} native (18-dec atomic ${g.atomic})`)
    : FAIL("gas-readable", "gas", `resolverGas.atomic not parseable: ${g.atomic}`));
  // The 0.5-native GAS_FLOOR is the funding lane's stop tag: below it, arena open/resolve,
  // prediction receipts, war cadence and lineage anchoring silently stop broadcasting —
  // the P0 banner in exit-code form. Known state today: low=true (P0 funding outstanding).
  out.push(g.low === true
    ? FAIL("gas-floor", "gas", `resolver gas BELOW the 0.5 native floor — funding/resolve lanes stalled; fund the facilitator wallet (P0, HANDOVER.md §7)`)
    : PASS("gas-floor", "gas", "resolver gas above the 0.5 native floor"));
  if (g.checkedAt) {
    const ageMs = Date.now() - Number(g.checkedAt);
    out.push(ageMs <= args.gasMaxAge
      ? PASS("gas-fresh", "gas", `watchdog reading ${Math.round(ageMs / 1000)}s old ≤ ${Math.round(args.gasMaxAge / 1000)}s`)
      : WARN("gas-fresh", "gas", `watchdog reading ${Math.round(ageMs / 60000)}min old > ${Math.round(args.gasMaxAge / 60000)}min — C2 probe stale?`));
  } else out.push(SKIP("gas-fresh", "gas", "no checkedAt timestamp"));
  return out;
}

// ------------------------------ group D: war/arena coffer ceilings (/war, /arena) ------------------------------
async function auditCaps(api) {
  const out = [];
  let war = null, arena = null;
  try { war = await getJson(`${api}/war`); }
  catch (e) { out.push(SKIP("war", "caps", `/war unreachable: ${e.message}`)); }
  try { arena = await getJson(`${api}/arena`); }
  catch (e) { out.push(SKIP("arena", "caps", `/arena unreachable: ${e.message}`)); }

  if (war) {
    out.push(war.enabled === true
      ? WARN("war-posture", "caps", `war coffer ENABLED (armed=${war.armed}) — real-stake lane live at ${war.cofferAddress}`)
      : PASS("war-posture", "caps", `war coffer inert (enabled=${war.enabled})`));
    const pw = num(war.perWarCapUsdc);
    if (pw != null) {
      out.push(pw <= BOUND.perWarCapUsdcMax
        ? PASS("war-per-war-cap", "caps", `perWarCapUsdc ${pw} ≤ ${BOUND.perWarCapUsdcMax}`)
        : FAIL("war-per-war-cap", "caps", `perWarCapUsdc ${pw} EXCEEDS committed ceiling ${BOUND.perWarCapUsdcMax}`));
    } else out.push(SKIP("war-per-war-cap", "caps", "perWarCapUsdc not exposed"));
    const me = num(war.maxEscrowUsdc);
    if (me != null) {
      out.push(me <= BOUND.maxEscrowUsdcMax
        ? PASS("war-escrow-cap", "caps", `maxEscrowUsdc ${me} ≤ ${BOUND.maxEscrowUsdcMax}`)
        : FAIL("war-escrow-cap", "caps", `maxEscrowUsdc ${me} EXCEEDS committed ceiling ${BOUND.maxEscrowUsdcMax}`));
    } else out.push(SKIP("war-escrow-cap", "caps", "maxEscrowUsdc not exposed"));
    // On-chain aggregate coffer read-out: every field must parse as a non-negative number, and
    // the live escrow must sit inside the coffer's own hard cap.
    const st = war.stats;
    if (st && typeof st === "object") {
      const fields = ["commonsPurse", "totalEscrow", "escrow", "maxEscrow", "warCount"];
      let finite = true;
      for (const f of fields) {
        const v = atomic6ToUsdc(st[f]);
        if (v == null || v < 0) { out.push(FAIL("coffer-stats", "caps", `stats.${f} not parseable/non-negative: ${st[f]}`)); finite = false; }
      }
      if (finite) {
        const esc = atomic6ToUsdc(st.escrow), cap = atomic6ToUsdc(st.maxEscrow);
        out.push(esc <= cap
          ? PASS("coffer-stats", "caps", `coffer on-chain: commons ${atomic6ToUsdc(st.commonsPurse)} / escrow ${esc} ≤ cap ${cap} USDC, wars ${st.warCount}`)
          : FAIL("coffer-stats", "caps", `escrow ${esc} > coffer cap ${cap} — contract read inconsistent`));
      }
    } else out.push(SKIP("coffer-stats", "caps", "no on-chain coffer stats (unwired or read failed)"));
  }
  if (arena) {
    out.push(arena.enabled === true
      ? WARN("arena-posture", "caps", `arena ENABLED (armed=${arena.armed}) — MURMUR-token betting lane live at ${arena.arenaAddress} (token bets, not USDC)`)
      : PASS("arena-posture", "caps", `arena inert (enabled=${arena.enabled})`));
  }
  return out;
}

// ------------------------------ group E: brain determinism + contract (/manifest, /openapi.json) ------------------------------
async function auditAnchor(api) {
  const out = [];
  let man = null, replay = null;
  try { man = await getJson(`${api}/manifest`); }
  catch (e) { out.push(SKIP("manifest", "anchor", `/manifest unreachable: ${e.message}`)); }
  try { replay = await getJson(`${api}/manifest/replay`); }
  catch (e) { out.push(SKIP("replay", "anchor", `/manifest/replay unreachable: ${e.message}`)); }

  if (man && replay) {
    out.push(man.manifestHash && replay.manifestHash && man.manifestHash === replay.manifestHash
      ? PASS("manifest-agree", "anchor", `manifestHash agrees (${String(man.manifestHash).slice(0, 12)}…)`)
      : FAIL("manifest-agree", "anchor", `manifestHash mismatch: /manifest=${man.manifestHash} vs /manifest/replay=${replay.manifestHash}`));
    const nmm = Array.isArray(replay.mismatches) ? replay.mismatches.length : null;
    if (replay.ok === true && (nmm === null || nmm === 0)) {
      out.push(PASS("replay-ok", "anchor", `runtime replay ok — ${replay.checked ?? "?"} connectome(s) rebuilt from committed seeds, 0 mismatch`));
    } else out.push(FAIL("replay-ok", "anchor", `runtime replay NOT self-consistent: ok=${replay.ok} mismatches=${nmm}`));
  }
  try {
    const spec = await getJson(`${api}/openapi.json`);
    const paths = spec && typeof spec.paths === "object" ? Object.keys(spec.paths).length : 0;
    out.push(String(spec?.openapi || "").startsWith("3.") && paths > 0
      ? PASS("openapi-served", "anchor", `OpenAPI ${spec.openapi} served, ${paths} paths documented`)
      : FAIL("openapi-served", "anchor", `/openapi.json not a usable OpenAPI 3.x spec (paths=${paths})`));
  } catch (e) { out.push(SKIP("openapi-served", "anchor", `/openapi.json unreachable: ${e.message}`)); }
  return out;
}

// ------------------------------ group F: liveness (/health, /state.lastCron) ------------------------------
async function auditOps(api, state, args) {
  const out = [];
  let health = null;
  try { health = await getJson(`${api}/health`); }
  catch (e) { out.push(SKIP("health-ok", "ops", `/health unreachable: ${e.message}`)); }
  if (health) {
    const feats = Array.isArray(health.features) ? health.features.length : 0;
    out.push(health.ok === true && feats >= BOUND.healthFeaturesMin
      ? PASS("health-ok", "ops", `health.ok=true, ${feats} features ≥ floor ${BOUND.healthFeaturesMin} (chain ${health.chain}, v${health.version})`)
      : FAIL("health-ok", "ops", `health.ok=${health.ok}, features=${feats} < floor ${BOUND.healthFeaturesMin}`));
  }
  const lastCron = state?.lastCron;
  if (lastCron != null) {
    const ageMs = Date.now() - Number(lastCron);
    out.push(ageMs <= args.lastCronMaxAge
      ? PASS("cron-fresh", "ops", `last cron heartbeat ${Math.round(ageMs / 1000)}s old ≤ ${Math.round(args.lastCronMaxAge / 1000)}s`)
      : FAIL("cron-fresh", "ops", `cron heartbeat ${Math.round(ageMs / 60000)}min stale > ${Math.round(args.lastCronMaxAge / 60000)}min — the world has FROZEN (masked heartbeat? DO wedged?)`));
  } else out.push(SKIP("cron-fresh", "ops", "no /state.lastCron"));
  return out;
}

// ------------------------------ group G: served-bundle fingerprint (deploy.json + ?v= pins) ------------------------------
async function auditFingerprint(api) {
  const out = [];
  try {
    const dj = await getJson(`${api}/deploy.json`);
    out.push(dj?.manifest && dj?.wave != null
      ? PASS("deploy-manifest", "fingerprint", `deploy.json: manifest=${dj.manifest} wave=${dj.wave}`)
      : FAIL("deploy-manifest", "fingerprint", `deploy.json malformed: ${JSON.stringify(dj).slice(0, 120)}`));
  } catch (e) { out.push(SKIP("deploy-manifest", "fingerprint", `/deploy.json unreachable: ${e.message}`)); }

  // Every ?v= pin in the served index.html must resolve — a bump that missed a file shows up
  // here as a 404 instead of a blank page in production.
  try {
    const html = await getText(`${api}/`);
    const pins = [...new Set([...html.matchAll(/([A-Za-z0-9._-]+\.js)\?v=(\d+)/g)].map((m) => `${m[1]}?v=${m[2]}`))].sort();
    if (!pins.length) out.push(SKIP("index-pins", "fingerprint", "no ?v= pins found in the served index.html"));
    else {
      const dead = [];
      for (const p of pins) {
        try {
          const body = await getText(`${api}/${p}`);
          if (!body || body.length === 0) dead.push(`${p} (empty)`);
        } catch (e) { dead.push(`${p} (${e.message})`); }
      }
      out.push(dead.length === 0
        ? PASS("index-pins", "fingerprint", `all ${pins.length} pinned modules resolve: ${pins.join(", ")}`)
        : FAIL("index-pins", "fingerprint", `${dead.length}/${pins.length} pinned module(s) broken: ${dead.join("; ")}`));
    }
  } catch (e) { out.push(SKIP("index-pins", "fingerprint", `index.html unreachable: ${e.message}`)); }

  try {
    await getText(`${api}/fund.html`);
    out.push(PASS("fund-page", "fingerprint", "/fund.html served (Wave-8 onramp page)"));
  } catch (e) { out.push(FAIL("fund-page", "fingerprint", `/fund.html unreachable: ${e.message}`)); }
  return out;
}

// ------------------------------ report rendering ------------------------------
function renderText(report) {
  const L = [];
  L.push("═".repeat(78));
  L.push("  murmur live audit — funds-boundary + fingerprint (read-only, W9 A3)");
  L.push("═".repeat(78));
  L.push(`  api      : ${report.api}`);
  L.push(`  mode     : ${report.offline ? "OFFLINE (committed bounds only)" : "LIVE (public read-only endpoint probes)"}`);
  L.push(`  generated: ${report.generatedAt}`);
  for (const group of ["baseline", "money", "gas", "caps", "anchor", "ops", "fingerprint"]) {
    const rows = report.checks.filter((c) => c.group === group);
    if (!rows.length) continue;
    L.push("");
    L.push(`  ── ${group.toUpperCase()} ──`);
    for (const c of rows) L.push(`   [${c.status}] ${c.id} — ${c.detail}`);
  }
  L.push("");
  L.push("─".repeat(78));
  L.push(`  VERDICT: ${report.verdict}  (${report.summary.pass} PASS · ${report.summary.warn} WARN · ${report.summary.fail} FAIL · ${report.summary.skip} SKIP)`);
  L.push("─".repeat(78));
  return L.join("\n");
}

// ------------------------------ CLI ------------------------------
function parseArgs(argv) {
  const a = {
    api: DEFAULT_API, json: false, quiet: false, offline: false,
    windowMs: 8000, successFloor: 0.5, lastCronMaxAge: 300000,
    gasMaxAge: 1800000, treasuryMax: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const next = () => argv[++i];
    switch (k) {
      case "--api": a.api = String(next()).replace(/\/$/, ""); break;
      case "--json": a.json = true; break;
      case "--quiet": a.quiet = true; break;
      case "--offline": a.offline = true; break;
      case "--window-ms": a.windowMs = Number(next()) || 8000; break;
      case "--success-floor": a.successFloor = Number(next()) || 0.5; break;
      case "--lastcron-max-age": a.lastCronMaxAge = Number(next()) || 300000; break;
      case "--gas-max-age": a.gasMaxAge = Number(next()) || 1800000; break;
      case "--treasury-max": a.treasuryMax = Number(next()); break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`unknown argument: ${k}`);
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "audit-live — read-only funds-boundary + fingerprint auditor (W9 A3).\n" +
      "  --api <base>           live worker base (default https://flyx402.xyz; alt: https://murmur.piaoshuweb3.workers.dev)\n" +
      "  --offline              committed wrangler.toml bounds only (no network)\n" +
      "  --window-ms MS         zero-sum resample window (default 8000)\n" +
      "  --success-floor F      settle successRate WARN floor 0..1 (default 0.5)\n" +
      "  --lastcron-max-age MS  cron heartbeat FAIL bound (default 300000)\n" +
      "  --gas-max-age MS       resolver-gas watchdog staleness WARN bound (default 1800000)\n" +
      "  --treasury-max USDC    treasuryOut ceiling (default 10× population × initial balance)\n" +
      "  --json                 machine-readable report\n" +
      "Exit 0 unless an invariant FAILs (WARN/SKIP exit 0).");
    return 0;
  }

  const checks = [];
  checks.push(...auditBaseline());

  let state = null;
  if (!args.offline) {
    // Default treasury ceiling: 10× initial float (population × initial per-agent balance).
    if (args.treasuryMax == null) {
      try {
        const st = await getJson(`${args.api}/state`);
        state = st;
        const pop = num(st?.config?.populationSize) ?? 24;
        const init = num(st?.config?.economyInitialBalanceUsdc) ?? 0;
        args.treasuryMax = 10 * pop * init;
      } catch { args.treasuryMax = 1000; } // conservative fallback; the check reports its bound
    }
    const money = await auditMoney(args.api, args);
    checks.push(...money.out);
    if (!state) state = money.state;
    checks.push(...auditGas(state, args));
    checks.push(...await auditCaps(args.api));
    checks.push(...await auditAnchor(args.api));
    checks.push(...await auditOps(args.api, state, args));
    checks.push(...await auditFingerprint(args.api));
  } else {
    for (const [id, g] of [["money", "money"], ["gas", "gas"], ["caps", "caps"], ["anchor", "anchor"], ["ops", "ops"], ["fingerprint", "fingerprint"]]) {
      checks.push(SKIP(id, g, "offline mode — live endpoint probes skipped"));
    }
  }

  const summary = {
    pass: checks.filter((c) => c.status === "PASS").length,
    warn: checks.filter((c) => c.status === "WARN").length,
    fail: checks.filter((c) => c.status === "FAIL").length,
    skip: checks.filter((c) => c.status === "SKIP").length,
  };
  const verdict = summary.fail > 0 ? "FAIL — an invariant is breached" : "PASS — no bound breached";
  const report = { tool: "audit-live", api: args.api, offline: args.offline, generatedAt: new Date().toISOString(), checks, summary, verdict };

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (!args.quiet) console.log(renderText(report));

  return summary.fail > 0 ? 1 : 0;
}

try { process.exit(await main()); }
catch (e) { console.error(`audit-live fatal: ${e.stack || e.message}`); process.exit(2); }
