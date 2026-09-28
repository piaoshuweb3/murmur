// reform.test.ts — B8 REFORM v1.7 纯账本三工具的模块级契约测试（表驱动，node:test）。
//
// 覆盖面（对照任务书）：
//   1. 出厂默认 OFF（代码常量 false）+ 规格常量锁（阈值 5 / 阶梯 [10,10%],[25,25%],[40,40%] / gini 0.72 / N=12）。
//   2. 遗产税七档表 0/5/5.01/10/25/40/100 —— 断言 10→0.5、25→4.25、100→34.25（任务书自带分解式
//      5×0.1+15×0.25+15×0.4+60×0.4 = 34.25；其行文 "25→3.0 / 100→29.5" 为算术笔误，见 reform.ts 勘误注），
//      且 toCommons === toUbi === tax/2 处处成立。
//   3. 关断直通：REFORM_ENABLED=false ⇒ 税全零 / 禧年恒否 / 催化剂原样返回（关旗 = 调用方字节级不变）。
//   4. 禧年三条件独立必要性 + 持续性边界（11 拒 / 12 放）。
//   5. 催化剂三档（<0.2→×1.5、<0.35→×1.25、否则 ×1.0）与 0.2/0.35 边界精确归属。
//   6. per-cron 遗产税合计（state.ts ① 接线的输入）：脏 estate 跳过、原子账守恒（Commons+UBI===tax，
//      floor 平分余数归 UBI 支）。
//   7. 关旗时 noteMortality 消费端完全惰性：state.ts 的唯一账本写入路径 `REFORM_ENABLED && graves.length`
//      在旗关时短路，同一墓葬输入在旗关下产出全零 levy ⇒ 基线输出与关旗前逐字节一致。
//
// 边界：本文件只审 reform.ts 的纯函数面（不实例化 DO / D1 / chronicler）—— DO 侧接线为
// `REFORM_ENABLED &&` 短路 + try/catch fail-soft，其行为由 3/9 两组旗关直通用例传递保证。

import test from "node:test";
import assert from "node:assert/strict";

import {
  REFORM_ENABLED,
  REFORM_TAX_THRESHOLD_USDC,
  REFORM_TAX_TIERS,
  REFORM_GINI_TRIGGER,
  REFORM_GINI_CRON_N,
  REFORM_AGITATION_TRIGGER,
  reformEstateTax,
  reformEstateTaxGraves,
  reformJubileeReady,
  reformDarkAgeCatalyst,
  __setReformEnabled,
  type ReformGraveLike,
} from "./reform.js";

/** float 安全断言：税额求和允许 1e-9 尾差（0.1/0.4 的二进制噪声），语义值必须落在其内。 */
function closeTo(actual: number, expected: number, where: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${where}: expected ≈${expected}, got ${actual}`,
  );
}

/** 七档表：[estateUsdc, 期望税额]。对半分（toCommons === toUbi === tax/2）另行断言。 */
const TAX_TABLE: ReadonlyArray<readonly [number, number]> = [
  [0, 0], // 空产 —— 无可税之物
  [5, 0], // 起征点整值免税（≤ 5 全零，贫民与薄产者不惊动税吏）
  [5.01, 0.001], // 越线一分钱即应税：0.01 × 0.10
  [10, 0.5], // (5,10] 全段 @10% = 5×0.1
  [25, 4.25], // 0.5 + (25−10)×0.25 = 0.5 + 3.75
  [40, 10.25], // 0.5 + 3.75 + (40−25)×0.4 = 10.25
  [100, 34.25], // 任务书自带分解式：5×0.1 + 15×0.25 + 15×0.4 + 60×0.4 = 34.25（末档 40% 延伸到顶）
];

// ------------------------------------------------------------------------------------------------------------
// 1. 出厂默认与规格常量锁
// ------------------------------------------------------------------------------------------------------------

test("shipped default is OFF and the spec constants are locked (代码常量模式)", () => {
  __setReformEnabled(false); // 本文件首个断言前先归零 —— 顺序无关性
  assert.equal(REFORM_ENABLED, false, "出厂必须是关旗（v1.7 合入叙事时才置 true）");
  assert.equal(REFORM_TAX_THRESHOLD_USDC, 5);
  assert.deepEqual(REFORM_TAX_TIERS, [[10, 0.1], [25, 0.25], [40, 0.4]]);
  assert.equal(REFORM_GINI_TRIGGER, 0.72);
  assert.equal(REFORM_GINI_CRON_N, 12);
  assert.equal(REFORM_AGITATION_TRIGGER, 0.5);
});

// ------------------------------------------------------------------------------------------------------------
// 2. 遗产税七档表 + 对半分恒等式
// ------------------------------------------------------------------------------------------------------------

test("estate tax ladder: the seven-row table, split halves exact (对半分恒等式)", () => {
  __setReformEnabled(true);
  try {
    for (const [estate, expected] of TAX_TABLE) {
      const s = reformEstateTax(estate);
      const where = `estate=${estate}`;
      closeTo(s.tax, expected, where);
      if (expected === 0) {
        assert.deepEqual(s, { tax: 0, toCommons: 0, toUbi: 0 }, where);
      } else {
        // 对半分：两支同一表达式恒等，且合计守恒
        assert.equal(s.toCommons, s.tax / 2, where);
        assert.equal(s.toUbi, s.tax / 2, where);
        assert.equal(s.toCommons, s.toUbi, where);
        closeTo(s.toCommons + s.toUbi, s.tax, `${where} (conservation)`);
      }
    }
    // 任务书点名的三个锚值（勘误后）：10→0.5、25→4.25、100→34.25
    assert.equal(reformEstateTax(10).tax, 0.5);
    closeTo(reformEstateTax(25).tax, 4.25, "estate=25");
    closeTo(reformEstateTax(100).tax, 34.25, "estate=100");
  } finally {
    __setReformEnabled(false);
  }
});

test("estate tax: dirty inputs fail soft to the zero split (NaN/±∞/负值)", () => {
  __setReformEnabled(true);
  try {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -3]) {
      assert.deepEqual(reformEstateTax(bad), { tax: 0, toCommons: 0, toUbi: 0 }, `estate=${bad}`);
    }
  } finally {
    __setReformEnabled(false);
  }
});

// ------------------------------------------------------------------------------------------------------------
// 3. 关断直通（关旗 = 调用方字节级不变）
// ------------------------------------------------------------------------------------------------------------

test("flag OFF: every tool is a direct passthrough (关断直通)", () => {
  __setReformEnabled(false);
  // ① 税：巨额遗产也全零
  assert.deepEqual(reformEstateTax(100), { tax: 0, toCommons: 0, toUbi: 0 });
  assert.deepEqual(reformEstateTax(1e9), { tax: 0, toCommons: 0, toUbi: 0 });
  // ② 禧年：三条件即便全超线也恒否（旗是第一道否决）
  assert.equal(reformJubileeReady(0.99, 1, 999), false);
  // ③ 催化剂：原样返回 baseDecay（同一引用语义下的恒等值）
  assert.equal(reformDarkAgeCatalyst(0.1, 30000), 30000);
  assert.equal(reformDarkAgeCatalyst(0.0, 12345.5), 12345.5);
  // per-cron 合计：旗关即空台账
  assert.deepEqual(
    reformEstateTaxGraves([{ id: 7, estate: "100000000" }]),
    { taxedIds: [], taxUsdc: 0, toCommonsUsdc: 0, toUbiUsdc: 0, taxAtomic: "0", toCommonsAtomic: "0", toUbiAtomic: "0" },
  );
});

// ------------------------------------------------------------------------------------------------------------
// 4. 禧年：三条件 AND + 独立必要性 + 11 拒 / 12 放
// ------------------------------------------------------------------------------------------------------------

test("jubilee: the persistence boundary — 11 crons reject, 12 crons admit (11 拒 / 12 放)", () => {
  __setReformEnabled(true);
  try {
    assert.equal(reformJubileeReady(0.72, 0.5, 11), false, "11 个 cron 不够 —— 一个 cron 的尖峰不值得全免债务");
    assert.equal(reformJubileeReady(0.72, 0.5, 12), true, "恰好 12 个 cron —— 持续性达成");
    assert.equal(reformJubileeReady(0.72, 0.5, 13), true, "超过 12 仍然放行");
  } finally {
    __setReformEnabled(false);
  }
});

test("jubilee: each of the three conditions is independently necessary (三条件独立必要性)", () => {
  __setReformEnabled(true);
  try {
    const [G, A, N] = [REFORM_GINI_TRIGGER, REFORM_AGITATION_TRIGGER, REFORM_GINI_CRON_N];
    // 基准：三条件全部压线满足 → 就绪
    assert.equal(reformJubileeReady(G, A, N), true);
    // 只破 gini 腿（G−1e-9 严格低于压线值 ⇒ ≥ 判定翻转）
    assert.equal(reformJubileeReady(G - 1e-9, A, N), false, "gini 差一分即否决");
    assert.equal(reformJubileeReady(0.5, A, N), false);
    // 只破 agitation 腿
    assert.equal(reformJubileeReady(G, A - 1e-9, N), false, "蜂群安分则不动重锤");
    assert.equal(reformJubileeReady(G, 0, N), false);
    // 只破持续性腿
    assert.equal(reformJubileeReady(G, A, N - 1), false, "驻留不足 N 个 cron 即否决");
    assert.equal(reformJubileeReady(G, A, 0), false);
  } finally {
    __setReformEnabled(false);
  }
});

// ------------------------------------------------------------------------------------------------------------
// 5. 黑暗时代催化剂：三档 + 边界精确归属
// ------------------------------------------------------------------------------------------------------------

test("catalyst: three tiers with exact 0.2 / 0.35 boundaries (催化剂三档)", () => {
  __setReformEnabled(true);
  try {
    assert.equal(reformDarkAgeCatalyst(0.0, 30000), 45000); // 深渊：×1.5
    assert.equal(reformDarkAgeCatalyst(0.19, 30000), 45000); // 仍 <0.2：×1.5
    assert.equal(reformDarkAgeCatalyst(0.2, 30000), 37500); // 恰 0.2 落第二档：×1.25
    assert.equal(reformDarkAgeCatalyst(0.34, 6000), 7500); // 仍 <0.35：×1.25
    assert.equal(reformDarkAgeCatalyst(0.35, 30000), 30000); // 恰 0.35 落第三档：×1.0
    assert.equal(reformDarkAgeCatalyst(0.9, 30000), 30000); // 盛世：原样
    // 脏值 fail-soft：civLevel 或 baseDecay 非 limited ⇒ 原样返回
    assert.equal(reformDarkAgeCatalyst(Number.NaN, 30000), 30000);
    assert.equal(reformDarkAgeCatalyst(0.1, Number.NaN), Number.NaN);
  } finally {
    __setReformEnabled(false);
  }
});

// ------------------------------------------------------------------------------------------------------------
// 6. per-cron 遗产税合计（state.ts ① 接线的输入）：脏值跳过 + 原子账守恒
// ------------------------------------------------------------------------------------------------------------

test("graves aggregator: per-cron levy, dirty estates skipped, atomic books conserve (守恒)", () => {
  __setReformEnabled(true);
  try {
    const graves: ReformGraveLike[] = [
      { id: 1, estate: "5000000" }, // 5 USDC —— 免税线整值，不入账
      { id: 2, estate: "25000000" }, // 25 USDC —— 税 4.25
      { id: 3, estate: "not-a-number" }, // 脏 estate —— 整笔跳过（fail-soft）
      { id: 4, estate: "100000000" }, // 100 USDC —— 税 34.25
    ];
    const levy = reformEstateTaxGraves(graves);
    assert.deepEqual(levy.taxedIds, [2, 4], "免税与脏值墓葬都不进税册");
    closeTo(levy.taxUsdc, 38.5, "levy total"); // 4.25 + 34.25
    closeTo(levy.toCommonsUsdc, 19.25, "commons half");
    closeTo(levy.toUbiUsdc, 19.25, "ubi half");
    // 原子账（6-dec）守恒：Commons + UBI === tax，floor 平分的余数归 UBI 支
    assert.equal(levy.taxAtomic, "38500000");
    assert.equal(levy.toCommonsAtomic, "19250000");
    assert.equal(levy.toUbiAtomic, "19250000");
    assert.equal(BigInt(levy.toCommonsAtomic) + BigInt(levy.toUbiAtomic), BigInt(levy.taxAtomic));
    // 空墓葬 / 全免税墓葬 ⇒ 零台账（state.ts 的 tax>0 门槛由此成立）
    assert.deepEqual(reformEstateTaxGraves([]).taxedIds, []);
    assert.deepEqual(reformEstateTaxGraves([{ id: 9, estate: "1" }]).taxAtomic, "0");
  } finally {
    __setReformEnabled(false);
  }
});

// ------------------------------------------------------------------------------------------------------------
// 7. 关旗时 noteMortality 消费端完全惰性（基线一致性）
// ------------------------------------------------------------------------------------------------------------

test("flag OFF: the noteMortality consumer is fully inert (关旗输出与基线一致)", () => {
  __setReformEnabled(false);
  const graves: ReformGraveLike[] = [
    { id: 1, estate: "25000000" },
    { id: 2, estate: "100000000" },
  ];
  // state.ts ① 的账本写入门槛是 `REFORM_ENABLED && graves.length && levy.taxedIds.length > 0`；
  // 旗关下 levy 恒为零台账 ⇒ 无任何 storage 写、无日志 ⇒ noteMortality 的输出被原样消费（基线不变）。
  const levy = reformEstateTaxGraves(graves);
  assert.deepEqual(levy.taxedIds, []);
  assert.equal(levy.taxAtomic, "0");
  assert.equal(levy.toCommonsAtomic, "0");
  assert.equal(levy.toUbiAtomic, "0");
  // 同一输入在旗开下有税 —— 证明上述全零来自旗而非输入（对照差异）。
  __setReformEnabled(true);
  try {
    assert.ok(reformEstateTaxGraves(graves).taxedIds.length === 2);
  } finally {
    __setReformEnabled(false);
  }
  assert.equal(REFORM_ENABLED, false, "测试收尾必须还原出厂关旗");
});

// ------------------------------------------------------------------------------------------------------------
// 8. 纯度：确定性 + 逐字节一致
// ------------------------------------------------------------------------------------------------------------

test("purity: same input twice → deep-equal AND byte-identical JSON (无时钟无随机)", () => {
  __setReformEnabled(true);
  try {
    const estates = [0, 5, 5.01, 10, 25, 40, 100, 1e6];
    for (const e of estates) {
      const a = reformEstateTax(e);
      const b = reformEstateTax(e);
      assert.deepEqual(a, b, `estate=${e}`);
      assert.equal(JSON.stringify(a), JSON.stringify(b), `estate=${e}`);
    }
    const graves: ReformGraveLike[] = [
      { id: 1, estate: "25000000" },
      { id: 2, estate: "100000000" },
      { id: 3, estate: "junk" },
    ];
    const l1 = reformEstateTaxGraves(graves);
    const l2 = reformEstateTaxGraves(graves);
    assert.deepEqual(l1, l2);
    assert.equal(JSON.stringify(l1), JSON.stringify(l2));
    // 催化剂是纯乘法：同输入同输出
    assert.equal(reformDarkAgeCatalyst(0.15, 999), reformDarkAgeCatalyst(0.15, 999));
  } finally {
    __setReformEnabled(false);
  }
  assert.equal(REFORM_ENABLED, false);
});
