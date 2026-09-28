// ============================================================================================================
// reform.ts — B8 REFORM v1.7 纯账本三工具（累进遗产税 / 禧年稳定器 / 黑暗时代催化剂）。
//
// 边界声明（硬约束，勿越）：REFORM 是文明层账本叙事（DO 内存 / DO·D1 storage 叙事科目），与 WarCoffer
// 链上 levyTax 的实金划转互不混淆 —— 链上税是 WarCoffer.sol 合约内的真实 USDC 转移（x402.ts
// warCofferAbi.levyTax，烧真实 gas），而本模块的全部输出只是文明层的账本叙事，一分钱链上资产都不动、
// 一个交易都不广播。v1 零链上调用、零 gas、零资金旗依赖、零新增 env var（总开关 REFORM_ENABLED 是代码
// 常量，v1.7 合入时才置 true —— 测试经 __setReformEnabled() 翻转，生产代码从不调用该钩子，模式同
// execution/adapter.ts 的 __setUltraRoute；var 池 61/64，一个叙事开关不值得占用免费层名额）。
//
// 三工具与接线点（state.ts）：
//   ① reformEstateTax / reformEstateTaxGraves —— noteMortality 遗产分配路径（state.ts cronInner 4b 段）。
//      保守接法（任务书授权的退化）：真实遗产分配在 economy.entomb() 内部先行完成（子女→家库→贫民施舍），
//      且 Commons/UBI 记账科目同样封闭在 economy.ts 私有域 —— 均不在本任务文件边界（reform.ts / state.ts /
//      reform.test.ts）可及。故 v1 税额只入账本镜像（DO storage 叙事科目 reform:tax*Atomic）+ ops 日志，
//      净遗产照旧分配（economy 侧行为逐字节不动）。
//   ② reformJubileeReady —— driveCommons 调用点（state.ts cronInner step 8）的禧年稳定器。overLineCrons
//      连续超线计数 = 类字段 + DO storage 镜像（resolverGas 的内存→storage 双层防驱逐模式）。
//   ③ reformDarkAgeCatalyst —— 半衰期消费处包装。
//
// ③ 的接线配方（下一轮 economy.ts 开放时一行落地，本轮显式缓行）：economy.ts 的半衰期消费处 =
// AgentEconomy.fade() / bondHalfLifeFor（BOND_HALF_LIFE / FAST_BOND_* / BOND_WOUND_* / REP_HALF_LIFE 的
// 唯一消费点，economy.ts fade 定义约 :1277、选表约 :1285-1301）。落地即：
//     const halfLife = reformDarkAgeCatalyst(civLevelNorm, baseHalfLife);
// 其中 civLevelNorm ∈ 0..1 为时代文明水位归一化（civ < 0.2 → ×1.5、< 0.35 → ×1.25、否则 ×1.0）。
// 本轮未接线的根因：该消费点在 economy.ts 内部，不在本任务文件边界内 —— 按"锚点以真实代码为准 + 保守
// 退化"纪律显式缓行，绝不在 state.ts 的非衰减消费处硬凑（那会污染语义、留债给下一位开发者）。
//
// 编年史卷行文（①税入事件 / ②禧年事件）同样缓行：ChronicleKind 是封闭联合 + verifyChain 强制
// "text 必须从模板重推导"（chronicler.ts:493），新增 JUBILEE / ESTATE_TAX 行需改 chronicler.ts（新增
// kind + 模板 + 探测块，事件经 ctx 折入），chronicler.ts 同样不在本任务边界内 → v1 事件落地为 ops
// 日志 + DO storage 台账 + /state.reform 读出，卷行文配方留给 chronicler.ts 开放的下一轮。
// ============================================================================================================

/**
 * B8 总开关 —— 代码常量模式，出厂 false（关旗 = 全部三工具直通/全零，调用方字节级不变）。
 * v1.7 正式合入叙事时才改为 true。`let` 仅为测试钩子 __setReformEnabled 存在（ESM 活绑定对导入方可见），
 * 生产代码路径从不写它 —— 与 execution/adapter.ts 的 EXECUTION_ROUTE_ULTRA 同款纪律。
 */
export let REFORM_ENABLED = false;

/** @internal 测试钩子 —— 在用例间翻转总开关（模块态否则跨用例泄漏），生产代码从不调用。 */
export function __setReformEnabled(v: boolean): void {
  REFORM_ENABLED = v;
}

/** 遗产税起征点（USDC）：estate ≤ 起征点的遗产全额免税（贫民与薄产者不惊动税吏）。 */
export const REFORM_TAX_THRESHOLD_USDC = 5;
/** 阶梯边际税率 [档顶, 税率]：(5,10] @10%、(10,25] @25%、(25,40] @40%、40 以上沿用末档 40%。 */
export const REFORM_TAX_TIERS: ReadonlyArray<readonly [number, number]> = [
  [10, 0.1],
  [25, 0.25],
  [40, 0.4],
];
/** 禧年触发线：gini 连续 REFORM_GINI_CRON_N 个 cron 保持在 ≥ 此线，且蜂群不安，才动手。 */
export const REFORM_GINI_TRIGGER = 0.72;
/** 禧年的持续性门槛：不平等必须"驻留"这么多个 cron —— 一个 cron 的尖峰不值得全免债务。 */
export const REFORM_GINI_CRON_N = 12;
/** 禧年的躁动门槛：AGITATE 占比 ≥ 0.5（蜂群自己也受够了）——v3.2 §4.9 草稿内联 0.5，提为具名常量。 */
export const REFORM_AGITATION_TRIGGER = 0.5;

export interface ReformTaxSplit {
  tax: number;
  toCommons: number;
  toUbi: number;
}

const ZERO_SPLIT: ReformTaxSplit = { tax: 0, toCommons: 0, toUbi: 0 };

/**
 * ① Progressive estate tax — 分段边际税（piecewise marginal）。只对"起征点之上"的部分按档征收：
 *   (5,10] ×0.10、(10,25] ×0.25、(25,40] ×0.40、40 以上 ×0.40（末档延伸），税入对半（Commons/UBI）。
 *   返回 { tax, toCommons, toUbi }；未启用或 estate ≤ 5（含 NaN 等脏值，fail-soft）返回全零。
 *   例：10 → 0.5；25 → 4.25（= 5×0.1 + 15×0.25）；100 → 34.25（= 5×0.1 + 15×0.25 + 15×0.4 + 60×0.4）。
 *   【算术勘误】任务书行文曾写 "25→3.0、100→29.5"，但其自带的分解式 5×0.1+15×0.25+15×0.4+60×0.4
 *   恒等于 34.25（≠29.5），且 15×0.25=3.75（25 = 0.5+3.75 = 4.25，≠3.0）——两处均为任务书笔误；
 *   本实现以分解式 + 阶梯表为真值（同一算法在 v3.2 §4.9 草稿、阶梯表、分解式三处互证一致）。
 */
export function reformEstateTax(estateUsdc: number): ReformTaxSplit {
  if (!REFORM_ENABLED || !Number.isFinite(estateUsdc) || estateUsdc <= REFORM_TAX_THRESHOLD_USDC) {
    return ZERO_SPLIT;
  }
  let tax = 0;
  let remain = estateUsdc - REFORM_TAX_THRESHOLD_USDC; // 只有起征点之上的部分应税
  let prevCap = REFORM_TAX_THRESHOLD_USDC;
  for (const [cap, rate] of REFORM_TAX_TIERS) {
    const slice = Math.min(remain, cap - prevCap); // slice = min(remain, cap - prevCap)
    if (slice <= 0) break;
    tax += slice * rate;
    remain -= slice;
    prevCap = cap;
  }
  if (remain > 0) tax += remain * REFORM_TAX_TIERS[REFORM_TAX_TIERS.length - 1][1];
  return { tax, toCommons: tax / 2, toUbi: tax / 2 }; // 对半：两支用同一表达式，恒等
}

/** 遗产记录的最小结构面（economy.ts GraveRecord 的超集兼容：id + estate(6-dec atomic 串)）。 */
export interface ReformGraveLike {
  id: number;
  estate: string;
}

/** 一个 cron 的遗产税合计读出（USDC 叙事数 + 6-dec 原子串镜像；toCommons + toUbi === tax 恒成立）。 */
export interface ReformEstateLevy {
  taxedIds: number[];
  taxUsdc: number;
  toCommonsUsdc: number;
  toUbiUsdc: number;
  taxAtomic: string;
  toCommonsAtomic: string;
  toUbiAtomic: string;
}

const ZERO_LEVY: ReformEstateLevy = {
  taxedIds: [],
  taxUsdc: 0,
  toCommonsUsdc: 0,
  toUbiUsdc: 0,
  taxAtomic: "0",
  toCommonsAtomic: "0",
  toUbiAtomic: "0",
};

/**
 * ① 的 per-cron 合计版：对本 cron 的墓葬（noteMortality 的返回）逐笔计税后合计。estate 为 6-dec
 * 原子串（Number(x)/1e6 与 x402.atomicToUsdc 同式）；脏 estate（非数字串）整笔跳过（fail-soft）。
 * 原子账保持守恒：toCommonsAtomic + toUbiAtomic === taxAtomic（floor 平分，余数归 UBI 支）。
 */
export function reformEstateTaxGraves(graves: readonly ReformGraveLike[] | null | undefined): ReformEstateLevy {
  if (!REFORM_ENABLED || !Array.isArray(graves)) return ZERO_LEVY;
  let taxUsdc = 0;
  const taxedIds: number[] = [];
  for (const g of graves) {
    if (!g || typeof g.estate !== "string" || !/^\d+$/.test(g.estate)) continue;
    const split = reformEstateTax(Number(g.estate) / 1e6);
    if (split.tax <= 0) continue;
    taxUsdc += split.tax;
    taxedIds.push(g.id);
  }
  if (taxedIds.length === 0) return ZERO_LEVY;
  const taxAtomicN = Math.round(taxUsdc * 1e6);
  const commonsAtomicN = Math.floor(taxAtomicN / 2);
  return {
    taxedIds,
    taxUsdc,
    toCommonsUsdc: taxUsdc / 2,
    toUbiUsdc: taxUsdc / 2,
    taxAtomic: String(taxAtomicN),
    toCommonsAtomic: String(commonsAtomicN),
    toUbiAtomic: String(taxAtomicN - commonsAtomicN),
  };
}

/**
 * ② Jubilee stabilizer — 三条件 AND 的禧年仲裁：不平等驻留（gini ≥ 0.72）× 蜂群不安（agitation ≥ 0.5）
 * × 持续性（overLineCrons ≥ 12）。任一不满足即否决 —— 禧年是文明层的重锤，绝不因单 cron 尖峰落下。
 */
export function reformJubileeReady(gini: number, agitation: number, overLineCrons: number): boolean {
  return (
    REFORM_ENABLED &&
    Number.isFinite(gini) &&
    gini >= REFORM_GINI_TRIGGER &&
    Number.isFinite(agitation) &&
    agitation >= REFORM_AGITATION_TRIGGER &&
    Number.isFinite(overLineCrons) &&
    overLineCrons >= REFORM_GINI_CRON_N
  );
}

/**
 * ③ Dark-age catalyst — 黑暗时代催化剂：文明崩塌时把半衰期乘大（1.0–1.5×），让记忆与创痕在衰世里
 * 存得更久（civLevel < 0.2 → ×1.5、< 0.35 → ×1.25、其余 ×1.0）。未启用（或脏值）原样返回 baseDecay。
 * 消费点与接线配方见文件头注 ③。
 */
export function reformDarkAgeCatalyst(civLevel: number, baseDecay: number): number {
  if (!REFORM_ENABLED || !Number.isFinite(civLevel) || !Number.isFinite(baseDecay)) return baseDecay;
  const k = civLevel < 0.2 ? 1.5 : civLevel < 0.35 ? 1.25 : 1.0;
  return baseDecay * k;
}
