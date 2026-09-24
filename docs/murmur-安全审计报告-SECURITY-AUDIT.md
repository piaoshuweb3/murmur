# murmur 二次开发系统 · 安全审计报告

| 项 | 内容 |
|---|---|
| 版本 | v1.2（2026-09-22 · 增补 §8 自主权专项审计：全库收款地址扫描 + x402 收款链路走读 + 上游 80 commit 收款要素清单；v1.1：F-1/F-2/F-3 已落地于代码包 v1.4） |
| 审计对象 | `murmur-work/`（基于 EvolutionDeep/murmur 的二次开发快照，v1.3，128+ 文件） |
| 审计方法 | 全库静态审查（端点/密钥/CORS/鉴权/依赖）+ 线上只读探测（api.muros.live、explorer.arc.io、Arc RPC）+ 本地运行实例核对 |
| 审计目标 | ① 评估 api.muros.live 对本系统的价值 ② 自托管前的安全隐患排查 ③ 管理权限与安全自主权现状 |
| 结论速览 | 代码无后门、无恶意数据外传、密钥架构设计良好；**主要风险在"上游生产配置残留"与"自托管默认不设防"**——按本报告 P0 清单整改后可安全自托管 |

---

## 1. 执行摘要

1. **api.muros.live 是上游官方的生产部署**，与你的代码同源（OpenAPI 自述 + `/population`、`/state` 响应结构逐字段一致）。它**对系统有用但仅限三类只读用途**（见 §2），**绝不能成为运行时依赖**。你的代码运行时没有任何一处调用它（唯一出现在支付元数据里的硬编码引用是缺陷 F-3，需修复）。
2. **无后门、无恶意行为**：全库 URL 清点显示运行时外部调用仅限公开数据服务（Arc RPC、dexscreener、Helius、Bitquery、Jupiter、0x、Circle、IPFS）；无遥测、无匿名上报、无混淆代码、无可疑依赖包。
3. **密钥架构本身设计良好**：默认 keyless 模拟经济、执行层四旗门控（ENABLED/REAL_SPEND/SHADOW/SIGNING）、EIP-3009 买方签名 + 中继方不托管资金、结算前链上余额复核、多层 kill switch。
4. **最大的隐患不在代码，而在配置**：`wrangler.toml` 提交的是**上游真实生产配置**——真金白银模式（`ECONOMY_FACILITATOR="onchain"` + `ECONOMY_SHADOW="false"` + `ECONOMY_REAL_SPEND` 代码默认 `true`）、上游的域名路由、上游的 D1 database_id、上游部署的 Arc 主网合约地址。**照原样自托管部署 = 要么部署失败，要么带着错误的上游绑定跑真钱**。这是 F-1/F-2，整改优先级最高。
5. **自托管公网暴露面**：`POST /tick`、`/reset` 默认无鉴权（仅当设置 `ADMIN_TOKEN` 才上锁）、`POST /stimulus` 按设计无鉴权（可影响蜂群神经状态）、CORS 反射任意 Origin。自托管必须先落 P0 清单。
6. **管理权限现状**：`ADMIN_WALLET`（0x1068…58B1）目前是**身份声明**（/state + 前端展示），不参与任何鉴权判断；真正的"运营管理权限"= Cloudflare 账户 + secrets + `ADMIN_TOKEN`；真正的"资金最高权限"= `ECONOMY_MNEMONIC`。补齐路径见 §5。

---

## 2. api.muros.live 评估结论

**它是什么**：上游团队用同一套开源代码跑在 Cloudflare 上的正式生产实例（Arc 主网 chainId 5042、真实 USDC 结算、MIT 协议、联系人是上游 X 账号 @murmur_arc）。你探测到的 `/population` 返回的 24 只苍蝇、tickIndex、温度等结构与你的本地 Worker 完全同源。

**对系统的三类正当用途（只读）**：

| 用途 | 说明 |
|---|---|
| ① 对照回归基准 | 升级/改造后，用 `GET /population`、`/state`、`/economy` 的响应结构与你的部署逐字段比对，确认移植保真、无字段漂移 |
| ② 上游新特性雷达 | 生产版暴露了公开仓库快照里**没有**的端点：`/openapi.json`、`/manifest`、`/manifest/replay`、`/lineage`、`/lineage/{hash}`、`/lineage/verify`（大脑清单链上锚定、基因组血统）。想要可以按仓库后续版本选择性移植 |
| ③ 生态情报 | 通过 X/GitHub 跟踪上游公告、合约地址变更、安全修复 |

**三条纪律（不要做）**：
1. **运行时零依赖**：你的部署绝不调用它做数据源、绝不前端代理转发到它——上游限流/停服/改字段都会变成你的故障。
2. **支付元数据不指向它**：修复 F-3（`state.ts:1142` 的 `resource` 硬编码），否则买方签署的 EIP-3009 授权里引用的是上游域名，审计溯源错乱。
3. **不把它的合约地址当自己的**：wrangler.toml 里的 registry/arena 地址是上游部署的合约，resolver 是上游钱包（0x2b9a…055c）——你的钱包调用只会浪费 gas 或被 revert。

---

## 3. 信任模型与密钥架构（现状，好的部分）

- **双经济层隔离**：内部 x402 代理经济（Arc/EVM）与外部 meme 执行层（Solana/Base）完全分离，`portfolio.ts` 明确要求执行钱包**不得**复用经济钱包（fund isolation）。
- **默认安全**：无 `ECONOMY_MNEMONIC` 时经济层自动降级为 keyless 模拟器并**大声告警**（state.ts:272-276）；执行层缺任何一旗都在签名前抛错（P0-5 第 4 军旗设计）。
- **x402 结算安全**：买方自己签 EIP-712 授权（买方私钥 HD 派生自种子），中继 facilitator 只持有 gas 钱包、从不托管买方资金、只能转买方明确签名的金额；结算前**重新读取链上真实余额**（链是唯一权威）；`maxAmountAtomic` 每笔硬顶 + `signal.maxUsdc` 外层双保险；`ECONOMY_SHADOW="true"` 时签名 + eth_call 模拟但零广播（零成本验证整条链路）。
- **kill switch 体系**：`ECONOMY_REAL_SPEND=false`（全停）、`PREDICT_ENABLED=false`、`EXECUTION_REAL_SPEND=false`、`EXECUTION_SIGNING_ENABLED=false`、`ECONOMY_DAILY_CAP`/`ECONOMY_PER_AGENT_DAILY_CAP`、`MAX_DAILY_VOLUME_USDC`。
- **神经溯源**：每笔真实转账的 EIP-3009 nonce = 神经回执的 sha256（`/proofs`、`/proofs/verify`），可独立复核"是神经元而非人工下单"。
- **.dev.vars 当前为 keyless 影子配置**：无任何真实密钥（已核对），rsync 打包流程排除 `.dev.vars`，不会进发布包。

---

## 4. 发现清单（按严重度）

> 严重度针对"自托管公网运营"场景。H=部署阻断/资金风险，M=需在上线前处置，L=加固项，I=须知/决策项。

### F-1【H】上游生产"真金白银"配置随代码提交
- **位置**：`packages/trader-worker/wrangler.toml`（L82 `ECONOMY_FACILITATOR="onchain"`、L96 `ECONOMY_SHADOW="false"`）+ `src/config.ts:402`（`ECONOMY_REAL_SPEND` 默认 `"true"`）。
- **影响**：自托管者一旦执行 `wrangler secret put ECONOMY_MNEMONIC` 并部署，**每一分钟 cron 都会在 Arc 主网广播真实 USDC 转账**，没有任何二次确认。
- **整改**：自托管基线必须先改为 `ECONOMY_FACILITATOR="simulated"`（或 `onchain`+`ECONOMY_SHADOW="true"`），显式写 `ECONOMY_REAL_SPEND="false"`；随后按 §9 纪律逐旗点亮。此改动建议直接改在仓库默认值里（安全默认原则）。
- **✅ 整改状态（v1.4 已落地）**：`config.ts` 默认值已改 `false`（只设助记词永远无法广播）；wrangler.toml 已重写为安全基线（simulated / shadow=true / REAL_SPEND=false 显式 / PREDICT 与 ARENA false / CIRCLE off）。

### F-2【H】上游基础设施绑定残留
- **位置**：wrangler.toml——`routes`（api.muros.live 自定义域）、`[[d1_databases]] database_id="a48ee596-…"`（上游 D1）、`ECONOMY_REGISTRY_ADDRESS="0x94d0…"`（上游 registry 合约）、`ARENA_ADDRESS="0xaf1ae6…"` + `ARENA_ENABLED="true"` + `ARENA_TOKEN="0x8faa…"`（上游 PredictionArena + MURMUR 代币）、注释中的上游 facilitator 钱包（0x2b9a…055c）/部署者（0x307D…3a0d）。
- **影响**：域名与 D1 你没有所有权 → 部署失败或错绑；registry/arena 是上游合约且 resolver 是上游钱包 → 你的调用 revert、烧 gas；`ARENA_ENABLED="true"` 会让 Worker 尝试扮演它无权扮演的 resolver。
- **整改**：换成自己的域名路由、`wrangler d1 create` 新库并 `--file=./schema.sql` 初始化、`ECONOMY_REGISTRY_ADDRESS`/`ARENA_*` 置空或部署**自己的**合约（contracts/README.md 有部署流程）、`ARENA_ENABLED="false"` 起步。
- **✅ 整改状态（v1.4 已落地）**：routes 注释化、D1 id 占位化（`REPLACE_WITH_YOUR_OWN_D1_DATABASE_ID`）、registry/arena/token 地址全部注释化，①②③ 步骤指引已内嵌 wrangler.toml。

### F-3【M+】x402 支付 resource 硬编码上游域名
- **位置**：`src/state.ts:1142` `resource: "https://api.muros.live/signal/pulse"`。
- **影响**：付费信号产品的支付要求里，resource 字段永远是上游域名——买方签名授权与审计溯源指向错误实体。
- **整改**：从请求 URL 动态推导，或新增 `SIGNAL_RESOURCE` 变量（默认 `new URL(req.url).origin + "/signal/pulse"`）。
- **✅ 整改状态（v1.4 已落地）**：SIGNAL_RESOURCE 覆盖 + 请求 origin 自动推导双路径；本地实测 `/signal/requirements` 返回 `resource = http://127.0.0.1:8787/signal/pulse`。

### F-4【H·仅公网】变更类端点默认无鉴权
- **位置**：`src/state.ts:557-558`（`POST /tick`、`POST /reset` 经 `adminGate`，而 `adminGate` 在未设 `ADMIN_TOKEN` 时直接放行，state.ts:1549-1555）。
- **影响**：任何人可触发 tick（放大 Worker CPU/DO 写入消耗）或 **/reset 清空整个蜂群与经济状态**。
- **整改**：自托管第一步 `wrangler secret put ADMIN_TOKEN`（强随机 ≥32 字节）。前端/本地 ticker 携带 `x-admin-token` 头。建议同时给 `GET /state` 的 `config` 块保持现状（无敏感值）。
- **整改状态**：门控机制已内置于 `adminGate`（v1.4 未改代码）；**部署即设**保留为部署者操作项（§6 P0-④）。

### F-5【M·决策项】POST /stimulus 按设计无鉴权
- **位置**：`src/state.ts:1515-1527`；限流 = `CF-Connecting-IP` 每 30 秒一条（`STIMULUS_COOLDOWN_SEC`）。
- **影响**：访客可注入刺激改变蜂群神经唤醒度，间接影响交易倾向。作为艺术品是特性，作为交易平台是治理面。
- **整改（三选一）**：保留（接受影响）/ 纳入 `adminGate` / 用 Turnstile 人机校验。建议自托管初期纳入 adminGate。
- **✅ 整改状态（v1.4 已内置选项）**：新增 `STIMULUS_ADMIN_ONLY` 开关（默认 false = 原行为；置 true 即纳入 ADMIN_TOKEN 门控）。

### F-6【L-M】CORS 反射任意 Origin
- **位置**：`src/index.ts:35` `origin = request.headers.get("Origin") ?? …`，随后原样回填 `Access-Control-Allow-Origin`；`FRONTEND_ORIGIN="*"`。
- **影响**：全端点任意网站可跨域读取（数据全公开场景下尚可接受），任意源可 POST（无 Cookie 凭据故 CSRF 风险低，但放大被脚本滥用面）。
- **整改**：若定位为公开只读 API，可保留反射但把**变更类**端点（/tick、/reset、/stimulus）改为仅允许白名单 Origin 或直接不返回 CORS 头；至少把 `FRONTEND_ORIGIN` 收敛为自己的前端域。
- **✅ 整改状态（v1.4 已内置选项）**：新增 `CORS_ALLOW_ORIGINS` 白名单（设置后仅白名单 Origin 获得 ACAO 头；未设置保持遗留反射行为，兼容性零破坏）。

### F-7【L】无限流/WAF/防刷
- **现状**：Worker 无内置限流；读端点全公开（/economy、/wallets 级数据、/history 无上限 limit 校验需复核）；未发现 /openapi.json（上游生产有，快照无）。
- **整改**：Cloudflare WAF 规则（tick/stimulus 端点按 IP 限速）、`/history` 等 limit 参数钳制、必要时 Turnstile。

### F-8【L·须知】/state 暴露 rpcUrl 的边界
- **位置**：`src/state.ts:958` → `config.ts:364-367`：`rpcUrl` 只来自 `RPC_URL` **变量**或公共 RPC；付费私有端点在独立字段 `alchemyArcRpcUrl`（仅 chain.ts 内部回退用，**不经 /state 输出**）——已验证不泄露。
- **纪律**：带 key 的 RPC **只能**放 `ALCHEMY_ARC_RPC_URL`（secret），**绝不**写进 `RPC_URL`（var，会经 /state 公开且随代码提交）。

### F-9【I】密钥治理——最高权限 = ECONOMY_MNEMONIC
- **事实**：一枚 BIP-39 种子 HD 派生全部代理钱包（m/44'/60'/0'/0/{id}）+ gas 钱包（accountIndex 2,000,000，**非标准路径**——通用钱包 App 无法直接导入，好处是隔离，坏处是恢复需用本仓库代码/工具）。
- **自托管守则**：专用助记词（不与其他资产混用）→ 离线双备份（钢板/纸）→ 只注入 `wrangler secret`（绝不进 git/.dev.vars 提交）→ 最小资金起步 → 可选 `ECONOMY_FACILITATOR_PK` 让 gas 钱包独立于种子 → 制定轮换预案（换种子 + /reset 重建代理）。

### F-10【I】ADMIN_WALLET 的真实语义
- **现状**：仅身份声明——`/state.config.adminWallet` + 前端 admin 行 + explorer 链接；**不参与任何鉴权/签名**（config.ts:337-345 注释明确 "identity only, never signs"）。
- **若要"名实相符"**（让 0x1068…58B1 成为可验证的运营权限根）：新增"admin 操作需出示该钱包对 (timestamp, action) 的 EIP-712 签名，Worker 用 ecrecover 校验地址一致"的门槛，替代/叠加共享令牌型 ADMIN_TOKEN。可作为 P2 演进（当前 ADMIN_TOKEN 已足够安全运营）。

### F-11【L】前端与供应链
- 前端无第三方 JS 库（纯原生 module）；Google Fonts 外链（隐私/可用性考虑，可自托管字体文件）；X/GitHub 链接与 MURMUR 代币 CA 展示属上游品牌残留，白牌化时替换（`index.html` token-ca 块、topbar 链接、根 package.json `homepage`）。
- app.js 使用 innerHTML 渲染动态数据，执行面板此前已实现 XSS 转义；建议补一层 CSP 响应头（Pages 端 `default-src 'self'`+fonts）作纵深防御。
- 依赖包初判无可疑（viem/@solana/web3.js/bs58/wrangler/typescript 等）；自托管前跑 `npm audit --omit=dev` 并提交 lockfile，后续开启 Dependabot。

### F-12【I】上游生产版领先于公开快照
- muros.live 已有 `/openapi.json`、`/manifest`、`/lineage` 等快照中不存在的端点——上游迭代快于公开仓库。跟踪仓库更新，选择性移植；不要假设你的快照 = 上游生产行为。

---

## 5. 管理权限矩阵（"全部管理权限"的真相与补齐）

| 权限维度 | 载体 | 现状 | 你是否已掌握 |
|---|---|---|---|
| 基础设施 | Cloudflare 账户（Worker/DO/D1/Pages/WAF） | 自托管即你的账户 | ✅ 注册即得 |
| 运营权限根 | `ADMIN_TOKEN` secret | 可选未设 | ⚠️ 上线前必须设置（F-4） |
| 资金最高权限 | `ECONOMY_MNEMONIC` secret（派生全部钱包+gas） | 无种子=keyless 模拟 | ⚠️ 你生成、你离线备份、你注入 |
| 声明式管理身份 | `ADMIN_WALLET`（0x1068…58B1） | 仅展示，无鉴权效力 | ✅ 已生效（v1.3） |
| 链上合约控制 | NeuralReceiptRegistry / PredictionArena | **上游的合约、上游的 resolver** | ❌ 需自部署自己的合约（可选特性） |
| 数据主权 | D1（历史归档）+ DO storage（活状态） | 自托管即你的库 | ✅ 换 database_id 即得 |
| 域名/品牌 | routes + 前端品牌残留 | 上游域名/代币 CA/X 链接 | ⚠️ 白牌化清单（F-11） |

**结论**：自托管 + 设置 ADMIN_TOKEN + 自有种子 + 自有合约后，你对系统拥有**完整的运营与安全自主权**——代码里没有钥匙握在上游手里的后门（这点已审计确认）。

---

## 6. 自托管迁移安全清单

### P0 —— 第一次部署之前（阻断级）

> **整改进度**：①③⑤（代码侧）+ F-3 修复已在 **v1.4** 落地；②的 D1 创建、④的 ADMIN_TOKEN 注入、⑥的助记词备份/注入仍属**部署者操作项**。
- [x] wrangler.toml 安全基线：`ECONOMY_FACILITATOR="simulated"`、`ECONOMY_SHADOW="true"`、显式 `ECONOMY_REAL_SPEND="false"`、`ARENA_ENABLED="false"`、`PREDICT_ENABLED="false"`（✅ v1.4 已落地）
- [x] routes / D1 **占位化**（✅ v1.4 已落地，①②指引内嵌）→ 部署者需：`wrangler d1 create` 新库 + 填入自己的 `database_id` + 取消注释自己的域名路由
- [x] 清空/替换 `ECONOMY_REGISTRY_ADDRESS`、`ARENA_ADDRESS`、`ARENA_TOKEN`（✅ v1.4 已全部注释占位，部署自己的合约后再填入）
- [ ] `wrangler secret put ADMIN_TOKEN`（强随机）
- [x] 修复 F-3（resource 域名参数化：SIGNAL_RESOURCE + 请求 origin 推导，✅ 已实测）
- [ ] 生成**专用**助记词 → 离线双备份 → 需要真钱时才 `wrangler secret put ECONOMY_MNEMONIC`
- [x] 确认 `.gitignore` 覆盖 `.dev.vars`、`.wrangler/`；secrets 永不落代码（✅ 已核验覆盖）

### P1 —— 上线第一周
- [ ] WAF：对 `/tick`、`/reset`、`/stimulus` 按 IP 限速；管理路径可加 Cloudflare Access
- [ ] CORS 收敛：`FRONTEND_ORIGIN`=自己的前端域；变更端点不做 Origin 反射
- [ ] `/stimulus` 决策：adminGate 或保留（F-5 三选一）
- [ ] `npm audit` + lockfile 提交 + CSP 头
- [ ] 监控：/health 拨测、ECONOMY_DAILY_CAP 消耗告警、D1 行数增长观察
- [ ] 白牌化：代币 CA 展示块、X/GitHub 链接、package.json homepage、README 品牌句

### P2 —— 常态化
- [ ] 跟踪上游仓库，选择性移植 /manifest、/lineage、/openapi.json
- [ ] ADMIN_WALLET 签名式权限演进（F-10 方案）
- [ ] 密钥轮换演练（换种子 → /reset → 验证 → 弃旧种子）
- [ ] 合约自主化：部署自己的 NeuralReceiptRegistry/PredictionArena（resolver=自己的 facilitator）

---

## 7. 附录

### 7.1 运行时外部端点全清单（静态审查结果，全部公开服务）
| 域 | 用途 | 密钥 |
|---|---|---|
| rpc.mainnet/testnet.arc.io（+drpc/quicknode/blockdaemon 回退） | Arc RPC 读写 | 公共免钥；私有端点走 ALCHEMY_ARC_RPC_URL |
| api.dexscreener.com | meme 对数据（Solana/Base/ETH） | 免钥 |
| mainnet.helius-rpc.com / api.helius.xyz | P0-1 Solana 数据源 | HELIUS_API_KEY（可选） |
| streaming.bitquery.io/graphql | 备选 GraphQL 源 | BITQUERY_API_KEY（可选） |
| lite-api.jup.ag / api.jup.ag | Solana 报价/交换/价格 | 免钥/可选 JUPITER_API_KEY |
| api.0x.org | EVM 交换 | ZEROX_API_KEY |
| api.circle.com | 官方 x402 中继（external 模式） | 免钥试用/可选 CIRCLE_API_KEY |
| api.pinata.cloud / ipfs.io | 回执 Pin/网关 | 可选 PINATA_JWT |
| fonts.googleapis.com | 前端字体（静态） | — |

**未发现**：对 muros.live 的运行时调用、遥测/统计上报、eval/混淆、非常规域名。

### 7.2 Secret 清单（自托管需要用 wrangler secret 注入，绝不进代码）
`ADMIN_TOKEN`（必设）、`ECONOMY_MNEMONIC`（真钱时）、`ECONOMY_FACILITATOR_PK`（可选）、`ALCHEMY_ARC_RPC_URL`（可选）、`HELIUS_API_KEY`/`BITQUERY_API_KEY`（meme 源升级时）、`SOLANA_PRIVATE_KEY`/`SOLANA_RPC_URL`/`EVM_PRIVATE_KEY`/`BASE_RPC_URL`/`ZEROX_API_KEY`（执行层实盘时）、`CIRCLE_API_KEY`（量大后）、`PINATA_JWT`（可选）。

### 7.3 本地实例现状
murmur-work 本地守护进程（Worker :8787 + 前端 :3000 + 30s ticker）运行 keyless 影子模式：`EXECUTION_REAL_SPEND="false"`、`EXECUTION_SIGNING_ENABLED="false"`、无任何密钥——审计期间持续存活（tick 1000+），符合 §9 阶段 B 纪律。

---

## 8. 自主权专项审计（Sovereignty Audit · v1.2 增补）

> 审计命题："我指向自己域名后，上游能不能通过代码拿走本属于我的钱？"
> 审计方法：全库 `0x…40hex` 地址扫描（运行时代码 / 合约 / 脚本 / 前端 / 配置五层）+ x402 收款路径逐行走读 + 上游 origin/main（71 commit 未合并）收款要素对比 + 支付不变量测试复核。

### 8.1 结论 A：本地 v1.4 运行时代码——零上游收款钱包 ✅

全库扫描命中的地址分四类，**无一属于上游个人钱包**：

| 类别 | 地址 | 性质 |
|---|---|---|
| 协议资产常量 | `ARC_USDC 0x3600…0000` / `USDC_BASE 0x8335…2913` / `USDC_ETH 0xA0b8…eB48` | 公链官方 USDC 合约，是"钱"不是"收款人" |
| decimals 已知表 | BRETT / PEPE / USDC（decimals.ts） | 公共代币合约，仅用于精度换算 |
| 代币 CA 展示 | MURMUR `0x8faa…4a5d`（前端 token 行） | 上游发行的代币合约展示位，不收款、不签名 |
| 测试 fixture | `0x22…22` 等（*.test.ts） | 非运行时 |

管理/收款声明的唯一位点 = `ADMIN_WALLET` + `SIGNAL_PAYTO`，均已显式指向 **0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1**（部署者本人钱包）。

### 8.2 结论 B：x402 收款链路走读——钱只能到配置的 payTo ✅

付费信号（/signal/pulse）的每一笔收款都经过三层控制：

1. **显式 payTo**：`SIGNAL_PAYTO`（wrangler.toml [vars]，非机密地址声明）→ 实测 `/signal/requirements` 返回 `payTo = 0x1068…58B1` ✅；未设时回落到 facilitator gas 钱包 = **从部署者自己的 `ECONOMY_MNEMONIC` HD 派生**（accountIndex 2,000,000）——两层都只会是部署者自己的地址。
2. **买方签名硬校验**：`x402.ts` settle 路径对每笔 `TransferWithAuthorization` 执行 `auth.to === payTo` 严格比对（`payTo mismatch` ⇒ 拒绝，有专项单测），买方资金不可能被导流到第三地址。
3. **Facilitator 不托管资金**：Simulated（本地）零链上；OnChain 模式 facilitator 只广播不碰钱；Circle external 默认 `off`，开启后也仅是代付 gas 的 relayer（Task 实测结论），收款方仍是 payTo。

代理经济体（agent 互购）为**零和账本**：`economy.test.ts` 有"money conserved"不变量测试（总量 ≡ 初始注资 + treasury 补液，无任何抽成/铸币路径）。

### 8.3 结论 C：上游未合并 71 commit 中的收款要素（合并红线）⚠️

上游 wrangler.toml 生产配置（未进入本地代码包）存在以下**上游归属**地址：

| 上游配置项 | 地址 | 性质 |
|---|---|---|
| `EVOLUTION_TREASURY` | `0x307D8a9333Bd3e4FCe93FfAC6468eB7478423a0d` | **上游项目部署者钱包，收取每次繁殖费（breeding fee）** |
| `WAR_ADDRESS` | `0x3d900b…454b` | 上游部署的 WarCoffer 合约（战争/税收层） |
| `ARENA_ADDRESS` / `ARENA_TOKEN` | `0xaf1a…8525` / `0x8faa…4a5d` | 上游部署的竞技场合约 / MURMUR 代币 |
| `ECONOMY_REGISTRY_ADDRESS` / `MANIFEST_REGISTRY_ADDRESS` / `LINEAGE_ADDRESS` | `0x94d0…` / `0x3412…` / `0x482b…` | 上游部署的三条链上存证合约 |

**合并红线**：上游 71 commit 的**代码层**（src/）经扫描零钱包硬编码——war/breeding 逻辑全部读配置，可合并；但**配置层绝不可照抄**——合并后必须保持本包 v1.4 安全基线：`EVOLUTION_TREASURY` 若启用繁殖功能则改设为自己的收款地址，WAR/ARENA/REGISTRY 等合约要么注释（关闭该垂直功能）要么用**自己的钱包重新 deploy 换地址**。任何上游部署的合约其 resolver/owner 权限都握在上游 facilitator 手里，接入即受制于人。

### 8.4 结论 D：API 完全自主，无需"另起协议" ✅

- **运行时零上游依赖**：全库 `muros` 域名扫描在运行时代码（src/ + public/）零命中；数据源 = Arc 公共 RPC + DexScreener + Jupiter/0x（第三方行情协议，与上游无关）。指向自己域名后，所有 API（/state、/population、/economy、/execution/logs、/signal/* 等 18 个端点）都是**自己 Worker 的路由**——API 的"自主权"天然成立，不存在"用上游 API"的问题。
- **对外商业化已就绪**：付费信号走 **x402 开放协议**（IETF 草案标准，机器可读 PaymentRequirements），任何支持 x402 的买方 agent 都可对接；`/openapi` 能力上游也已实现（合并后可用）。resource 自域推导（F-3 修复）保证付费页永远展示自己的域名。
- **商业化建议**：自有域名部署后，① `SIGNAL_RESOURCE` 显式设为 `https://api.你的域名/signal/pulse`；② 商业推广材料可直接引用 `/openapi.json` 与 API.md（上游 71 commit 新增，合并后可用）；③ 若接 Circle 结算提升吞吐，用 `CIRCLE_API_KEY`（Bearer 模式）而非 payTo 私钥托管。

### 8.5 自主权收尾清单

| # | 事项 | 状态 |
|---|---|---|
| 1 | `ADMIN_WALLET` = 部署者钱包 | ✅ v1.3 已设 |
| 2 | `SIGNAL_PAYTO` = 部署者钱包（显式收款） | ✅ v1.2 本轮已设并实测生效 |
| 3 | 上游域名/合约/钱包配置残留 | ✅ v1.4 基线已全部清除 |
| 4 | 买方签名 payTo 硬校验 | ✅ 代码级 + 单测保障 |
| 5 | 合并上游时丢弃其生产配置（红线） | ⚠️ 待未来合并时执行（§8.3） |
| 6 | 繁殖功能若启用 → `EVOLUTION_TREASURY` 改设自己地址 | ⚠️ 同上 |
| 7 | WAR/ARENA 等上游合约不接入；要玩用自己的钱包重新 deploy | ⚠️ 同上 |

## 9. 合并专项执行记录（v1.3 增补 · 红线纪律已执行）

> §8.3 收尾清单第 5/6/7 项原为「待未来合并时执行」。2026-09-22 上游合并专项完成，红线全部落地，本节为执行存证。

### 9.1 合并事实
- 基点：`b53c83a`（2026-09-19，zip 快照经双子树哈希指纹精确定位，快照树与基点严格一致）
- 方式：`git replace --graft` 连接历史后真三方合并（非手工搬运），上游 53 个 commit 落地
- 规模：上游改动 83 文件（47 全新：war/community/chronicler/culture/evolution/manifest/openapi/i18n/contracts…），
  冲突面 36 文件（7 真内容冲突手工解、18 直取上游、11 适配/并集），我方 meme/execution/F-3/F-5/F-6/admin-wallet 全保留
- 验证：typecheck PASS；单测 204 → **437/437 全绿**（fly-brain 47 + trader-worker 366 + arc 24）

### 9.2 红线执行结果（对应 §8.3 清单）
| # | 红线项 | 执行结果 |
|---|--------|---------|
| 5 | 合并时丢弃上游生产配置 | ✅ 上游 LIVE 旗（WAR_ENABLED/WAR_BOOTSTRAP/CONFLICT_ENABLED=true、ECONOMY_SHADOW=false）一律未照抄；新模拟层全部以关闭态移植，合并后默认行为=合并前影子基线（逐字节） |
| 6 | EVOLUTION_TREASURY | ✅ 上游部署者钱包 0x307D…3a0d 未进入任何配置；wrangler.toml 注释预填本部署钱包 0x1068…58B1 |
| 7 | WAR/ARENA/上游合约不接入 | ✅ WAR_ADDRESS 0x3d90…454b / LINEAGE 0x482b…8096f / MANIFEST 0x3412…29a37 全部剔除；contracts/*.txt 部署记录清空为占位；要玩 = 跑 scripts/deploy-*-auto.mjs 部署自己的合约 |

### 9.3 前端自主权切断（本次新发现并处置）
- 前端默认 API 基址原为 `https://api.muros.live`（上游生产服务器）——已切断为同源 `/api`；
  community.js / developers.html / openapi.ts / deploy 脚本同步清洗，`muros.live` 在 packages/ 运行时零残留
- `signalRequirements` 保留我方 F-3 修复（resource 从请求 origin 推导），拒绝上游 1-arg 回退
- 付费收款链路实测：`/signal/requirements → payTo = 0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1` ✅

### 9.4 遗产与边界（诚实声明）
- 上游部署的 WarCoffer/Registry/Lineage/Arena 合约字节码随源码进入仓库（contracts/ 目录）——这是部署工具与
  源码遗产，非接入；其任何部署地址都不在配置/前端/文档示例中
- SECURITY.md / CHANGELOG 历史章节保留上游叙述（纯文档，非运行时路径）
- `wrangler.toml` 的 `[igrations]]` 拼写错误系上游原生 bug，本次合并顺手修复（`[[migrations]]`）
