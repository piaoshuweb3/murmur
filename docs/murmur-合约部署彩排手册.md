# murmur 合约部署专项 · 全链路彩排手册（v1.0）

> 配套文档：《murmur-上云部署手册》§6（合约章节的展开与演练版）。
> 红线唯一且不可协商：**100% 自主知识产权与协议** —— 合约自己写、自己部署、自己收钱、自己升级决策，
> 全程零上游地址、零第三方托管、零不可控依赖。
> 部署者 / 终极管理钱包：`0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`（下称 **ADMIN**）。

---

## 0. 自主权审计结论（2026-09-22，已完成）

对 `packages/trader-worker/contracts/` 五件套 + 测试全量扫描：

| 审计项 | 结果 |
|---|---|
| 硬编码地址（0x…40） | **0 处** —— 五件套合约体内没有任何硬编码地址 |
| 外部 import（OpenZeppelin 等） | **0 处** —— 全部自包含手写 Solidity，仅合约测试引用 forge-std（测试工具，不上链） |
| 第三方收款/费率路由 | **0 处** —— 收款人全部来自构造函数参数（`resolver_` / `treasury_`），部署时由我们注入 |
| License | 五件套全部 MIT |
| 权限模型 | 全部 `onlyResolver` / 构造注入固化；**无 owner 后门**、无可转移所有权、无 selfdestruct |
| 上游示例地址（0x307D…3a0d / 0x3d90…454b / 0x3412… / 0x482b…） | 已在合并时全部剔除，只存在于 git 历史 |

**结论：合约源码层面自主权满分，可直接进入彩排。**

### 唯一缺口（本专项新增工件 0 号）

`PredictionArena` 以 **MURMUR ERC-20** 计价、社区页以 `COMMUNITY_TOKEN` 门禁 —— 而仓库内**没有** MURMUR 代币合约
（上游示例指向其自己发行的代币，已剔除）。**自主权要求 = 自己写、自己发**，规格见 §7。

---

## 1. 参与者与资金表（全部归 ADMIN 体系）

| 角色 | 来源 | 用途 | 备注 |
|---|---|---|---|
| **DEPLOYER**（gas 钱包） | `*_DEPLOYER_PK` secret | 发出全部 create 部署 + gas | 可以就是 ADMIN 本身（推荐，少一层） |
| **RESOLVER**（facilitator） | `ECONOMY_MNEMONIC` BIP-44 派生（src/keys.ts） | WarCoffer/PredictionArena 的唯一操作者（deposit/declare/resolve/levy） | 与 Worker 同种子派生，Worker 上线即自动持有 |
| **TREASURY**（收款） | 硬编码写死 = ADMIN | 繁殖费 / 战争税 / 一切分成 | `0x1068…58B1` |
| **USDC**（战争托管计价） | Arc 原生 precompile `0x3600…0000` | WarCoffer escrow | 链原生资产，零第三方依赖 |
| **MURMUR**（竞技场计价） | 我们自己部署的 MurmurToken | Arena 下注 / 社区门禁 | mint 全量进 ADMIN 金库 |
| **gas 预算** | 6 次部署 + 彩排调用 | 估计 < $1 等值（Arc 低费链） | R3 前给 DEPLOYER 充值即可 |

> 密钥纪律：`ECONOMY_MNEMONIC` 与 `*_DEPLOYER_PK` 只走 `wrangler secret put` / 彩排时本地临时 env，
> **绝不进 git、绝不进 .dev.vars、绝不进发布包**（与既有纪律一致）。

---

## 2. 部署对象与顺序（依赖驱动）

```
① MurmurToken            （无依赖）
② NeuralReceiptRegistry  （无依赖 —— economy onchain commit 的线性哈希头）
③ NeuralManifestRegistry （无依赖 —— 大脑清单证明）
④ ConnectomeLineage      （无依赖 —— 血统/繁殖市场）
⑤ WarCoffer              （依赖：USDC precompile + RESOLVER 地址）
⑥ PredictionArena        （依赖：① 的 MURMUR 地址 + RESOLVER 地址）
```

①~④ 互相独立可并行；⑤⑥ 需要前面产出的地址。**每部署一个立即验证 + 记录地址**（§6 记录表）。

---

## 3. 彩排六阶段总览

| 阶段 | 环境 | 花真钱？ | 目标 | 失败影响 |
|---|---|---|---|---|
| **R0** 工件与工具链 | 本地 | 否 | MurmurToken.sol 落地 + 全部编译通过 + 测试跑绿 | 零 |
| **R1** 本地 fork 演练 | anvil fork 主网 | 否 | 五件套+代币全调用路径彩排，事件/余额断言 | 零 |
| **R2** 测试网彩排 | Arc testnet 5042002 | 否（测试币 gas） | 真实链环境部署 + mock-USDC 全流程 | 零 |
| **R3** 主网部署 | Arc mainnet 5042 | 是（gas <$1） | 六合约上链 + 验证 + 地址记录 | 可重试，无资金风险 |
| **R4** 接线 | wrangler.toml + secrets | 否 | 地址填入 + 军旗逐个开 + Worker 冒烟 | 一键回滚（注释化） |
| **R5** 金丝雀→全量 | 主网 | 是（小额起步） | $1 级战争 + 最小注竞技场跑通 → 24h 观察 → 全量 | 紧急阀（§5） |

---

## R0 —— 工件与工具链（本地，半天）

1. **写 `contracts/MurmurToken.sol`**（规格见 §7）+ `contracts/test/MurmurToken.t.sol`。
2. **编译**：`node scripts/compile-murmur.mjs`（仿 compile-war.mjs，npm solc 产物入 `artifacts/`）；
   五件套 `compile-*.mjs` 全部重跑确认产物新鲜。
3. **测试**：仓库测试是 Foundry 风格（forge-std）。二选一：
   - 环境 A（推荐）：安装 foundry（`curl -L https://foundry.paradigm.xyz | bash && foundryup`）→
     `forge test --root packages/trader-worker`（需补最小 `foundry.toml`：src/contracts、test/contracts/test）；
   - 环境 B（无 foundry）：`forge-std` 用最小 stub 替换 + `forge test` 断言迁移为 node 断言脚本
     （solc 编译 + ethers 调用断言，参照现有 deploy 脚本的 viem 用法）。
4. **断言**：六合约编译零警告级错误；测试全绿；`artifacts/` 六个 ABI 齐全。
5. **回滚**：零影响，删文件重来。

## R1 —— 本地 fork 演练（anvil，半天）

1. `anvil --fork-url https://rpc.mainnet.arc.io --fork-block-number <近期块>` 起本地 fork。
2. 用 deploy 脚本逐一部署（`RPC_URL=http://localhost:8545 CHAIN_ID=31337`），参数全部走生产值
   （USDC=precompile 0x3600…0000 真实存在，fork 上可用；RESOLVER=mnemonic 派生地址；TREASURY=ADMIN）。
3. **全调用路径剧本**（每步断言事件 + 余额）：
   - MurmurToken：mint 总量 → ADMIN 余额=总量 → transfer 给测试者。
   - NeuralReceiptRegistry / Manifest：commit 一条 → head 前进 → 用 /predictions/verify 同源逻辑复核哈希。
   - Lineage：注册一个 connectome 基因组 → 祖先链可查 → 繁殖费**确切落 TREASURY**。
   - WarCoffer：deposit $50 → declareWar（A vs B）→ resolveWar → 胜者金库增加、败者扣减 →
     levyTax 1% → **税款确切落 coffer/treasury** → sweepTo 收回。
   - PredictionArena：openRound → 人类下注（MURMUR approve+bet）→ resolve（in-contract 用 Worker 提交的温度数）→ claim 派彩 → stale-grace 退款路径也走一遍。
4. **重点断言（自主权专项）**：所有资金流动的接收方 ∈ {RESOLVER, TREASURY, 胜者金库, 下注者}，不存在第四方。
5. **回滚**：杀 anvil 即可，零影响。

## R2 —— 测试网彩排（Arc testnet 5042002，半天）

1. DEPLOYER（测试网单独地址）领测试网 gas（faucet 或小额）。
2. 测试网**没有真 USDC** —— 彩排用我们自写的 `MockUSDC.sol`（20 行 ERC-20，仅测试网用）作 `usdc_` 参数，
   验证合约对 ERC-20 的兼容路径（这也是 R1 剧本的复跑）。
3. 全流程复跑 R1 剧本 → explorer 上肉眼确认全部交易与事件。
4. 记录：确认数、gas 实耗、部署脚本输出格式（为 R3 的地址记录做准备）。
5. **回滚**：测试网资产无价值，零影响。

> **R2 就绪态（2026-09-23 工具链落位，已被下方结果态取代）**
> - 剧本：`packages/trader-worker/scripts/r2-rehearsal.mjs`（R1 七幕"无 cheat-code"化：真实 sleep 时间轴 / delta 断言 / ADMIN 无钥强化版 / stale 走 90s mini 实例 / 生产参数与演练实例分离）+ `scripts/r2-keygen.mjs`（一次性彩排钥 → `.env.local`，gitignored）
> - 复跑命令：`RPC_URL=https://rpc.testnet.arc.io CHAIN_ID=5042002 node packages/trader-worker/scripts/r2-rehearsal.mjs`（未领气时干净退出 exit 2 = NEED_MORE_GAS，零状态污染）

> **R2 结果态（2026-09-23 EXECUTED & PASSED —— 71/71 断言全绿，详见 docs/murmur-R2-测试网资金流向审计报告.md）**
> - faucet 领取确认（tx 0xf24afd46…611b，DEPLOYER 0x1681…9f22 到账 20 USDC）后单命令全绿收官；实测墙钟 ≈5.5 分钟（真实时间轴含 90s stale 演练段），gas 全绿单次 ≈2.7 USDC（预算 2.73 精确命中）
> - 19 笔链上转账逐笔白名单（violations=0）· 第四方地址 0 个 · WarCoffer 托管零流出 · ADMIN 全程零流出（测试网无 ADMIN 钥）· 字节码 PUSH20 扫描零上游地址
> - 部署十件套 explorer 可查（本轮全绿实例，仅作证据不接线）：MockUSDC 0xc818…8b3 · MurmurToken(生产) 0x6cd7…0dd · MurmurToken(流通副本) 0x4d6b…747 · ReceiptRegistry 0x23ec…e4d · ManifestRegistry 0xaa51…392 · Lineage 0x674a…1c7 · WarCoffer(生产) 0x64b0…2b2 · WarCoffer-stale 0x0ae9…e6c · Arena(生产) 0xe3b7…13d · Arena-stale 0xba4a…21f（完整表格见审计报告 §2）
> - **R3 决策输入（实测）**：原生 USDC precompile（0x3600…0000）transfer + EIP-3009 结算双双成功 → R3 可直接指向 precompile，免部署资产合约
> - R1→R2 迁移修出 3 处剧本层差异（dw 声明序 / 真实时间轴 deadline 阶梯 / arenaM 转写笔误），六合约两环境 138 项断言零合约缺陷
> - R3 前置不变：`*_CONFIRM` 门控 + **用户本人持 DEPLOYER 钥**——R2 彩排钥与主网钥完全隔离

## R3 —— 主网部署（半小时操作 + 验证）

1. 前置：DEPLOYER 充 gas；`ARENA_CONFIRM="yes"`（脚本确认阀）；本手册 §6 表格就位。
2. 按依赖顺序执行六个 `deploy-*-auto.mjs`（每个之间**人工核对**输出地址再继续）。
3. 每个部署后立即：explorer 打开合约 → 校验构造参数与预期一致 → 记入 §6 表。
4. 断言：六地址就位；`ownerOf/`resolver()`/`treasury()` 读函数全部等于 §1 表的值；
   **逐个合约调用一次只读函数确认 resolver/ADMIN 正确**（错一个就停，重部署，绝不接线）。
5. 回滚：部署失败=nonce 重试（仅 gas 损耗）；地址错了=废弃该合约（资金零暴露——还没接线，合约是死地址）。

## R4 —— 接线与军旗（半小时 + 冒烟）

> **状态更新（2026-09-23）**：R4-0 六合约地址接线已全部完成（wrangler.toml [vars] 实填），只读冒烟
> 28/28（链上）+ 10/10（HTTP）全绿；`ARENA_ENABLED="true"` 已开（R4-1 读路径全通，前端抽屉已渲染
> 主网合约/蜂群对比；开轮写路径待 resolver 武装，见《功能实现总结与上云部署建议》§4 的两个选项）。
> WAR/EVOLUTION/COMMUNITY 三旗仍关，等用户逐旗放行。冒烟脚本：`scripts/r4-0-smoke.mjs`。

wrangler.toml（或上云端后的 secrets）依次填入，**每开一旗跑一次冒烟再开下一旗**：

| 步骤 | 配置 | 冒烟断言 |
|---|---|---|
| 1 | `MANIFEST_REGISTRY_ADDRESS` | `/population` brain manifest 显示 registry 地址；`prove the brain` 按钮全绿 |
| 2 | `LINEAGE_ADDRESS` + `EVOLUTION_ENABLED=true` + `EVOLUTION_TREASURY=ADMIN` | 繁殖市场页有数据；测试繁殖一次，费款落 ADMIN |
| 3 | `ECONOMY_FACILITATOR=onchain` + secret（mnemonic）+ USDC 路径 | x402 真结算一单自买自卖（$0.001 级）→ ADMIN 收款 |
| 4 | `ARENA_ADDRESS` + `ARENA_TOKEN` + `ARENA_ENABLED=true` | `/arena enabled:true`；openRound 事件上链 |
| 5 | `WAR_ADDRESS` + `WAR_TREASURY=ADMIN` + `WAR_MAX_ESCROW_USDC=50` + `WAR_ENABLED=true`（**最后开**） | `/war enabled:true`；deposit 彩排金 |
| 6 | `COMMUNITY_TOKEN` + `COMMUNITY_ENABLED=true` | 社区页门禁读取正常 |

回滚：全部军旗有注释化原样备份（已在 wrangler.toml 预置注释行），逐条注释回退 = 字节级回到影子基线。

## R5 —— 金丝雀 → 全量（24–48h）

1. **金丝雀剧本**：
   - 竞技场：ADMIN 自投最小注（1 单位 MURMUR）跑完整 open→resolve→claim 回路 ×3 轮。
   - 战争：两家族各 deposit $1 → 一场完整 war → 税 1% 落账 → sweep。
2. 观察 24h：无 revert、无卡单、resolver 心跳事件齐全、Worker 日志无 [DO] 报错。
3. 全量：`WAR_MAX_ESCROW_USDC` 提到目标值；对外开放下注；繁殖市场公开。
4. 期间执行日志（EXECUTION LOG）与编年史战争卷同步检查。

---

## 4. 紧急阀与回滚总表

| 场景 | 动作 | 资金风险 |
|---|---|---|
| resolver 钱包疑似泄露 | 换 mnemonic → 重部署含 resolver 的合约（WarCoffer/Arena 是 immutable resolver）→ 接线指向新合约；旧合约内资金 sweepTo 撤出 | 可控（sweep 前 null 资金无法动） |
| Worker 失常乱 resolve | Arena stale-grace（3 天）后任何人可退款；WarCoffer `resolveWar` 仅限已到期 war 的确定性结果，Worker 无法捏造结果（in-contract 出算） | 低（设计如此） |
| 代币出错 | MurmurToken 部署后 **mint 一次即固化**，不可增发不可暂停（§7 规格）——出错=废弃重发，Arena 重指向新地址 | 零（下注前） |
| 战争托管异常 | `sweepTo(houseId)` 把指定金库全额撤回 RESOLVER → ADMIN | 零（主动阀） |
| 合约层硬顶 | `WAR_MAX_ESCROW_USDC=50` immutable + Worker 侧同步值，双保险 | 天然上限 |

## 5. 明确不做的事（红线反面清单）

- ❌ 不使用上游任何已部署合约（即使"顺手可用"）；
- ❌ 不引入 OpenZeppelin/第三方库进合约（保持零依赖源码）；
- ❌ 不给任何合约留 owner 转移/暂停/增发后门（自主权 ≠ 后门权）；
- ❌ 不把 DEPLOYER=RESOLVER=资金操作混用为一个前端交互钱包（钥匙分离，虽然都归 ADMIN 体系）；
- ❌ 不在 R4 之前公开任何合约地址。

## 6. 部署地址记录表（R3 时填写）

> 2026-09-23 已填写（R3 全绿收官，explorer.arc.io 逐单可查；facilitator = 部署 gas 付款人 = 全部
> RESOLVER/COMMITTER = `0x20c54D8Fa205af293181833b46494d97d54753f3`；ADMIN = treasury/收款终局，无钥）

| 合约 | 地址 | 部署 tx | resolver | treasury/token | 日期 |
|---|---|---|---|---|---|
| MurmurToken | `0x43D84EfE7174637cdA55Ae1560cd4BFf4BaAB490` | `0xdb403952…1d42880` | — | treasury=ADMIN（10 亿一次性铸固化） | 2026-09-23 |
| NeuralReceiptRegistry | `0x87F6a942bb563dd7Bba4d3CdbD5d51477E71fc34` | `0x52b49c93…4805d2b` | =facilitator (committer) | — | 2026-09-23 |
| NeuralManifestRegistry | `0x6caCEd7513b6E0b5B2c0CCD669c8A9dE6a0ce20e` | `0x26dcbf8d…f78c9a5` | =facilitator (committer) | 生产脑 `0x403551bb…f6efc02` 已锚定 | 2026-09-23 |
| ConnectomeLineage | `0xCbe979EE7ccB54823e43Df0B3D815f10E8eeaB07` | `0x42903f3a…52dc75f9` | =facilitator (committer) | fee→ADMIN | 2026-09-23 |
| WarCoffer | `0x37a630e56bEa9B9214A638D31F761e9489C9f9C0` | `0x0d2a0252…25db3bb` | =facilitator | treasury=ADMIN · 硬顶 50 USDC(6-dec) immutable · grace 3 天 | 2026-09-23 |
| PredictionArena | `0x0243F95C2654C888a36B7B0DE1D200AaF7C16B60` | `0xb4e412b1…a9244be0` | =facilitator | token=① MURMUR | 2026-09-23 |

## 7. 新工件规格：MurmurToken.sol（0 号工件）

- 标准 ERC-20，18 decimals，**固定总量**（建议 1,000,000,000 枚 = 10 亿，一次性 mint 全额给 ADMIN）；
- 零依赖手写（对齐五件套风格：最小 ERC-20、`_safeTransfer` 包装、无 pause/无 mint-after/无 blacklist）；
- MIT + `@custom:sovereignty` 注释声明：本代币为本部署自主发行，与上游 MURMUR（若同名）无任何关联；
- 用途：PredictionArena 计价 + 社区门禁 + 未来激励；价值捕获不来自合约强制抽水（抽水在 Arena/War 层显式声明）。

---

## 8. 时间与人力预估

| 阶段 | 耗时 | 需要用户参与 |
|---|---|---|
| R0 | 半天 | 无（我执行） |
| R1 | 半天 | 无（我执行） |
| R2 | 半天 | 测试网 faucet 若需人工领取则点一下 |
| R3 | 30 分钟 | **DEPLOYER 私钥就位 + gas 充值确认**（必须用户本人操作或授权） |
| R4 | 30 分钟 | secrets 注入（mnemonic）由用户执行 `wrangler secret put` |
| R5 | 24–48h 观察 | 金丝雀确认放行 |

> R3 起涉及真实私钥——按纪律由用户本人持有与操作，我只提供逐条命令与核对清单。
