// ⑲ The Bourse — "token-exchange weather" for OUR OWN MURMUR token, folded into a fever dial
// plus four narratable moments. Once per cron the caller fetches ONE eth_getLogs page of our
// token's Transfer events (read-only, zero gas, no custody) and this module turns it into:
//
//   · fever        — 0..1 行情热: this tick's community activity vs a slow self-calibrating EWMA
//                    baseline, squeezed through a logistic (ratio 1 = the learned norm = 0.5);
//   · legs         — every transfer routed into exactly one of three buckets (reduceBourseLegs);
//   · narratives   — edge-detected moments: FEVER_BREAKOUT / WHALE_MOVE / TREASURY_MILESTONE /
//                    LONG_SILENCE (at most one event per kind per tick, fixed order ⇒ byte-consistent);
//   · coinStimuli  — the read-out mapped onto the swarm's four sensory channels (food/threat/light/dark).
//
// PROVENANCE / 出自说明: this is an ORIGINAL implementation of the "Bourse" mechanism idea — the
// style borrows from the upstream design we studied in Task 29, the code is 100% ours. 上游机制思想
// 同源、实现自写。本文件不包含、也绝不允许引入任何上游第三方地址：被观察的代币与国库一律由调用方经
// BourseConfig 注入（token = 我们自己的 MURMUR ERC-20 @ Arc mainnet 5042, 18 decimals;
// treasury = 我们自己的 ADMIN 钱包）。Whale threshold、lookback clamp 同样全部是注入参数。
//
// 与上游设计的三点关键差异（our own adaptations, 之所以这样改）:
//   1. TITHE → 国库流入腿. 上游的"什一税"腿观察其代币的隐藏转账税；我们的 MurmurToken 固定供应、
//      无隐藏税（价值捕获在 Arena / WarCoffer 的明面费用里），所以 TITHE 腿不适用 —— 改为观察转入
//      国库地址（to === treasury）的转账，作为"国库进账"叙事。
//   2. 空投防污染. 从国库转出（from === treasury，例如向社区空投）的腿被完全丢弃 —— 既不算
//      community 量、也不算国库流。没有这条规则，我们自己的一次空投就会被误读成"巨鲸砸盘"。
//   3. 鲸鱼/热度只统计"两侧都不是国库"的社区腿；国库自身的收发不扰动 fever 与鲸鱼警报。
//
// SAFETY / 红线. 严格只读：本模块不发交易、不碰任何钱包/私钥、不结算、不写 genome —— 只把链上公开
// 日志折叠成叙事与感官刺激。manifestHash 不轮转（本模块不引入任何新 genome kinds）。纯函数核心不读
// 时钟、不用随机数、不做 I/O：时间戳与日志全部经参数传入，可离线单测、跨引擎字节一致。
// 防女巫由设计兜底（同上游思想）：EWMA 平滑让刷量难以拉满 fever，coinStimuli 的硬上限（cap 0.35）
// 封顶单 tick 刺激强度；同一 tx 的多腿按多腿计数（合约不猜意图），由平滑与上限吸收女巫噪声。
// sampleBourseTransfers 只是 viem getLogs 的薄封装 —— getLogs 区间钳制（lookbackBlocks）由调用方负责。

import { parseAbiItem } from "viem";
import type { PublicClient } from "viem";

// ---------------------------------------------------------------------------
// Config & raw data shapes (everything chain-specific is injected, never hardcoded)
// ---------------------------------------------------------------------------

/** Caller-injected configuration: our token, our treasury, and the observation knobs. */
export interface BourseConfig {
  token: string;          // lowercase token address (our MURMUR ERC-20)
  treasury: string;       // lowercase treasury address (= our ADMIN wallet)
  whaleMinRaw: bigint;    // whale threshold in raw 18-dec units (0 ⇒ whale detection off)
  lookbackBlocks: bigint; // max getLogs span; the CALLER clamps its block range with this
}

/** One decoded Transfer log leg. Addresses as delivered (routing lowercases internally). */
export interface RawTransfer {
  from: string;
  to: string;
  valueRaw: bigint;   // 18-dec raw units
  txHash: string;     // "" if unknown
  blockNumber: bigint;
}

/** One cron tick's worth of transfers, already routed. blockNumber = high-water mark over ALL legs. */
export interface BourseSample {
  blockNumber: bigint;
  community: RawTransfer[];   // both sides ≠ treasury
  treasuryIn: RawTransfer[];  // to === treasury && from !== treasury
}

/**
 * Route one getLogs page into the three legs. 大小写不敏感：先 lowercase 再比较（调用方可能送来
 * checksummed 地址）。Routing precedence is exactly:
 *   1. from === treasury            → DROPPED entirely (airdrop-out 防污染: counts as nothing);
 *   2. to === treasury (from ≠ tr.) → treasuryIn (国库流入腿, our TITHE replacement);
 *   3. otherwise                    → community (both sides non-treasury).
 * Note a treasury→treasury self-transfer hits rule 1 and is dropped. The sample's blockNumber is
 * the max over ALL input legs (including dropped ones) so a caller using it as a scan cursor never
 * re-fetches a page it already folded; empty input folds to blockNumber 0n. Input order is
 * preserved (no sorting) and nothing is mutated — the fold is pure.
 */
export function reduceBourseLegs(all: RawTransfer[], cfg: BourseConfig): BourseSample {
  const treasury = (cfg?.treasury ?? "").toLowerCase();
  const community: RawTransfer[] = [];
  const treasuryIn: RawTransfer[] = [];
  let maxBlock = 0n;

  for (const raw of all ?? []) {
    if (!raw) continue;
    const from = (raw.from ?? "").toLowerCase();
    const to = (raw.to ?? "").toLowerCase();
    if (raw.blockNumber > maxBlock) maxBlock = raw.blockNumber;
    if (from === treasury) continue;                     // rule 1: treasury outflow ⇒ drop (airdrop)
    if (to === treasury) treasuryIn.push(raw);           // rule 2: treasury inflow leg
    else community.push(raw);                            // rule 3: community leg
  }
  return { blockNumber: maxBlock, community, treasuryIn };
}

// ---------------------------------------------------------------------------
// Read-out & narrative events
// ---------------------------------------------------------------------------

export interface BourseEvent {
  kind: "FEVER_BREAKOUT" | "WHALE_MOVE" | "TREASURY_MILESTONE" | "LONG_SILENCE";
  detail: string;
  ts: number;   // caller-supplied tick timestamp (injected — this module never reads a clock)
}

export interface BourseReadOut {
  fever: number;          // 0..1 行情热; cold start = 0.5 (first observation IS the norm)
  txCount: number;        // community legs this tick (same tx twice ⇒ 2 legs; EWMA+cap absorb sybil noise)
  volumeRaw: string;      // community volume this tick, raw 18-dec, decimal string
  treasuryInRaw: string;  // treasury inflow this tick, raw 18-dec, decimal string
  whale: boolean;         // a community leg ≥ whaleMinRaw appeared this tick
  events: BourseEvent[];  // narrative events fired this tick (may be empty)
  silentTicks: number;    // consecutive ticks with zero community legs (cleared after LONG_SILENCE fires)
}

// Tuning knobs (exported so the integrator/tests can read them; the meter itself is parameter-free).
export const FEVER_BREAKOUT_LEVEL = 0.8;            // fever 上穿 0.8 → FEVER_BREAKOUT
export const FEVER_BREAKOUT_RESET = 0.7;            // latch re-arms only below this (hysteresis)
export const LONG_SILENCE_TICKS = 60;               // 连续 60 个无社区活动 tick → LONG_SILENCE
export const TREASURY_MILESTONE_STEP_RAW = 1000n * 10n ** 18n; // 每累计 1000 MURMUR → milestone
export const COIN_STIMULUS_CAP = 0.35;              // coinStimuli hard cap (上游防操纵思想, cap 0.35)

// Internal fever machinery (not exported — behaviour is pinned by tests, not by these numbers).
const FEVER_GAIN = 2.2;           // logistic sharpness around ratio 1
const FEVER_RATIO_MAX = 3.0;      // per-tick ratio clamp before smoothing (bounds a single tick's push)
const FEVER_SMOOTH_ALPHA = 0.35;  // fast EWMA on the ratio — the reason ONE spike can't max the dial
const BASELINE_ALPHA = 0.05;      // slow steady-state baseline learning (tracks the regime)
const BASELINE_EPS = 1e-6;        // dead-baseline guard (division by ~0 ⇒ neutral)
const FEVER_RATIO_TX_W = 0.6;     // how MANY legs happened weighs above …
const FEVER_RATIO_VOL_W = 0.4;    // … how HEAVY they were (market.ts house ratio)

const Q18 = 10n ** 18n;

/**
 * BourseMeter — the stateful side. Holds two slow EWMA baselines (leg count, volume) that
 * self-calibrate to the token's recent "normal", exactly in the spirit of market.ts's MarketMeter,
 * plus a fast-smoothed activity ratio feeding the fever logistic. Persisted inside the Durable
 * Object via toJSON/fromJSON so the learned baseline survives crons and deploys.
 *
 * update() 是纯折叠：sample 与 nowTs 全部由调用方注入，内部无时钟/无随机/无 I/O。
 */
export class BourseMeter {
  private cfg: BourseConfig;
  private primed = false;
  private sampleCount = 0;
  private baselineTx = 0;        // EWMA of community legs/tick (float)
  private baselineVol = 0;       // EWMA of community volume/tick, in whole tokens (float — exact
                                 // raw sums live in the readouts; baselines only need statistics)
  private smoothRatio = 1;       // fast-smoothed activity ratio (fever input)
  private fever = 0.5;
  private breakoutLatched = false;
  private treasuryCumRaw = 0n;   // cumulative treasury inflow since the meter was installed
  private silentTicks = 0;

  constructor(cfg: BourseConfig) {
    this.cfg = {
      token: (cfg?.token ?? "").toLowerCase(),
      treasury: (cfg?.treasury ?? "").toLowerCase(),
      whaleMinRaw: cfg?.whaleMinRaw != null && cfg.whaleMinRaw > 0n ? cfg.whaleMinRaw : 0n,
      lookbackBlocks: cfg?.lookbackBlocks != null && cfg.lookbackBlocks > 0n ? cfg.lookbackBlocks : 0n,
    };
  }

  /** Fold one pre-reduced sample in and emit the read-out (events in fixed kind order). */
  update(sample: BourseSample, nowTs: number): BourseReadOut {
    const community = sample?.community ?? [];
    const treasuryIn = sample?.treasuryIn ?? [];

    // ---- per-tick aggregates (bigint-exact; floats only ever touch statistics) ----
    const txCount = community.length;
    let volumeRaw = 0n;
    for (const leg of community) volumeRaw += leg.valueRaw;
    let treasuryInRaw = 0n;
    for (const leg of treasuryIn) treasuryInRaw += leg.valueRaw;

    // Whale detection: community legs only (国库收发不算鲸鱼 — adaptation #3).
    let whaleLegs: RawTransfer[] = [];
    if (this.cfg.whaleMinRaw > 0n) {
      for (const leg of community) if (leg.valueRaw >= this.cfg.whaleMinRaw) whaleLegs.push(leg);
    }
    const whale = whaleLegs.length > 0;

    // ---- fever: this tick vs the learned norm, EWMA-smoothed so ONE spike can't max the dial ----
    this.sampleCount++;
    const volTokens = volumeRaw === 0n ? 0 : Number(volumeRaw) / 1e18;
    if (!this.primed) {
      // 冷首观测 = 定标: with no history to deviate from, the market starts at exactly 0.5.
      this.baselineTx = txCount;
      this.baselineVol = volTokens;
      this.smoothRatio = 1;
      this.fever = 0.5;
      this.primed = true;
    } else {
      const txRatio =
        this.baselineTx > BASELINE_EPS ? txCount / this.baselineTx : txCount > 0 ? FEVER_RATIO_MAX : 1;
      const volRatio =
        this.baselineVol > BASELINE_EPS ? volTokens / this.baselineVol : volTokens > 0 ? FEVER_RATIO_MAX : 1;
      const ratio = clampNum(FEVER_RATIO_TX_W * txRatio + FEVER_RATIO_VOL_W * volRatio, 0, FEVER_RATIO_MAX);
      this.smoothRatio += FEVER_SMOOTH_ALPHA * (ratio - this.smoothRatio);
      this.fever = logistic(FEVER_GAIN * (this.smoothRatio - 1));
    }
    // Adaptive alpha (1/n at cold start, decaying to the slow steady alpha — market.ts house pattern):
    // the baseline tracks the REGIME, not the spike.
    const aEff = Math.max(BASELINE_ALPHA, 1 / this.sampleCount);
    this.baselineTx += aEff * (txCount - this.baselineTx);
    this.baselineVol += aEff * (volTokens - this.baselineVol);

    // ---- narrative edge detection (fixed order ⇒ byte-consistent event arrays) ----
    const events: BourseEvent[] = [];

    // 1) FEVER_BREAKOUT — rising edge through 0.8, at most once per edge: a latch fires once and
    //    re-arms only after fever falls back below the reset level (hysteresis kills chatter).
    if (this.fever > FEVER_BREAKOUT_LEVEL && !this.breakoutLatched) {
      this.breakoutLatched = true;
      events.push({
        kind: "FEVER_BREAKOUT",
        detail: `fever ${this.fever.toFixed(3)} · ${txCount} community legs · ${fmtRaw(volumeRaw)} MURMUR moved this tick`,
        ts: nowTs,
      });
    } else if (this.fever < FEVER_BREAKOUT_RESET) {
      this.breakoutLatched = false;
    }

    // 2) WHALE_MOVE — at most one per tick, narrating the largest whale leg (ties keep the first).
    if (whale) {
      let largest = whaleLegs[0];
      for (const leg of whaleLegs) if (leg.valueRaw > largest.valueRaw) largest = leg;
      events.push({
        kind: "WHALE_MOVE",
        detail: `${whaleLegs.length} whale leg${whaleLegs.length > 1 ? "s" : ""} · largest ${fmtRaw(largest.valueRaw)} MURMUR · tx ${shortTx(largest.txHash)}`,
        ts: nowTs,
      });
    }

    // 3) TREASURY_MILESTONE — cumulative treasury inflow crossing each 1000-MURMUR step. A single
    //    huge deposit that skips several milestones fires ONE event naming the highest one.
    const cumBefore = this.treasuryCumRaw;
    this.treasuryCumRaw += treasuryInRaw;
    if (TREASURY_MILESTONE_STEP_RAW > 0n) {
      const m0 = cumBefore / TREASURY_MILESTONE_STEP_RAW;
      const m1 = this.treasuryCumRaw / TREASURY_MILESTONE_STEP_RAW;
      if (m1 > m0) {
        const crossed = m1 - m0;
        events.push({
          kind: "TREASURY_MILESTONE",
          detail: crossed > 1n
            ? `treasury inflow crossed ${crossed} milestones → #${m1} · cumulative ${fmtRaw(this.treasuryCumRaw)} MURMUR`
            : `treasury inflow milestone #${m1} · cumulative ${fmtRaw(this.treasuryCumRaw)} MURMUR`,
          ts: nowTs,
        });
      }
    }

    // 4) LONG_SILENCE — LONG_SILENCE_TICKS consecutive ticks with zero community legs. The read-out
    //    reports the true run length on the firing tick, then the internal counter clears.
    if (txCount === 0) this.silentTicks++;
    else this.silentTicks = 0;
    const silentAtRead = this.silentTicks;
    if (this.silentTicks >= LONG_SILENCE_TICKS) {
      events.push({
        kind: "LONG_SILENCE",
        detail: `${silentAtRead} consecutive ticks with no community token activity`,
        ts: nowTs,
      });
      this.silentTicks = 0;
    }

    return {
      fever: this.fever,
      txCount,
      volumeRaw: volumeRaw.toString(),
      treasuryInRaw: treasuryInRaw.toString(),
      whale,
      events,
      silentTicks: silentAtRead,
    };
  }

  toJSON(): unknown {
    return {
      v: 1 as const,
      cfg: {
        token: this.cfg.token,
        treasury: this.cfg.treasury,
        whaleMinRaw: this.cfg.whaleMinRaw.toString(),
        lookbackBlocks: this.cfg.lookbackBlocks.toString(),
      },
      primed: this.primed,
      sampleCount: this.sampleCount,
      baselineTx: this.baselineTx,
      baselineVol: this.baselineVol,
      smoothRatio: this.smoothRatio,
      fever: this.fever,
      breakoutLatched: this.breakoutLatched,
      treasuryCumRaw: this.treasuryCumRaw.toString(),
      silentTicks: this.silentTicks,
    };
  }

  static fromJSON(o: unknown): BourseMeter {
    const r = rec(o);
    const c = rec(r.cfg);
    const m = new BourseMeter({
      token: asStr(c.token, ""),
      treasury: asStr(c.treasury, ""),
      whaleMinRaw: asBig(c.whaleMinRaw, 0n),
      lookbackBlocks: asBig(c.lookbackBlocks, 0n),
    });
    m.primed = r.primed === true;
    m.sampleCount = asInt(r.sampleCount, 0);
    m.baselineTx = asNum(r.baselineTx, 0);
    m.baselineVol = asNum(r.baselineVol, 0);
    m.smoothRatio = asNum(r.smoothRatio, 1);
    m.fever = asNum(r.fever, 0.5);
    m.breakoutLatched = r.breakoutLatched === true;
    m.treasuryCumRaw = asBig(r.treasuryCumRaw, 0n);
    m.silentTicks = asInt(r.silentTicks, 0);
    return m;
  }
}

// ---------------------------------------------------------------------------
// coinStimuli — the bourse's read-out mapped onto the swarm's sensory channels
// ---------------------------------------------------------------------------

/**
 * Map a BourseReadOut onto the four stimulus channels (same food/threat/light/dark vocabulary the
 * visitor poke uses). 自有映射设计（与上游机制思想同源、实现自写），确定性：同输入同输出。
 *   · fever 高           → food   （暖与躁动 — a warm, busy market smells of food）
 *   · fever 极低/长静默  → dark   （冷清 — the bourse goes quiet and dark）
 *   · whale 出现         → threat （掠食者警报，轻 — a big shadow passes overhead）
 *   · FEVER_BREAKOUT     → light  （行情破格的一瞬，全场亮灯）
 * Every intensity is hard-capped at `cap` (default 0.35) so even a maximal bourse tick can only
 * perturb the swarm gently — the anti-manipulation bound. Zero-intensity entries are omitted;
 * `from` is always "bourse". Emits in a fixed order (food, dark, threat, light).
 */
export function coinStimuli(
  read: BourseReadOut,
  cap?: number,
): Array<{ type: "food" | "threat" | "light" | "dark"; intensity: number; from: string }> {
  const c = clampNum(cap ?? COIN_STIMULUS_CAP, 0, 1);
  const out: Array<{ type: "food" | "threat" | "light" | "dark"; intensity: number; from: string }> = [];

  const food = c * clampNum((read.fever - 0.5) * 2, 0, 1);
  if (food > 0) out.push({ type: "food", intensity: food, from: "bourse" });

  const dark = c * Math.max(
    clampNum((0.3 - read.fever) / 0.3, 0, 1),
    clampNum(read.silentTicks / LONG_SILENCE_TICKS, 0, 1),
  );
  if (dark > 0) out.push({ type: "dark", intensity: dark, from: "bourse" });

  if (read.whale) out.push({ type: "threat", intensity: c * 0.5, from: "bourse" });
  if ((read.events ?? []).some((e) => e?.kind === "FEVER_BREAKOUT")) {
    out.push({ type: "light", intensity: c, from: "bourse" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chain sampling — a thin viem getLogs wrapper (range clamping is the CALLER's job)
// ---------------------------------------------------------------------------

/** keccak256("Transfer(address,address,uint256)") — the canonical ERC-20 Transfer topic0. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/**
 * Pull our token's Transfer logs for [fromBlock, toBlock] and decode them into RawTransfer[].
 * 薄封装：不解路由（交给 reduceBourseLegs）、不钳制区间（lookbackBlocks 钳制由调用方负责）、
 * 不重试（transport 层已有 failover）。Addresses are lowercased here; pending-ish logs with a
 * null hash/block degrade to "" / 0n. Deterministic mapping, input order preserved.
 */
export async function sampleBourseTransfers(
  client: PublicClient,
  token: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<RawTransfer[]> {
  const logs = await client.getLogs({
    address: token as `0x${string}`,
    event: TRANSFER_EVENT,
    fromBlock,
    toBlock,
  });
  const out: RawTransfer[] = [];
  for (const log of logs) {
    out.push({
      from: String(log.args?.from ?? "").toLowerCase(),
      to: String(log.args?.to ?? "").toLowerCase(),
      valueRaw: log.args?.value ?? 0n,
      txHash: log.transactionHash ?? "",
      blockNumber: log.blockNumber ?? 0n,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// tiny local helpers (bourse.ts stays dependency-free: no config.ts / chain.ts imports,
// so the pure core unit-tests offline exactly like arena.ts does)
// ---------------------------------------------------------------------------

function clampNum(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;               // NaN has no place on a dial; floor it
  return x < lo ? lo : x > hi ? hi : x;         // ±Infinity clamps to the nearest bound
}

function logistic(x: number): number {
  if (Number.isNaN(x)) return 0.5;
  return 1 / (1 + Math.exp(-x));
}

/** bigint-exact decimal render of a raw 18-dec amount, truncated to 4 dp (deterministic, no float). */
function fmtRaw(raw: bigint): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const whole = v / Q18;
  const frac4 = (v % Q18) / (10n ** 14n);
  return `${neg ? "-" : ""}${whole}.${frac4.toString().padStart(4, "0")}`;
}

function shortTx(hash: string): string {
  return hash ? `${hash.slice(0, 10)}…` : "unknown-tx";
}

function rec(o: unknown): Record<string, unknown> {
  return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
}
function asStr(v: unknown, d: string): string {
  return typeof v === "string" ? v : d;
}
function asNum(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function asInt(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : d;
}
function asBig(v: unknown, d: bigint): bigint {
  try {
    const b = BigInt(v as string | number | bigint);
    return b < 0n ? d : b;
  } catch {
    return d;
  }
}
