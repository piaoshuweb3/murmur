# Changelog

All notable changes to **murmur** are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> murmur is the continuation of the former *Immortal Fruit Flies* experiment, rebuilt from a BSC token-trading bot
> into an **agent economy on Arc** that now settles **real USDC on mainnet**. The legacy trading stack was removed
> wholesale; see `0.2.0` below, and `[Unreleased]` for the go-live.

> **Current live numbers — single source of truth.** Each fly runs a **10,800-neuron** production LIF connectome
> (the `@fly/fly-brain` library *default* is 1,080; production overrides it via `BRAIN_N_*`). The population
> **founds at 24 and breeds live toward a 48 cap** (`EVOLUTION_MAX_LIVE_POPULATION`) — 24 is genesis, not a fixed
> cast. **437 unit tests** pass (47 `fly-brain` + 366 `trader-worker` + 24 `arc-circle-x402`, post-merge). The dated entries
> below are historical snapshots and legitimately reflect the smaller values of their own release.

## [Unreleased] — P0/P1 sync (2026-09-24)

### Added (P1 sync — upstream-mechanism-inspired, own implementations; ALL flag-gated, default OFF)
- **⑲ The Bourse (`BOURSE_ENABLED`)**: one READ-ONLY `eth_getLogs` per cron over OUR MURMUR token's Transfer
  logs → `BourseMeter` folds a 0..1 tape FEVER against slow EWMA baselines and edge-detects four narratable
  moments (FEVER_BREAKOUT / WHALE_MOVE / TREASURY_MILESTONE / LONG_SILENCE) into chronicle kinds
  COIN_FEVER / WHALE_MOVE / TREASURY_FLOW / COIN_SILENCE. Our own redesign: the upstream TITHE leg is replaced
  by a TREASURY-INFLOW leg (transfers INTO the ADMIN treasury), and treasury-out legs (airdrops) are excluded
  from every statistic so a distribution can never pollute the tape. Optional feeling leg
  (`TOKEN_STIMULUS_ENABLED`) rides the four EXISTING visitor stimulus channels, hard-capped (`cap 0.35`) —
  a whale can whisper to the swarm; no fortune can command it. `GET /bourse` serves the last cron's read-out.
- **The Faith Membrane (`RELIGION_ENABLED`)**: prophets / covenants / holy days / schisms — a pure chronicle
  read-out of the economy's own faded reputations + strong bonds + gini + this tick's deaths
  (`economy.faithSignals()`). Lifetime prophet registry prevents cap-trim re-founding churn. ≤ 4 sects × ≤ 8 members, DO-persisted, worker-only.
- **The Laureate (`POET_ENABLED`)**: deterministic neuron-born poems — no LLM, no clock, no RNG; every N crons
  (`POET_EVERY_TICKS`) the era/chronicle/market seed a 4–8 line verse crowning the richest living fly, hashed
  (sha256) and kept in a 50-poem ledger. `GET /poem`.
- **① Neural feedback bus (`SOCIAL_STIMULUS_ENABLED`)**: the historian's own era folds back into the swarm as
  bounded stimuli on the four EXISTING visitor channels (no new sensory channel ⇒ the manifest hash never
  rotates), hard-capped (`cap 0.3`).
- **Ages fast clock (`AGES_FAST_CLOCK`)**: bond/grudge half-lives shrink ~5× (30k/90k → 6k/18k sub-ticks) —
  social memory churns on the swarm's own clock.
- **Frontend (P0+P1)**: parchment announcement bar (dismissable, `announcements.json`-driven, 7-language),
  our token CA chip + reserved X-link seat on the homepage, two-stage chronicle codex (rail → full-height
  volume pages), Bourse / Faith / Laureate volumes, era HUD, `transparency.html` (six contracts + ADMIN +
  verification paths), poll load-shed (6s→12s, /annals 200→120).

### Changed (P0 — durability & settlement hygiene, always-on)
- **DO freeze governance**: every coordinator→shard RPC is now bound with `AbortSignal.timeout` (advance 45 s,
  light RPCs 15 s) and a saturated shard DEGRADES to its last-good read-out instead of hanging the cron at the
  wall; `cron()` force-persists the clock (tick/lastCron/prevTemp) before rethrowing any pre-persist error;
  the scheduled cron self-call is bounded (600 s); `GET /history` is served worker-direct from D1 (off the DO's
  input queue, DO path kept as fallback); frontend main poll 6 s→12 s.
- **Settlement exponential backoff**: a pair whose on-chain broadcast failed gets a retry window that doubles
  per consecutive failure (capped at 30 sub-ticks ≈ 5 crons), so a persistently failing pair can no longer burn
  the flush budget every cron. Success clears the streak. Kills the settleFail hot-loop.

### Security
- All new layers are pure read-outs: no genome, no connectome, no wiring, no ledger, no settlement touched;
  the brain manifest hash NEVER rotates (bourse/faith/poet/feedback-bus are worker-only with flags OFF ⇒
  byte-identical default behaviour). Zero upstream third-party addresses anywhere; treasury observations point
  exclusively at OUR deployments. chroniclerRulesHash rotates (new templates) — it is an informational
  fingerprint, not an on-chain commitment; old entries still verify (their templates are unchanged).


### Added — CLOUD DEPLOYMENT EXECUTED & LIVE (Cloudflare Workers free tier · workers.dev + FLYX402.XYZ · full C0→R4-4 sequence green)
- **Live URLs**: `https://murmur.piaoshuweb3.workers.dev` (24-48h canary window), **`https://flyx402.xyz`** + `https://www.flyx402.xyz` (custom domains, auto-provisioned DNS+SSL, sub-100ms). `workers_dev = true` pinned so the canary URL survives alongside custom routes.
- **C0 cold start**: D1 database `murmur-db` created + `database_id` wired into `wrangler.toml`, `schema.sql` applied remotely, first keyless-safe-baseline deploy passed 4/4 smoke asserts (`/health`, keyless simulator, same-origin UI, `/api` prefix).
- **C1/C2 admin + onchain shadow**: `ADMIN_TOKEN` generated (openssl, stored only in gitignored `.env.local`) and `ECONOMY_MNEMONIC` injected via stdin pipe (never displayed); `POST /reset` re-derived **24 real checksummed HD agents** + gas wallet `0x20c5…53f3`; cron verified healthy (tickIndex advancing 6/cron, `lastCron` live).
- **R4-1→R4-4 armed ON THE CLOUD** via `deploy --var` chains (the committed `wrangler.toml` stays at the safe baseline — a plain redeploy reverts to keyless-simulated by design, fail-safe): arena write path live from the edge — **round 497268 opened and 497267 resolved on-chain**, WAR/EVOLUTION(+treasury=ADMIN)/COMMUNITY all armed and smoke-verified.
- **Free-tier 64-var budget fix**: `wrangler.toml` trimmed 73→56 vars by unpinning entries byte-identical to `src/config.ts` code defaults (MEME×2, EXECUTION×9, Circle×3, CULTURE/INSTITUTIONS/EPOCHS×3) with knowledge-preservation comments at each removal site; `CONFLICT_ENABLED="true"` kept pinned (code default is `false`). Budget: 56 + 2 secrets + 4 arming vars = 62 ≤ 64.
- **Measured burn**: 0.0021 USDC / 5 min steady-state ⇒ **0.606 USDC/day** (matches the 0.7/day projection) ⇒ ~177 days runway on the remaining 4.476 USDC gas balance.

### Added — R4-1→R4-4 FLAGS ARMED & VERIFIED (arena write path LIVE on-chain; cloud deployment staged)
- **R4-1 COMPLETE — arena write path live on Arc mainnet**: local resolver arming (`ECONOMY_FACILITATOR=onchain + ECONOMY_SHADOW=false + ECONOMY_REAL_SPEND=true`, seeded from the offline `.env.local` operational seed) opened **PredictionArena round 497266 on-chain** (tx blk 22331349, gas 0.0018 USDC) with baseline temp 0.586434 / flat band 0.008 committed and the betting window live; `scripts/r4-1-arm-verify.mjs` re-reads `roundInfo()` from the chain and asserts (4/4 PASS). Receipt anchoring also observed: 7 decisive prediction rounds committed to `NeuralReceiptRegistry` (~0.0021 USDC each) — cloud-cadence burn projects to ≈0.7–1 USDC/day, arena ≈0.05/day ⇒ ~4.7 days runway on the current 4.96 USDC gas balance.
- **R4-2 WAR flag verified live** (`/war` → `enabled:true, armed:true`, coffer `0x37a6…9f9C0`, treasury = keyless ADMIN `0x1068…58B1`, resolver = facilitator, immutable 50-USDC cap surfaced; house escrow deposits stay honestly-rejected until agent wallets are funded — F-1 design).
- **R4-3 EVOLUTION flag verified live** (`/lineage` → `evolution.enabled:true`, breeding fee 0.002 USDC payable to `EVOLUTION_TREASURY = 0x1068…58B1`, 24 genesis genomes listed, globalDailyMax=4).
- **R4-4 COMMUNITY flag verified live** (`/community` → 200, MURMUR token-gated, zero-funds path).
- **Same-origin single-URL deployment**: `[assets]` block in `wrangler.toml` ships `packages/frontend/public` straight from the Worker (asset GET/HEADs are free; unmatched paths run the script), and the Worker router now strips the frontend's default `/api` prefix (`/api/state === /state`) — one workers.dev URL serves UI + API with zero CORS config and no separate Pages project. Rollback = delete the `[assets]` block.
- **Local arming/rollback tooling**: `scripts/arm-dev-r41.sh` + `scripts/arm-dev-flags.sh` + `scripts/disarm-dev-r41.sh` (idempotent `.dev.vars` block editors; mnemonic piped from `.env.local`, never displayed); `scripts/r4-1-arm-verify.mjs` (chain-side proof).
- **Repo identity moved to the own fork**: `package.json` repository/bugs → `github.com/piaoshuweb3/murmur`, homepage → `https://flyx402.xyz`.
- **Cloud deployment**: blocked only by the provided Cloudflare API token being read-only (verified: `/accounts` + D1/KV/Pages/Workers reads OK; script PUT + D1 create → `No access`/auth error). One-shot arming script `scripts/cloud-deploy-flyx402.sh` stages the full C0→C1→C2→R4 sequence (D1 create → id inject → schema → deploy → checks → ADMIN_TOKEN → mnemonic secret → onchain shadow → reset → REAL_SPEND → per-flag deploy+smoke) for the moment an edit-capable token lands.

### Added — R4-0 ADDRESS WIRING EXECUTED & PASSED (mainnet six-contract read-path live, 38/38 asserts)
- **All six mainnet contract addresses wired into `wrangler.toml [vars]`** (per R3 report §5): registry/manifest/lineage/war(+treasury+cap)/arena(+token)/community-token. Four money flags (`WAR/EVOLUTION/COMMUNITY`) remain `"false"`; `ECONOMY_REAL_SPEND` stays `"false"`.
- **`ARENA_ENABLED="true"`** (R4-1 flag): the arena read-path is live — `/arena` returns `enabled:true` with the deployed PredictionArena `0x0243…16B60` + own MURMUR token, and the frontend drawer now renders the live-book framework (read-only mode label), wallet connect, and the swarm-vs-human stats (43k+ rounds, 24 bettors) instead of the previous "isn't enabled" empty state. Live rounds still await resolver arming (documented two-option decision: shadow-phase conclusion on Cloudflare, or explicit local arming with the economy-freeze + gas-amplification caveats).
- **Read-only smoke tooling**: `scripts/r4-0-smoke.mjs` — 28 chain asserts (bytecode ×6, constructor read-back ×13, USDC precompile `decimals()==6` probe documenting the unit convention shared by the Worker settlement layer and WarCoffer's immutable 50e6 cap, facilitator gas/token balances, nine-address disjointness) + 10 HTTP asserts (`/health` features, `/arena` payload, `/state` adminWallet, frontend `/api` proxy). All green after worker restart.
- **New tooling**: `scripts/export-facilitator-key.mjs` — user-run, offline BIP-44 private-key export (`--check` mode prints address-only verification; `--show` prints the key to the user's own terminal only, never to any AI/chat context), with a built-in `privateKeyToAccount` round-trip self-check.
- **Docs**: `docs/murmur-功能实现总结与上云部署建议.md` (14-feature implementation matrix, Cloudflare-vs-VPS-vs-Vercel architecture verdict, domain purchase/binding playbook, R4-1 arming decision with gas math); rehearsal manual §R4 status + §6 address ledger filled.
### Added — R3 MAINNET DEPLOYMENT EXECUTED & PASSED (six contracts live on Arc mainnet 5042, 29/29 asserts, gas 0.0567 USDC)
- **Six contracts deployed to Arc MAINNET** (chainId 5042) by facilitator `0x20c54D8Fa205af293181833b46494d97d54753f3`
  (BIP-44 index 2,000,000 of the operational seed; funded 5.05 USDC, spent 0.056659): MurmurToken
  `0x43D8…B490` (1B one-shot mint to keyless ADMIN `0x1068…58B1`), NeuralReceiptRegistry `0x87F6…fc34`,
  NeuralManifestRegistry `0x6caC…20e` (+ production-brain commit `0x403551bb…f6efc02` anchored only after the
  offline 24-fly replay reproduced every structural spec), ConnectomeLineage `0xCbe9…aB07`, WarCoffer
  `0x37a6…9f9C0` (usdc = native precompile `0x3600…0000`, immutable 50-USDC cap, 3-day stale grace), and
  PredictionArena `0x0243…16B60` (token = our own MURMUR). Every constructor arg re-read from chain by the
  orchestrator and asserted; per-contract opcode-accurate PUSH20 scan = zero blacklist hits
  (8 upstream addresses + prefix set). Evidence: `scripts/r3-run-log.json`,
  report: `docs/murmur-R3-主网部署报告.md` (includes the R4 flag-opening checklist).
- **Sovereignty hardening patches (pre-deploy)**: `deploy-arena-auto.mjs` no longer carries any upstream MURMUR
  fallback address — it refuses to deploy without an explicit own-token `ARENA_TOKEN`;
  `deploy-registry-auto.mjs` gained the missing mainnet gate `REGISTRY_CONFIRM=1` (aligning it with the other
  five) plus `RPC_URL`/`REGISTRY_COMMITTER` env merge; frontend token-CA display, openapi example and test
  fixtures now point at our own deployed MURMUR (zero user-visible upstream token references remain).
- **New tooling**: `scripts/r3-fund-verify.mjs` (read-only preflight: chainId, balance, funding tx receipt,
  seed-derivation == funded address, blacklist scan) and `scripts/r3-mainnet-deploy.mjs` (sequential six-unit
  orchestrator with `*_CONFIRM` gates, independent on-chain read-back asserts, PUSH20 sovereignty scan, gas
  ledger, and **resume mode** — already-deployed units are re-verified and skipped, never re-deployed).
- **Status**: all four money flags (`WAR/EVOLUTION/COMMUNITY/ARENA_ENABLED`) remain `"false"` and
  `ECONOMY_REAL_SPEND="false"`; wiring + flag flips are worker-config-only steps (R4 checklist), each with a
  smoke test and an instant rollback. Cloudflare secrets/deploy stay in the user's own CF credentialed
  environment per the cloud runbook C2.

### Added — R2 testnet rehearsal EXECUTED & PASSED (71/71 asserts on real Arc testnet, 0 fourth-party addresses)
- **R2 executed end-to-end on the real Arc testnet** (`rpc.testnet.arc.io`, chainId 5042002, blocks
  63459412→63460064, gasPrice 25 gwei, native gas = USDC): all ten deployments (six contracts with production
  params + two 90s-grace stale drill instances + circulating-replica MurmurToken + MockUSDC) landed and every
  constructor arg was read back and asserted. The full money map drilled on a real-sleep timeline:
  MurmurToken one-shot mint to keyless ADMIN, x402 EIP-3009 breeding fee 1.0 USDC → TREASURY(ADMIN) and
  royalty 0.5 → on-chain breeder, WarCoffer deposit(50 USDC cap hit exactly)→declare(power locked on-chain)→
  resolve(deterministic winner recomputed locally == contract roll)→levyTax→sweep→anyone-can-expire 90s stale
  refund, PredictionArena UP/FLAT/stale rounds with Σpayout==Σstake and zero house take.
  **19 ledgered transfers, every from/to inside the whitelisted role set, violations=0; ADMIN had zero
  outflows all run (the ADMIN key does not exist anywhere on the machine); WarCoffer escrow outflow count = 0;
  full-contract bytecode PUSH20 scan = zero upstream addresses.** Evidence: `scripts/r2-run-log.json`,
  report: `docs/murmur-R2-测试网资金流向审计报告.md`.
- **Native-USDC precompile write path PROVEN on testnet** (R3 decision input): real `transfer` + EIP-3009
  `transferWithAuthorization` settlement (0.3 USDC → ADMIN) both succeeded against `0x3600…0000` — R3 can point
  WarCoffer/breeding fees straight at native USDC with no asset-contract deployment.
- **Three real-chain migration bugs found & fixed in the rehearsal script (not in contracts)**: DEPLOYER wallet
  used before declaration; real-timeline deadline ladder (anvil time-jumps don't exist on a live chain —
  12s deadlines died to block+RPC latency, now 45/70/90/95/110s); a transcribed `balanceOf` targeting the arena
  itself; plus a strengthened settle-order assertion (post-claim escrow == round-2 open stake proves zero payout
  leakage). Contract behavior matched R1 byte-for-byte — 6 contracts unchanged across two environments,
  138 assertions total.
- Measured economics for R3: full testnet drill ≈2.7 USDC gas (budget 2.73 hit exactly); mainnet six-contract
  deploy ≈0.09–0.5 USDC equivalent. Faucet gas for R2 fully consumed at zero real cost.
- docs/murmur-合约部署彩排手册.md §R2: readiness block → results block (explorer-linked deployment table).

### Added — R2 testnet rehearsal STAGED (historical; superseded by the EXECUTED block above)
- **R2 toolkit landed**: `scripts/r2-rehearsal.mjs` (the R1 seven-act script made cheat-code-free for a real
  chain: real-sleep timeline instead of `evm_increaseTime`, delta-based balance assertions instead of fork
  absolutes, ADMIN stays keyless — production MurmurToken(treasury=ADMIN) is deployed and asserted untouched
  all run, a clearly-labelled circulating replica (treasury=BETTOR_A) drives the arena, stale paths drill on
  dedicated 90s-grace mini instances while production instances keep the 3-day/50-USDC params) +
  `scripts/r2-keygen.mjs` (one-shot rehearsal keys → gitignored `.env.local`, addresses only in logs).
- Preflight exits cleanly with `NEED_MORE_GAS` (exit 2) until funded — zero state pollution.

### Added — R1 local-fork fund-flow rehearsal EXECUTED & PASSED (67/67 asserts, 0 fourth-party addresses)
- **R1 executed end-to-end** against `anvil --fork-url https://rpc.mainnet.arc.io` (fork @ 22190776): all six
  contracts + rehearsal asset deployed with production params (maxEscrow=50 USDC immutable, resolver =
  mnemonic-derived facilitator idx 2,000,000, treasury = `0x1068…58B1` address-only), then the full money
  map drilled: MurmurToken one-shot mint → x402 EIP-3009 breeding fee → TREASURY and royalty → on-chain
  breeder; WarCoffer deposit→declare→resolve(deterministic winner re-computed locally, matches contract
  roll)→levyTax→sweep→anyone-can-expire stale refund; PredictionArena UP/FLAT/stale rounds with
  Σpayout==Σstake (zero house take) and exact refunds. **17 ledgered transfers, every from/to inside
  {TREASURY, RESOLVER, bettors, winner vault, escrows}; WarCoffer outflows = 0; arena pays bettors only.**
- **docs/murmur-R1-资金流向审计报告.md**: the fund-flow audit report (per-transfer ledger, conservation
  matrix, 13-row negative-permission & sovereignty matrix, findings F1–F3, R2 checklist).
- **Rehearsal tooling (reusable for R2)**: `scripts/r1-lib.mjs` (assert engine, transfer ledger, EIP-3009
  signing, contract-exact winner recomputation, opcode-level PUSH20 address-constant scanner) +
  `scripts/r1-rehearsal.mjs` (the seven-act script) + `scripts/r1-run-log.json` (raw evidence).
- **`contracts/MockUSDC.sol` + `compile-mock.mjs`**: rehearsal/testnet USDC stand-in with FiatTokenV2-
  compatible EIP-3009 (`transferWithAuthorization`, `AuthorizationUsed`, domain name "USDC" version "2"),
  zero-dependency, mint faucet, **rehearsal/testnet only — never mainnet**. Needed because finding F1
  below: Arc's USDC precompile is read-replicable on anvil forks but all writes revert (node-native layer);
  real-USDC write verification moves to R2 on a real testnet node.

### Added — contract-deployment rehearsal program kicked off (100% sovereignty track)
- **docs/murmur-合约部署彩排手册.md**: the six-stage full-path rehearsal plan (R0 local artifacts → R1 anvil
  fork drill → R2 Arc testnet → R3 mainnet deploy → R4 wiring+flags → R5 canary→full), with the sovereignty
  audit table, the participant/funds matrix (DEPLOYER / RESOLVER / TREASURY all inside the deployment's own
  wallet system `0x1068…58B1`), per-stage rollback valves, the deployment address ledger template, and the
  red-line negative list (no upstream contracts, no third-party libs, no owner backdoors).
- **Sovereignty audit of all six contracts (green)**: zero hardcoded addresses, zero external imports
  (no OpenZeppelin — hand-rolled Solidity only), all MIT, resolver/treasury purely constructor-injected,
  no owner transfer / pause / selfdestruct. Upstream sample addresses remain excluded at every layer.
- **Artifact #0 — `MurmurToken.sol` + `compile-murmur.mjs` + `deploy-murmur-auto.mjs`**: the deployment's
  OWN ERC-20 (Arena denomination + community gate), zero-dependency house style, FIXED supply minted once
  to the treasury then the mint path ceases to exist; no pause / no blacklist / no owner / no re-mint.
  Treasury defaults to `0x1068…58B1` (overridable); mainnet deploys gated behind `MURMUR_CONFIRM=1`;
  post-deploy self-verifies name/symbol/decimals/totalSupply/treasury balance and persists the address.
  All six contracts compile clean on solc 0.8.37 (artifacts in `contracts/build/`).

### Merged — upstream `EvolutionDeep/murmur` 53 commits (base `b53c83a` → `origin/main`), red-line discipline
- **True three-way merge** (graft at the zip-snapshot base, not a hand-carry): the upstream war/tax layer,
  territory grid, autonomous evolution + breeding market, deterministic chronicler (annals), culture /
  institutions / epochs layers, community forum, OpenAPI 3.1 contract, full i18n rewrite (5 languages,
  dotted keys, `t as T`), five new D1 tables and 233 new tests all landed. Suite grew **204 → 437/437 green**;
  typecheck clean.
- **Sovereignty red-lines enforced on the merge (the point of this exercise)**:
  - Upstream's LIVE config was NOT copied: `EVOLUTION_TREASURY = 0x307D…3a0d` (upstream deployer's breeding-fee
    wallet), `WAR_ADDRESS = 0x3d90…454b`, `MANIFEST_REGISTRY_ADDRESS = 0x3412…29a37`,
    `LINEAGE_ADDRESS = 0x482b…8096f` are all **excluded**; every wallet-bearing var ships commented with
    the deployment's OWN admin wallet (`0x1068…58B1`) pre-filled.
  - Upstream's armed production switches (`WAR_ENABLED/WAR_BOOTSTRAP/CONFLICT_ENABLED = "true"`,
    `ECONOMY_SHADOW = "false"`) ship **off** here — merged default behaviour is byte-for-byte the pre-merge
    shadow baseline; new sim layers are one-flag experiments for later.
  - Frontend default API base cut from `https://api.muros.live` → same-origin `/api`; developers.html,
    community.js/ts, openapi.ts, deploy scripts and the shipped contract-address records scrubbed of upstream
    domains/addresses (docs keep upstream history where it is purely narrative).
- **二次开发 features ported onto the rewritten frontend**: the EXECUTION LOG drawer (four safety flag chips,
  filter rail, 15s poll) and the declared admin-wallet row are re-attached to the i18n shell with `exec.*`
  dictionary keys (en + zh; other languages fall back to en). Chain badges (solana/base/eth) survive the port;
  verified in-browser: 19 D1 shadow records + three-chain badges render post-merge.
- **Merge adaptations**: upstream's new routes call our F-6 two-arg `corsHeaders(request, env)`; our F-3
  origin-derived `signalRequirements(economy, origin)` kept over upstream's 1-arg reversion; our F-5
  admin-gated `/stimulus` kept alongside upstream's `/annals` + `/breed` (admin-gated).
- **Fixed upstream's own typo while merging**: `wrangler.toml` shipped `[igrations]]` (broken TOML) twice —
  now `[[migrations]]`; a `wrangler deploy` from a pristine upstream clone would have failed parsing.

### Fixed — 2026-09-22 post-merge UI triage (three drawers, three root causes)
- **Prediction market drawer showed "disabled"**: the merged `wrangler.toml` carried `PREDICT_ENABLED = "false"`
  (its comment is an onchain-arming note, not a shadow-mode one). Flipped to `"true"` — the fly swarm now stakes
  **simulated** USDC parimutuel every cron (`mode: simulated`, zero real funds; commit fails soft with no registry).
  Verified in-browser: live book, odds, 13+ neural stakes and resolutions all render (round #3 open at triage time).
- **Seven new-layer switches silently ignored (wrangler.toml section bug)**: the whole 合并专项 block
  (`CULTURE_/INSTITUTIONS_/EPOCHS_/CONFLICT_/EVOLUTION_/WAR_/COMMUNITY_ENABLED`) had been appended *after*
  `[observability]`, so TOML folded every key into that table and wrangler warned-and-dropped them — each switch
  fell back to its code default instead of the intended value. Block moved back above the first section header;
  culture / institutions / epochs / conflict now explicitly `"true"` (pure sim, zero money paths — the chronicle
  volumes stay populated), evolution / war / community stay `"false"` pending own-contract deployment.
- **Chronicle drawer opened into nothing on short viewports**: the legacy `@media (max-width: 680px), (max-height: 600px)`
  stack still listed `.panel-chron` as a relative-positioned in-flow panel, but upstream converted the chronicle
  into a fixed `.drawer` — the opened drawer landed past the viewport bottom (embedded previews are typically
  <600px tall, so it looked like the button did nothing). `.panel-chron` removed from the stack; it now behaves
  like every other drawer. Verified at 1280×550 and 1440×900: full codex, seven volumes, era badge, entries.
- **`.chron-tab[hidden]` was cosmetic-only**: `.chron-tab { display: grid }` overrode the UA `[hidden]` default,
  so the JS-hidden War-Coffer tab still rendered (and opened an empty volume). Added an explicit
  `.chron-tab[hidden] { display: none; }`; also repaired two corrupted selectors from the merge
  (`.epitaphidden]` → `.epitaph[hidden]`, `.cron-warnidden]` → `.cron-warn[hidden]`).
- **Arena drawer**: opens correctly and shows the upstream onboarding copy — it is *designed* to stay dark until
  a self-deployed PredictionArena + `ARENA_ENABLED` exist; no code change (deployment-gated, not a bug).

### Changed
- **Shadow-watch cadence raised for the P1-1 observation window**: local ticker 30s → 20s per cron
  (`scripts/shadow-ticker.sh`, ~2.5× headroom over the 6–8s tick — no overlap) and the frontend
  execution-log drawer poll 30s → 15s (`EXEC_POLL_MS`). Signal thresholds deliberately UNTOUCHED —
  shadow-experiment integrity stays intact; activity comes from more samples, not a looser gate.

### Added
- **Base (EVM) meme channel armed locally** (.dev.vars): `MEME_SOURCE_BASE="dexscreener"` +
  `MEME_WATCHLIST_BASE` = BRETT / VIRTUAL / DEGEN / TOSHI (verified 2026-09-20 Base deep pools,
  $0.85M–$4.27M liquidity). Signals, shadow intents and exit rules flow through the exact same
  execution layer as Solana — zero code paths added.
- **ETH mainnet meme channel armed locally** (.dev.vars): `MEME_SOURCE_ETH="dexscreener"` +
  `MEME_WATCHLIST_ETH` = PEPE ($29.7M) / SPX6900 ($12.4M) / MOG (canonical 2023 pool, $5.4M) —
  impostor contracts (2026 re-pools riding the same tickers) screened out via pair-creation-age +
  real-volume checks. First live ETH + Base shadow fills landed within one tick of arming.
- **Chain badge in the EXECUTION LOG drawer** (frontend): every record now renders a per-chain pill
  (`solana` purple / `base` blue / `eth` indigo) so multi-chain signal provenance is visible at a glance.

## [v1.4.0] — 2026-09-19 · 二次开发迭代：安全审计整改 —— 自托管就绪（Self-hosting ready）

### Security (audit remediation — docs/murmur-安全审计报告-SECURITY-AUDIT.md)
- **F-1 safe defaults**: `ECONOMY_REAL_SPEND` code default flips `true → false` — a fresh deployment that
  only sets a mnemonic can never broadcast real USDC; arming is now an explicit final step. wrangler.toml
  re-based to the keyless safe phase: `ECONOMY_FACILITATOR="simulated"`, `ECONOMY_SHADOW="true"`, explicit
  `ECONOMY_REAL_SPEND="false"`, `PREDICT_ENABLED="false"`, `ARENA_ENABLED="false"`,
  `ECONOMY_CIRCLE_FACILITATOR="off"`.
- **F-2 upstream bindings removed**: the committed production route (api.muros.live), the upstream D1
  database_id, NeuralReceiptRegistry / PredictionArena / MURMUR token contract addresses and upstream
  wallet references are replaced with ①②③-marked placeholders plus step-by-step own-domain / own-D1 /
  own-contract instructions.
- **F-3 payment resource de-hardcoded**: `signalRequirements()` no longer advertises a hardcoded upstream
  domain — it resolves `SIGNAL_RESOURCE` (optional override) else derives from the incoming request origin,
  so a self-hosted deployment naturally advertises its own `/signal/pulse`.
- **F-5 stimulus gate (opt-in)**: new `STIMULUS_ADMIN_ONLY="true"` puts `POST /stimulus` behind the same
  ADMIN_TOKEN guard as `/tick` + `/reset` (recommended on public self-hosts; default `false` = upstream
  behaviour, byte-for-byte).
- **F-6 CORS whitelist (opt-in)**: new `CORS_ALLOW_ORIGINS` (comma-separated). When set, only whitelisted
  Origins receive an `Access-Control-Allow-Origin` header; unset keeps the legacy reflect-any-Origin
  behaviour byte-for-byte.
- Test fixtures de-branded (muros.live URLs → neutral example domain).

### Changed
- `/health` + root package.json report version **1.4.0**; README env table re-based to the safe defaults.

## [v1.3.0] — 2026-09-19 · 二次开发迭代：多语种界面 + 终极管理权限钱包

### Added
- **Multilingual interface (6 languages)**: the whole UI is now translatable — 简体中文（默认）/ English / 日本語 /
  한국어 / Español / Français. A new `I18N_UI` dictionary (60+ keys × 6 langs) drives every panel title, button,
  meter scale, execution-log flag/filter/stat, wallet-roster subtitle, status line and the population/drive labels
  via `data-i18n` attributes + a `t()` helper with `{var}` interpolation; the about note gained ES/FR translations.
  A language switcher (now 6 buttons) lives in the about panel and persists to `localStorage["murmur-lang"]`.
  Missing strings fall back to English; switching re-renders every cached dynamic string live.
- **In-app usage-guide drawer ("guide 📚" in the top bar)**: a detailed 7-section help center rendered from a
  per-language `HELP` dictionary — what murmur is, the interface map, interactions, the execution log & shadow mode,
  safety rails, the ultimate-admin wallet, and language switching — available in all 6 languages.
- **`ADMIN_WALLET` — the declared ultimate-admin wallet (终极管理权限钱包)**: a new, validated config var
  (0x + 40 hex; anything else is ignored with a warning) surfaced read-only via `/state` → `config.adminWallet`
  and rendered as a dedicated **admin** row in the economy panel with one-click copy and an Arc-explorer link.
  It is an ownership/authority declaration only: it holds no keys and never signs — the settlement gas wallet
  remains HD-derived from `ECONOMY_MNEMONIC`. This deployment sets it to
  `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1` (wrangler.toml + .dev.vars); transferring authority is a
  one-line change + redeploy.
- **`docs/使用说明书-USER-GUIDE.md`**: a full six-language user manual (interface map, interactions, shadow-mode
  and safety-rail reference, ADMIN_WALLET semantics, config quick-reference, FAQ) mirroring the in-app guide.

### Changed
- Frontend asset versions bumped (`app.js?v=21`, `styles.css?v=22`); `setStatus` now renders the status line in the
  active language; the execution-log drawer re-translates its flags/stats on language switch; default UI language
  for this deployment is Chinese (stored preference still wins).
- Validation: `tsc --noEmit` clean; the full unit suite passes (153 tests, 0 failures).

## [Unreleased]

### Added
- **Cloud deploy runbook (逐步上云部署手册)**: `docs/murmur-上云部署手册-CLOUD-DEPLOY-RUNBOOK.md` — the step-by-step
  self-hosting guide for v1.4: C0 keyless cold start → C1 admin hardening (ADMIN_TOKEN / CORS / stimulus) →
  C2/C3 economy arming (onchain shadow → real spend) → C4/C5 execution arming (4-flag interlock) → C6 optional
  onchain modules, with per-flag checkpoints (curl assertions + rollback), a one-page flag table and a kill-switch
  runbook. `docs/DEPLOYMENT.md` updated to describe the v1.4 safe baseline instead of the upstream live config.
- **Real unit-test suite (36 tests)** replacing the smoke-only gap: `connectome.test.ts` (laminar FlyWire
  downsample, mutually-inhibitory L2 winner-take-all, per-seed determinism), `lif.test.ts` (leak / spike /
  refractory / synaptic propagation and the spike-frequency-adaptation fatigue that breaks the WTA latch),
  `motor-decoder.test.ts` (two-layer regime + population-relative read-out, hysteresis), and
  `economy.test.ts` (the economy is a strict **one-directional read-out** — a frozen neural input is provably
  unchanged after settling — plus money conservation, determinism and the wallet roster). `npm test` runs them;
  CI gained a `test` gate. `@types/node` added as a dev dependency.
- **Frontend "all agent wallets" drawer**: every fly's own x402 wallet (address, balance, paid/earned, deals) is
  now browsable from the economy panel, alongside the existing per-fly inspector.
- Each real settlement in the ledger links to its transaction on the official **Arc explorer**, so any visitor can
  verify the money moved on-chain.
- **Settlement netting (onchain)**: trades are folded per agent-pair into one signed **net** and only the net is
  broadcast — at most once per cron, above `ECONOMY_NET_MIN_BROADCAST`, with a forced flush every
  `ECONOMY_NET_FLUSH_TICKS`. Reciprocal trades cancel and dust carries forward, so real gas is amortised across
  many micropayments instead of one transaction per trade.
- **Long-term memory (Cloudflare D1)**: `FlyStateDO.archiveTick()` writes one row per cron (temperature, regime,
  deals, cumulative settlements/volume, gini, behaviour histogram) to the `murmur-db` D1 database, and a new
  `GET /history` endpoint serves the series plus a since-launch summary — backing the frontend's **swarm-history**
  drawer and research export.
- **Responsive frontend layout**: the four floating panels collapse into a single scrollable column on phones and
  narrow tablets, so the piece no longer crowds or overlaps on small screens.
- **`ADMIN_TOKEN` guard (optional secret)**: when set, the mutating `POST /tick` and `/reset` debug endpoints
  require it, so they can be locked down on a live deployment. The per-minute cron presents the token
  internally, so arming it never interrupts the scheduled tick.
- **Human-vs-swarm prediction ARENA (`MURMUR` token utility)**: a new `PredictionArena.sol` contract + `GET /arena`
  endpoint + frontend arena drawer let **MURMUR** holders bet the project's own token on the *same* Arc-temperature
  move the fly swarm bets — UP/DOWN into a **non-custodial, parimutuel** book the contract escrows and pays out
  itself. The Worker acts only as the **resolver**, committing each round's entry/exit temperature; the contract
  derives UP/DOWN/FLAT from the committed entry + flat band, so no operator can steer an outcome, and a live
  leaderboard compares the crowd's hit-rate against the flies'. Ships inert-by-default (`ARENA_ENABLED="false"`, no
  `ARENA_ADDRESS`) and in the keyless/simulated fallback; `arena.test.ts` (+19 tests, suite now **89**) pins the
  resolver's round-plan cursor — including the `cursorAfterOpen()` fresh-start baseline that stops a mid-stream first
  open from re-chasing an un-opened `prev` (which the contract reverts `NotOpened`, wasting gas each cron) — and the
  zero-regression gating. Deploy scripts `deploy-arena(-auto).mjs` are confirm-gated for mainnet (`ARENA_CONFIRM=1`).
  **Live on Arc mainnet**: `PredictionArena` at `0xaf1ae61e12c101d179a2f65a5f2e02e690968525` (deploy tx
  `0x187779a2…3f8c`, gas paid by `0x307D…3a0d`), resolver = the Worker facilitator `0x2b9a…055c` opening/resolving each
  hourly bucket; the production Worker runs `ARENA_ENABLED="true"`, first live round `497162` opened on-chain.

### Changed
- **GONE LIVE WITH REAL MONEY.** The production Worker now runs `ECONOMY_FACILITATOR = "onchain"` with
  `ECONOMY_SHADOW = "false"`: agents settle **real USDC on Arc mainnet** via EIP-3009 `transferWithAuthorization`,
  broadcast under the kill switch + daily/per-agent/per-deal caps. The keyless `SimulatedFacilitator` remains only
  as the zero-secret local-dev fallback.
- **De-simulated the messaging everywhere** — README (status, features, architecture, config, disclaimer),
  `package.json` description, `wrangler.toml` comments and the frontend meta/copy now state plainly that these are
  real on-chain transactions, not a simulation.
- Arc RPC transport replaced the naive `fallback` with a **rotating multi-provider pool** (public mainnet endpoints
  plus an optional private `ALCHEMY_ARC_RPC_URL`), per-request timeout-bounded, so a single slow RPC can no longer
  stall the market-temperature read.
- Frontend ledger **de-duplicates settlements by `txHash`**: the fast `/population` poll re-delivers the same cron
  tick many times, so one transaction is now drawn and logged exactly once instead of ~15×.
- Documentation rewritten to describe the actual system (`README.md`, `docs/ARCHITECTURE.md`,
  `docs/NEURAL-SIM.md`, `docs/AGENT-ECONOMY.md`, `docs/DEPLOYMENT.md`).
- **Raised the real-money caps to match the faster trade rate**: `ECONOMY_DAILY_CAP` 20 → **100** and
  `ECONOMY_PER_AGENT_DAILY_CAP` 2 → **10** (the kill switch and the per-deal cap are unchanged).
- **Removed the dead `fly.ai` WASM backend** — `wasm-backend.ts`, the `BRAIN_BACKEND` / `WASM_*` config and the
  `createFlyBrain` factory. It was never invoked at runtime (the population always builds the TypeScript LIF
  connectome) and its `wasm-mock` fabricated a 166,700-neuron count from random noise. `ts-lif` is now the single
  backend.
- **Repository audit**: docs reconciled with the deployed code (netting, D1 `/history`, the corrected cap values),
  a stale "read-only, no wallet" file-header comment corrected, and emoji stripped from the smoke test output.
- Frontend inspector: neural bloom + spike raster are now offscreen-cached and rebuilt a few times per second
  (one `drawImage` blit per frame); the render loop is self-healing with adaptive quality, and pointer input is
  click-storm throttled, so rapid clicking can no longer stall the tab.

### Security
- **Real funds now move on Arc mainnet.** The rails are live and bounding production: kill switch
  (`ECONOMY_REAL_SPEND`), global + per-agent daily caps, a facilitator per-deal cap, and shadow mode as the
  proven-before-broadcast dry run. Note that Arc gas is paid in USDC and can exceed a micropayment's face value,
  so the funded float can net-burn over time.
- Dev-toolchain bump: `wrangler` 3.x → **4.133.0**, clearing all 6 `npm audit` advisories (they lived in the
  `miniflare` → `undici` / `ws` chain — dev/deploy-only, never shipped in the Worker bundle). Re-verified green
  afterwards: typecheck, build, unit tests, neural smoke, and a `wrangler deploy --dry-run` bundle.

## [0.2.0] - 2026-09-17

The **murmur** restart: a population of neural agents settling on Arc, replacing the legacy trading bot.

### Added
- **Market temperature** from Arc whole-chain activity: recent-block tx/gas throughput vs. a self-calibrating EWMA
  baseline, mapped through a logistic curve to a `HOT / CALM / COLD` regime (`market.ts`).
- **Neural population** of 24 flies, each an independent ~1,080-neuron LIF connectome grown from its own seed;
  behaviour decoded *relative to the population* each tick (`population.ts`, `@fly/fly-brain`).
- **x402 agent economy**: drives → economic intent → a faithful x402 `exact` flow between agents, with three data
  goods (`signal` / `momentum` / `attestation`) and atomic 6-decimal USDC accounting (`economy.ts`, `x402.ts`).
- **Keyless `SimulatedFacilitator`** by default (internal ledger, deterministic pseudo tx-hash, zero-address asset)
  plus a documented **`OnChainFacilitator`** seam for real EIP-3009 settlement on Arc's USDC precompile
  (`0x3600…0000`).
- **HD custody** (`keys.ts`): one BIP-39 mnemonic derives all agent wallets (`m/44'/60'/0'/0/{id}`) and the
  facilitator (index 2,000,000).
- **Real-money safety rails**: kill switch (`ECONOMY_REAL_SPEND`), shadow mode (`ECONOMY_SHADOW`), global daily cap,
  per-agent daily cap, and per-deal cap — all inert in simulated mode.
- **Wallet distribution tool** (`packages/trader-worker/scripts/fund-agents.mjs`): dry-run by default, `--send` to
  broadcast; funds the 25 derived addresses from a single vault.
- **Generative frontend** (`murmur`): a living Canvas 2D swarm that warms/cools with the market, with a per-fly
  inspector (neural bloom, spike raster, drives, x402 wallet) and visitor stimulus.
- Deployment on Cloudflare: Worker `murmur` at `api.muros.live` (cron `* * * * *`, `FlyStateDO` SQLite storage) and
  Pages `murmur` (`murmur-4sx.pages.dev`).

### Changed
- Chain target migrated from **BSC (56)** to **Arc mainnet (5042)**, read-only for market data.
- Settlement migrated from a single trading treasury to **per-agent USDC micro-wallets** over x402.
- `FlyBrain` archives bumped to **version 3** with tuned spike-frequency adaptation (`adaptIncrement 0.05`);
  pre-v3 archives wake fresh to escape the winner-take-all latch.

### Removed
- The entire legacy on-chain trading stack: DEX execution (`trader.ts`), swarm cull/reproduce & lineage
  (`swarm.ts`), token selection (`token-select.ts`), the on-chain `NeuralLog.sol` contract and `packages/contracts`,
  the neural-log module, and all `$IFF` / PancakeSwap / BSC configuration, secrets and docs.

### Security
- The project is **keyless and simulated by default**; real settlement requires an explicit operator opt-in
  (`ECONOMY_FACILITATOR="onchain"` + `ECONOMY_MNEMONIC` secret + funded wallets) and is bounded by the rails above.
