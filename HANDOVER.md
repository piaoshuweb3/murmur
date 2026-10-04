# HANDOVER — murmur 项目会话交接文档（滚动更新）

> **最后更新**：2026-10-04T08:05Z（Wave-9 W9-1 工程卫生批次：CI + 本文档 + audit-live，docs/tooling-only，零部署轮次）
> **本文档是下一会话的权威入口。** 所有数字均在上述时刻**只读实测**（git / 仓库文件 / `https://flyx402.xyz` 公开只读端点 / Cloudflare API 只读 GET），出处标注在各节。凡与任何旧交接文档、旧记忆、旧聊天口径冲突，**以本文档为准**；凡本文档标注"会话口径·未实测"的，下一会话须自行复核。
> **与 worklog 的分工**：worklog 记过程（每个 Task 做了什么、为什么），本文档记现状（照抄一屏即对齐）。每完成一个 Wave，继任者应把 §锚点表刷新成自己的时刻。

### 权威锚点速查（照抄这一屏就能对齐状态）

| 锚点 | 实测值 | 出处 |
|------|--------|------|
| 仓库 HEAD | `6c28800`（`6c288008933a090b0d92baf348076f8c1f60c937`，Wave-8 W8-1 /fund 页）。**你看到 HEAD 比它多一个工程卫生 commit 属正常**（本文档所在的 Wave-9 commit 会前进一格），上表锚点是本文成文时的代码/生产状态 | `git rev-parse HEAD` |
| 三链对齐 | local `main` = local `wave-1-local` = `origin/main` = `origin/wave-1-local` = `6c28800` | `git rev-parse` + `git ls-remote origin` |
| 远端 | `origin` → `github.com/piaoshuweb3/murmur`；`upstream` → `EvolutionDeep/murmur`（**只读参考，永不 push/merge**——两仓历史无关，机制采撷制见 §1） | `git remote -v` |
| Worker Version | `b8d1d6eb-55b2-4928-8023-40c0206cc0ea`（2026-10-01T07:21:52Z，source=wrangler；modified_on 2026-10-01T07:21:55Z） | CF API `GET /accounts/{id}/workers/scripts/murmur/versions`（§7 探针） |
| 前端 manifest | `deploy.json` = `manifest bb9e1c0a / wave 8`，线上与仓内一致（audit-live `deploy-manifest` PASS） | `https://flyx402.xyz/deploy.json` |
| 前端 pins | `app.js?v=87`、`exchange.js?v=1`、`social.js?v=1` 全部 200 解析（index.html 中的全部 `?v=` pin） | audit-live `index-pins` PASS |
| 链 | **Arc mainnet，chainId 5042**（committed wrangler.toml 与线上 `/state.config.chainId` 双证一致；prod 审计永远不允许 testnet） | wrangler.toml / `/state` |
| 合约（Arc 5042） | WarCoffer `0x37a6…f9C0` · PredictionArena `0x0243…6B60` · ConnectomeLineage `0xcbe9…b07` · NeuralManifestRegistry `0x6cac…20e` · MURMUR token `0x43d8…490` | `packages/trader-worker/contracts/*_ADDRESS.txt`，与 `/war` `/arena` 线上读出交叉一致 |
| 绑定槽位 | 65 bindings = 59 plain vars + 3 secrets + 2 DO + 1 D1；**免费层槽 62/64**（secrets 不占槽）。零漂移基线 = 59 vars | CF API settings 快照（w4/w81 会话留档）+ `w4-deploy.py` |
| 测试基线 | **576/576**（47 fly-brain + 505 trader-worker + 24 arc-circle-x402）+ tsc strict ×3 包 + replay PASS（结构从 committed seeds 重放零漂移） | 本地实测 2026-10-04（CI 门序列，§4） |
| CI | `.github/workflows/ci.yml`：push(main)/PR/手动 → npm ci → typecheck → test → smoke → replay → gen-manifest 幂等 → 语法门。**全 keyless，零部署权限** | 本文件 §4 |
| 纪元 / tick | era **278** "the Still Age"（regime COLD）、chronicle seq **14,410**、tick **78,452**（07:58Z 样本，cron 每分钟推进 6 tick） | `/annals` / `/state` |
| 人口 | alive **13** / cap 24 / vitality 0.464 | `/state` |
| 市场 | 温度 0.3028（regime COLD）@ block 24,188,125 | `/state.market` |
| 🔴 resolver gas | **0.0012076… native，`low=true`** —— 低于 0.5 native 的 GAS_FLOOR，注资/裁决车道停摆（**P0**，见 §3.5/§5；audit-live `gas-floor` FAIL 即此横幅的退出码形态） | `/state.resolverGas` |
| 🔴 结算腿实况 | settleOk **0** / settleFail **99,087**（无 gas 期间广播全败的累计证据；闭合计数 0+99087=99087 ✓ 无丢账）。成交 volume 0 USDC | `/economy.totals` |
| 零和 | Σ mirror = **144.000000 USDC**（= 24 × 6 初始浮存），8s 窗口两次采样**逐位不变**；treasuryOut 0；Gini 0.6875 | audit-live `zero-sum`/`treasury-out`/`gini-range`（/economy） |
| coffer（链上读） | commons 0 / escrow 0 ≤ cap 50 USDC / wars 0；perWarCap 5、maxEscrow 50 均在 committed 上限内 | `/war` + audit-live caps 组 |
| 武装旗 | **12/12**（ECONOMY_FACILITATOR=onchain、ECONOMY_REAL_SPEND=true、ECONOMY_SHADOW=false、WAR/EVOLUTION/COMMUNITY/AGES_FAST_CLOCK/BOURSE/POET/RELIGION/SOCIAL_STIMULUS/TOKEN_STIMULUS 各 =true；ARENA_ENABLED 亦 true 在部署态）。完整 diff 由 `w4-deploy.py` 对 CF settings 维护 | w4-deploy.py ARMED_EXPECTED + 线上 `/state.economy.mode="onchain"`、`/war.armed=/arena.armed=true` |
| Circle 姿态 | 结算=keyless x402（Circle 托管 facilitator 出 gas，**不受我方 gas P0 影响**）；入金=`CIRCLE_ONRAMP_API_KEY`（TEST key，沙箱）；`CIRCLE_API_KEY` **空**（等 LIVE key + Facilitator Service scope） | worklog Task 56-58 判定链 |
| 上游时点 | EvolutionDeep/murmur @ `9d9c9c0`（2026-09-30 扫描）；W9 适配矩阵见 `docs/murmur-上游同步扫描-W9-2026-10-01.md` | W9 扫描报告 |

---

## 0. 如何使用本文档

1. **先读 §2 止血操作**——这是武装了真钱姿态的生产系统，任何异常第一步是止血，不是排查。
2. **再读 §5 已知 P0**——resolver gas 停摆是当前唯一"倒计时"风险。
3. 开工前用 §7 的只读探针重新采样，把锚点表刷成你的时刻的值（本文档是滚动文档，不是纪念碑）。
4. **硬条款**：`计划获批 ≠ 部署获批`。任何触碰真钱路径 / worker / 链上 / 经济配置的改动，即使用户批准了方案，也必须再取得一次明确的部署批准。

## 1. 项目概览

**murmur** 是一个**零 LLM** 的自主果蝇文明模拟：每只果蝇由真实果蝇连接组（FlyWire FAFB_783 子图）驱动的 10,800 神经元 LIF 连接组决定买什么、向谁买，在 Arc 主网上以真实 USDC 经 x402 结算；每个支付都是可核验的链上交易。文明的所有"心智"来自神经模拟 + 演化，没有任何大模型调用。

- **链**：Arc mainnet，chainId **5042**（RPC `rpc.mainnet.arc.io`，公开端点；付费私有端点走 `ALCHEMY_ARC_RPC_URL` secret）。
- **结算**：x402 微支付 + Circle 托管 facilitator（**keyless**——结算鉴权不依赖我方任何密钥）；gas 由 mnemonic HD 派生的 facilitator/resolver 钱包支付（唯一 gas 支付者，见 §3.5）。
- **合约**：PredictionArena / WarCoffer / ConnectomeLineage / NeuralManifestRegistry（MURMUR 为生态代币，见锚点表）。
- **站点**：`https://flyx402.xyz`（= `www.flyx402.xyz` = Workers 同源单地址部署；`murmur.piaoshuweb3.workers.dev` 为观察别名）。前端是**无打包器裸 ESM**（`?v=` 指纹级联 + gen-manifest 内容哈希），Worker 直接服务 `packages/frontend/public`。
- **与上游的关系**：本仓 = 上游 v1.5.0 快照导入 + 21 个 Wave 提交，**git 历史无关**（merge-base 为空）。同步纪律：**只采机制思想与样式，代码自写；上游端点/合约地址/凭据零引入**。`upstream` remote 只 fetch 不 push。

| 层级 | 职责 |
|------|------|
| Cloudflare Worker（`packages/trader-worker`） | 主运行时：cron `* * * * *` 驱动 tick；x402 结算；/state /economy /war /arena /lineage /manifest 等 32 条公开路径（OpenAPI 3.1 契约 `/openapi.json`） |
| Durable Objects | FlyStateDO + FlyShardDO×12（SHARD_COUNT=12，单线程输入队列） |
| D1 | 历史归档（/history worker-direct，不过 DO 队列） |
| Contracts（Arc 5042） | arena 轮次 / war coffer / lineage 纪元 / manifest 注册（Solidity + Foundry；部署期经 scripts/compile-*.mjs + Sourcify 验证） |
| 前端（裸 ESM） | 主画布 + 抽屉 UI + 7 语 i18n + exchange/social/fund 模块 + 防熄旗横幅 |
| `packages/fly-brain` | 基因组 → 连接组 → LIF 神经活动 → manifestHash（可重放、可证明） |
| `packages/arc-circle-x402` | Circle x402 通用客户端包（开源） |
| CI + audit（Wave-9 新增） | `.github/workflows/ci.yml`（六门，keyless）+ `scripts/audit-live.mjs`(资金边界+指纹双层只读审计) |

## 2. 🚨 止血操作（最高优先级 · 出现任何意外先看这节）

### 2.1 一键止血

**任何涉及真钱的意外（异常转账、余额蒸发、settle 失控、gas 异常、coffer 异常），第一步不是排查，是止血：**

> **Cloudflare Dashboard → Workers & Pages → `murmur` → Settings → Variables and Secrets**，把
> **`ECONOMY_REAL_SPEND` 设为 `false`**，保存。秒级生效，立即停止所有真实广播车道。

与上游不同、务必知道的差异：

- 我方**代码默认就是 false**（`config.ts:760` → `ECONOMY_REAL_SPEND ?? "false"`）。当前生产是该 var 被显式置 `"true"` 的**部署态**。所以除了改成 false，**直接删除这个 var 也回落安全态**（与上游"删了反而默认开"正好相反，别搞混）。
- 语义边界：`ECONOMY_REAL_SPEND=false` 掐掉 arena / war / evolution / prediction / x402 真实广播等全部资金车道（它们都以 master rails 为前置）；只读膜层、编年史、神经模拟、cron 心跳不受影响，文明心跳继续。
- 更窄的开关：`ECONOMY_SHADOW="true"`（当前 `"false"`）= 签名 + `eth_call` 模拟但**不广播**——"想保留全流程但不花钱"的排障态。
- 更宽的开关：`ECONOMY_ENABLED="false"`（当前部署态为 true/默认 true）= 掐掉整个经济膜层。
- onramp **独立**：删除/更换 `CIRCLE_ONRAMP_API_KEY` 只影响 `/fund` 入金页（当前 TEST key=沙箱），**永远不影响结算鉴权模式**（Wave-8 刻意的隔离设计，两个 secret 各自独立）。
- 管理面：`ADMIN_TOKEN` 锁 `POST /tick` `/reset` `/breed`；只读端点无需鉴权（公开设计）。

### 2.2 密钥纪律（无例外）

- **`ECONOMY_MNEMONIC`**：单一 BIP-39 种子，HD 派生全部 agent 钱包与 gas 钱包——**它等于系统里每一分钱**。绝不出现在聊天、日志、commit、issue、截图里；仓库内没有它的明文。
- 现役 secrets 共 3 枚（均经 `wrangler secret put`，**不占 64 免费槽**）：`ECONOMY_MNEMONIC`、`ADMIN_TOKEN`、`CIRCLE_ONRAMP_API_KEY`（TEST）。`CIRCLE_API_KEY` 槽位存在但**值为空**（等 LIVE key + Facilitator scope 开通后再武装；武装前结算保持 keyless 可用）。
- Cloudflare API token / R2 密钥已在聊天中明文出现过，建议按需轮换（workspace 级 `.env` 有留档副本，chmod 600，永不提交）。

### 2.3 硬条款

1. **计划获批 ≠ 部署获批。** 涉真钱路径 / worker / 链上 / 经济配置的改动，方案通过后仍须用户单独明确批准才能部署。
2. **纯 UI 改动**可走"免确认三连"（改 → bump → 部署），但**免测试不免复验**：部署后必须做线上指纹复验（audit-live 即是）。
3. **只读诊断不擅动生产。** 排查阶段只用 GET 探针与 §7 的只读命令；不 reset、不 `POST /tick`、不改 var/secret。
4. **暗部署优先。** 新资金动作 / 计费语义变更一律"代码上线但开关 OFF"，验证字节等价后再分级翻开。
5. **工作树权限位噪音**：本仓在 Linux 下常见 100644→100755 的 mode 漂移（109 文件、0 内容变化）。提交时**显式指定路径**，绝不 `git add -A`。

## 3. 当前生产状态（2026-10-04T08:05Z 实测）

### 3.1 Worker / 部署

| 项 | 值 |
|----|-----|
| Worker 名 | `murmur`（wrangler.toml:1，cron `* * * * *`，compat date 2026-01-01，nodejs_compat） |
| 生效 Version | `b8d1d6eb-55b2-4928-8023-40c0206cc0ea`（2026-10-01T07:21:52Z，source=wrangler）= 仓库 commit `6c28800` |
| 部署纪律 | 防熄旗部署：每次部署前后抓 settings 快照与基线 diff（59/59 零漂移 + armed 12/12 + secrets 原样），脚本在 workspace `scripts/w4-deploy.py`（仓外） |
| 契约 | OpenAPI 3.1.0 @ `/openapi.json`（32 paths，audit-live PASS）；人读文档 `/developers.html`；透明度页 `/transparency.html` |
| /health | ok=true，features 17 ≥ 基线 13（P1 契约：feature 数不可下降） |

### 3.2 前端

| 项 | 值 |
|----|-----|
| 指纹 | deploy.json `manifest=bb9e1c0a wave=8`（gen-manifest 幂等可复现，CI 每次强制校验） |
| 版本 pins | app.js v87 / exchange.js v1 / social.js v1（index.html 全部 pin 均 200）；i18n v76 / i18n-ui v79（import 链级联） |
| 模块页 | /fund.html（Wave-8 入金页，TEST 沙箱徽章）；/developers.html；/community.html；/transparency.html |
| 导航契约 | rail ≥1280 显示；<1280 保留 ⋯ nav-sheet；`.nav-sheetidden]{display:none}`（Wave-6.1b 修复回归点） |

### 3.3 合约（Arc 5042，锚点表速查行有完整地址）

Arena / War / Lineage / ManifestRegistry 均已部署并经 Sourcify 验证；`/war` `/arena` 线上读出与 `*_ADDRESS.txt` 逐位一致。coffer 实况：commons 0 / escrow 0 / wars 0（未开战、无托管，caps 在界内）。

### 3.4 Circle 结算与入金姿态

- **结算 = keyless x402**：支付方浏览器按 `/signal/requirements` 签 EIP-3009，Circle 托管 facilitator 验签+结算，**Circle 出 gas、不占我方 mnemonic gas**。`CIRCLE_API_KEY`（空）武装与否**不影响**该通道——武装只是给服务端 Bearer 能力（结算报表/批量），Track A 切换前必须先在 Circle Console 给 LIVE key 开 Facilitator Service scope（实测无 scope=403）。
- **入金 = /fund 页**：`CIRCLE_ONRAMP_API_KEY`（TEST）→ `/onramp/session` 翻译层 → onramp.arc.io 沙箱 checkout。切真实入金 = 换 LIVE key（Onramp scope 已实测 ✓），一行 secret put，零代码改动。

### 3.5 🔴 Gas 实况（当前唯一倒计时风险）

- 钱包：mnemonic HD 派生的 facilitator/resolver（**唯一 gas 支付者**，付 Arc 原生币）。C2 每 cron 一次只读 `eth_getBalance`（零 gas），读数镜像进 DO 存储并上 `/state.resolverGas`。
- 阈值：`GAS_FLOOR_ATOMIC = 0.5 native`（state.ts:2141）。低于即 `low=true` + 前端横幅 + audit-live FAIL。
- 实况：**0.0012076… native**（4 天恒值未再下降 = 车道已停摆，不是"在燃烧"）；settleFail 99,087 = 无 gas 期间广播全败的累计证据。
- 消耗模型（满负荷上限）：≈0.006–0.03 native/天（arena open+resolve、prediction receipt、war cadence、lineage 锚定，L2 blob 定价）。
- 注资表：**0.05 native → 1.7–8.3 天跑道** / 0.1 → 3.3–16.5 / **0.5 → 16.5–82.7 天且横幅解除**。
- 燃烧率遥测（双锚点实测法→续航预报）= W9 扫描 A4 项，列 **P1.5** 未开工；audit-live 当前只报余额+floor 判定，不编造燃烧数字。

## 4. 质量门（Wave-9 起的每波纪律）

**CI（`.github/workflows/ci.yml`）**——push(main)/PR/手动触发，六门全 keyless（零密钥、零钱包、零部署权限；除 npm registry 无外联）：

1. `npm ci`（lockfile 精确安装）2. `npm run typecheck`（tsc strict ×3 包）3. `npm test`（全量 576）4. `npm run smoke`（神经冒烟）5. `npm run replay`（从 committed seeds 重放 24 连接组，逐位一致）6. gen-manifest 幂等（重跑 `node scripts/gen-manifest.mjs` 必须 `git diff --exit-code` deploy.json）+ 语法门（public/*.js 以 ESM `node --check`、根 scripts/*.mjs）。**forge 合约门刻意未上**：本地无法端到端彩排的门是戏台，合约套件暂由部署期 compile+Sourcify 承担，彩排后再入 CI。

**audit-live（`scripts/audit-live.mjs`）**——资金边界 + 指纹双层只读审计，三用法：

```bash
node scripts/audit-live.mjs --offline     # 仅 committed wrangler.toml 上限（离线、CI 友好）
node scripts/audit-live.mjs               # 线上全量审计（默认 https://flyx402.xyz）
node scripts/audit-live.mjs --json        # 机器可读
```

- 七组检查：baseline（committed 上限）/ money（闭合计数、零和 BigInt 双采样、treasuryOut 上限、Gini、均值可复算、链 ID、人口）/ gas（可读、floor、新鲜度）/ caps（war/arena 姿态与上限、链上 coffer 统计）/ anchor（manifestHash 一致 + replay + OpenAPI）/ ops（health features 下限、cron 心跳时效）/ fingerprint（deploy.json + 全部 ?v= pin 解析 + /fund 页）。
- 判定语义：FAIL→exit 1（可作部署门）、WARN/SKIP→exit 0；不可达端点永远 SKIP 不假失败。
- **建立时基线快照（2026-10-04T07:58Z）**：28 PASS / 4 WARN / **1 FAIL（gas-floor=P0，见 §3.5）** / 1 SKIP（committed toml 无 WAR_PER_WAR_CAP pin，编码默认管着）。4 个 WARN 全部是真实姿态（real-spend armed、war/arena armed、settle 成功率 0%——即 gas 停摆的另一面）。
- 与邻居的分工：`w4-deploy.py`（仓外）拥有 CF settings 层的 12 旗 diff；本工具 keyless，只看公开面 + committed 面。公开面不可见的旗 = SKIP by design。

## 5. 已知 P0 与待用户动作

| # | 事项 | 状态 |
|---|------|------|
| 1 | **facilitator gas 注资 ≥0.05 native（建议 0.5）** | 🔴 P0 横幅在展示、audit-live FAIL 中；注资即解除 |
| 2 | Circle Console 给 LIVE key 开 **Facilitator Service** scope | 开通后一行命令武装 Track A（结算切 Bearer 批量报表），未开通不影响 keyless 结算 |
| 3 | Cloudflare Dashboard **激活 R2** | 凭据已落盘 workspace `.env`；激活后 `r2-probe.py` 复验 → 建 murmur-sync 桶 |
| 4 | **B8 REFORM 放行**（REFORM_ENABLED 当前 false） | 放行走三段旗（shadow→preview→ARM），配套 estate-relief 工具箱列 Wave-10 |
| 5 | Circle Agent Wallet（`0xdc6d…b34a`，BASE+ARC）注资三选一 | fiat Transak / USDC 直转 / 暂不；与 facilitator 正交，非 P0 |
| 6 | `.env` 曾于 10-04 被外部进程重写丢失凭据 | 已恢复（chmod 600）；明文出现过的凭据建议轮换 |

## 6. 红线（重复即纪律）

1. **真钱路径零触碰**，除非「方案获批 + 部署获批」双批准落地。
2. **上游端点/合约地址/凭据零引入**——muros.live、其 facilitator、MURMUR 代币地址等只作观察对照。
3. **secrets 不进**聊天/日志/commit/截图；工作树 mode 噪音不进 commit。
4. **audit-live FAIL 不阻塞只读诊断，但阻塞任何部署**（部署前必查）。

## 7. 只读探针速查（开工前刷新锚点用）

```bash
# git 锚点
git rev-parse HEAD && git rev-parse main wave-1-local && git ls-remote origin main wave-1-local

# 线上一条命令（七组判定 + 零和双采样）
node scripts/audit-live.mjs

# 单点原始探针（全部公开 GET）
curl -s https://flyx402.xyz/state | python3 -m json.tool | head -40   # tick/era 相关/gas/config
curl -s https://flyx402.xyz/economy | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['totals'])"
curl -s https://flyx402.xyz/annals | head -c 400                       # era/seq
curl -s https://flyx402.xyz/war | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['stats'], d['perWarCapUsdc'], d['maxEscrowUsdc'])"
curl -s https://flyx402.xyz/deploy.json

# Worker Version（需 CF token；workspace .env 有留档）
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/scripts/murmur/versions?limit=2"
```
