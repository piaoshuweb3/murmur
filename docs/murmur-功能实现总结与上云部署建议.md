# murmur 功能实现总结与上云部署建议（2026-09-23 · R4-0 接线后）

> 面向决策：①当前各功能实现到什么程度 ②上云形态怎么选（Cloudflare Workers / VPS / Vercel）③域名怎么买怎么绑
> 配套阅读：`docs/murmur-R3-主网部署报告.md`（六地址表 + R4 逐旗清单）、`docs/murmur-上云部署手册-CLOUD-DEPLOY-RUNBOOK.md`（命令级步骤）

---

## 1. 功能实现总览（14 个 feature，v1.4.0 实测 /health）

| # | Feature | 实现状态 | 资金路径 | 当前运行证据 |
|---|---------|---------|---------|-------------|
| 1 | population（24 蝇群 · 10,800 神经元/只） | ✅ 常驻运行 | 零 | 24 agents · territory/societies/graveyard 面板活跃 |
| 2 | market-temperature（Arc 全链热度） | ✅ 常驻运行 | 零 | hot 0.46 · 每分钟 cron 采样 |
| 3 | neural-sim（LIF 神经模拟 + 12 分片） | ✅ 常驻运行 | 零 | SHARD_COUNT=12 · tick #20010 |
| 4 | agent-economy-x402（代理经济） | ✅ 影子模式（模拟账本） | 零（REAL_SPEND=false） | 60,074 deals · 84.853 USDC settled · GINI 0.08 |
| 5 | prediction-market（蜂群链上预测） | ✅ 影子模式（模拟 USDC 下注） | 零 | round #2892 在注 · 43,084 轮 · 24 bettors · 命中率 36.8% |
| 6 | human-arena-murmur（人机竞技场） | ✅ **R4-0/R4-1 已接线主网**（读路径全通；开轮写路径待武装，见 §4） | MURMUR 托管（合约层，非托管给 Worker） | /arena enabled=true · 合约 0x0243…16B60 已渲染到前端抽屉 |
| 7 | community-governance（token-gated 论坛） | ✅ 代码就绪（R4-4 待开旗） | 零（只读 balanceOf 门禁） | COMMUNITY_TOKEN 已接线本部署 MURMUR |
| 8 | d1-history-archive（编年史归档） | ✅ 就绪（云端建 D1 后生效） | 零 | schema.sql 惰性建表 |
| 9 | brain-manifest-provenance（生产脑锚定） | ✅ **主网已锚定** | 零托管 | manifestHash 0x403551bb…f6efc02 上链 commitCount=1 |
| 10 | connectome-breeding-lineage（繁殖+血统） | ✅ 就绪（R4-3 待开旗） | EIP-3009 繁殖费直付 ADMIN | Lineage 0xCbe9…aB07 全新 commitCount=0 |
| 11 | public-api-openapi | ✅ | 零 | /openapi.json + /developers.html |
| 12 | meme-monitoring-optional | ✅ 本地开启（三链 10 币免钥源） | 零 | dexscreener 源 · 影子温度融合 |
| 13 | external-execution-shadow-optional | ✅ 影子模式（P1-1） | 零（REAL_SPEND=false） | 20s ticker · 止损五规则挂机 |
| 14 | 竞技场/战争/繁殖 x402 收款终局 | ✅ **全部指向自己的钱包** | — | SIGNAL_PAYTO = ADMIN `0x1068…58B1`；六合约 RESOLVER = 自己的 facilitator |

**主权红线核验（R4-0 冒烟 28/28 全绿）**：六合约构造参数逐项回读一致；ADMIN 全程零出流零密钥（原生余额恒 0）；USDC precompile decimals=6 与 Worker 结算层/WarCoffer 50 USDC 硬顶三方同约定；九方地址（六合约+precompile+ADMIN+facilitator）无一重合；上游黑名单零命中。

## 2. 三级彩排流水线终局 + R4 进度

| 阶段 | 环境 | 断言 | 状态 |
|------|------|------|------|
| R1 | 本地 anvil fork | 67/67 | ✅ 收官 |
| R2 | Arc 测试网 5042002 | 71/71 | ✅ 收官 |
| R3 | Arc 主网 5042（真 gas） | 29/29 | ✅ 收官（gas 实耗 0.056659 USDC） |
| **R4-0** | **地址接线 + 只读冒烟** | **28/28（链）+ 10/10（HTTP）** | ✅ **2026-09-23 完成（本次）** |
| R4-1 | ARENA 开旗 | 读路径已通；**写路径（openRound/resolve）待武装** | 🟡 旗已开、轮未开 |
| R4-2/3/4 | WAR / EVOLUTION / COMMUNITY | 待用户逐旗放行（每旗观察 ≥24h） | ⏳ 旗全关 |

## 3. 上云形态专业建议：Cloudflare 原生是唯一正解，Vercel 只能当静态壳

**结论先行：不要用 Vercel 跑这个项目。** murmur 的后端是 Cloudflare Workers 专用形态——Durable Objects（蝇群状态/神经模拟的强一致状态机）、D1（编年史 SQLite）、Workers Cron（每分钟 tick）。这三样 Vercel 都没有对等物：Vercel Functions 是无状态 + 有执行时长上限的 Serverless 函数，DO 的"单实例强一致状态"在 Vercel 上需要自己搭 Redis/Postgres 重建，等于重写半个系统。

| 维度 | 方案 A：Cloudflare Workers + Pages（推荐） | 方案 B：VPS（Hetzner/腾讯轻量） | 方案 C：Vercel |
|------|------|------|------|
| 代码改动 | **零**（wrangler deploy 一条命令） | 需常驻 `wrangler dev`/workerd 容器（不推荐生产）或移植 Node + 换掉 DO/D1（大工程） | 后端跑不了，只能托管静态前端 |
| DO/D1/Cron | 原生支持 | 自建（Redis+SQLite+crontab） | 不支持 |
| 免费额度 | 10 万请求/天 + DO 免费档，本项目绰绰有余 | €4-5/月 起 | 100GB 带宽/月（仅前端有意义） |
| 运维负担 | 零（无服务器，全球边缘） | 证书/备份/监控/防 DDos 全自担 | 零 |
| 适合场景 | **本项目（当前与可预见的全部需求）** | 未来要跑额外守护进程（私有 RPC 中继、盯盘 bot、自建 indexer）时**补充**使用 | 纯静态营销页 |
| 建议动作 | **主平台** | 备选补充 | 不采用 |

**推荐落地路径（与上云手册 C0-C2 一致）**：
1. 用户注册自己的 Cloudflare 账号 → `npx wrangler login`（凭据只在自己机器上）
2. `npx wrangler d1 create murmur-db` → 把 database_id 填进 wrangler.toml ②
3. 先部署到免费子域测 24-48h：`npx wrangler deploy` → `https://murmur.<你的子域>.workers.dev` 全功能自检
4. 域名买好绑上（§5）→ 前端静态（packages/frontend/public）可同域由 Worker 直接托管，或 Pages 托管 + `/api` 反代
5. `wrangler secret put ECONOMY_MNEMONIC`（种子只经你自己的终端，不进任何第三方）→ 按 R4 逐旗开旗

**VPS 什么时候才值得买**：当你需要 7×24 跑"Worker 之外"的东西——私有 Solana/EVM 签名中继、自建 RPC 缓存层、大内存 indexer。届时 Hetzner CX22（€4.5/月）或腾讯云轻量（国内访问快）作为**附属节点**，与 CF 主平台并存，不必迁移。

## 4. R4-1 竞技场"最后一公里"：武装 resolver 的决策说明（需要你拍板）

R4-0 已把六合约地址接进 Worker，竞技场抽屉现在能渲染：live book 框架（read-only 标注）、你的钱包连接、蜂群对比（24 只 · 37% 命中率）、合约 explorer 链接。但**真实轮次还不会开**——开轮/结算需要 resolver 用 facilitator 钥签名，而代码里它与经济层共用同一组"真钱总阀"：

```
driveArena 门槛 = ARENA_ENABLED✓ + ARENA_ADDRESS✓ + ECONOMY_FACILITATOR="onchain"
                + ECONOMY_REAL_SPEND="true" + ECONOMY_SHADOW="false" + 助记词 secret
```

**为什么我没有擅自本地武装**（这次实测读源码得出的两个硬事实）：
1. **冻结效应**：`REAL_SPEND=true` 是全局阀，翻开后代理经济从"模拟账本"切到"链上结算"——24 个 agent 钱包真实 USDC 余额为 0（结算层有链上余额预检），所有结算被拒绝 → 你正在看的钱包面板/EXECUTION LOG 会**静止**（这是审计 F-1 的诚实设计，不是 bug）。解除冻结需先给 24 个 agent 注资真实 USDC（约 1.2 USDC）。
2. **gas 放大效应**：本地 ticker 20s/cron，`PREDICT_COMMIT=true` 在真钱模式下每轮 decisive 预测都会广播链上回执 ≈ 最高 4,320 笔/天 ≈ 5 USDC/天——现有 4.97 USDC 余额一天烧穿。

**给你的两个选项**：
- **选项 A（推荐，零成本）**：维持现状观察影子期（20s ticker 已跑了 P1-1 大半程）。影子期结论出炉后，在**你自己的 CF 凭据环境**按上云手册 C2 一次性布防：`wrangler secret put ECONOMY_MNEMONIC` + wrangler.toml 翻 `ECONOMY_REAL_SPEND="true"`/`ECONOMY_SHADOW="false"`/`ECONOMY_FACILITATOR="onchain"`，同时给 agent 注资 → 竞技场/经济/预测全链路一次点活。云端 cron=1/分钟，竞技场 gas ≈ 0.05 USDC/天，回执锚定 ≈ 0.7-1 USDC/天（不想花就 `PREDICT_COMMIT="false"`）。
- **选项 B（现在就要看开轮）**：明确回复"放行本地武装"，我在本地 `.dev.vars` 一口气布防五项（REAL_SPEND=true + SHADOW=false + onchain + 助记词已就位 + PREDICT_COMMIT=false），下一个 cron 竞技场就开出真实主网轮次（explorer 可见 facilitator 的 openRound tx，gas ≈ 0.06 USDC/天，余额够 ~80 天），代价是本地经济面板冻结（云端不受影响，云端仍走选项 A 节奏）。

**MURMUR 流通前置**（两条选项都适用）：10 亿 MUMUR 100% 在你的 ADMIN 钱包——真人下注需要 MURMUR 到手。你可以随时用 ADMIN 私钥从 treasury 拨一笔到自己的另一把浏览器钱包（比如 10 万 MURMUR）就能开注；零流通时开轮空转无害（空池子照常开/结，派彩为零和）。

## 5. 域名购买与绑定建议

**买在哪**（按推荐顺序）：
1. **Cloudflare Registrar**（首选，前提是先有 CF 账号）：成本价无溢价（.com ≈ $10.44/年，续费同价），免费 WHOIS 隐私，DNS 原生就在 CF——绑 Worker 一条配置的事，少一次搬家。
2. **Porkbun / Namecheap**（备选）：首年促销便宜，DNS 记得迁到 CF（免费）。
3. 若主要面向国内用户且要备案：阿里云/腾讯云注册 + 备案（流程 2-3 周）；纯海外/去中心化受众则完全不必。

**怎么选名**：.com 优先、6-12 字符、避开 "murmur" 这种过于通用的词干被抢注的变体（murmur.ai/.app 大概率被注册）；建议带项目独有词（如 swarm/fly/arc 相关组合）；买前查一次商标库（USPTO/中国商标网）避免侵权风险。

**怎么绑**（买完后 15 分钟）：
1. CF 控制台 Add site → 域名 DNS 托管到 Cloudflare（免费计划）
2. `wrangler.toml` ① 处取消注释并改：`routes = [{ pattern = "api.你的域名.com", custom_domain = true }]` → `wrangler deploy` 自动签发 SSL
3. 前端静态托管到同域（Worker 直接 serve public/ 或 Pages 绑 `www.`）→ 前端 `?api=` / `CORS_ALLOW_ORIGINS` 按手册 F-6 加固收口
4. 社区页/信号页等 `SIGNAL_RESOURCE` 会自动跟随新域名（F-3 修复），无需手改

## 6. 下一步行动清单（按序）

| 步骤 | 谁执行 | 内容 |
|------|--------|------|
| 1 | 你 | 决定 R4-1 选项 A/B（§4） |
| 2 | 你 | 注册 Cloudflare 账号 + 买域名（§5） |
| 3 | 我 | 你放行后执行 R4-1 本地武装（选项 B）或继续影子期观察（选项 A） |
| 4 | 你 | CF 环境跑上云手册 C0-C2（D1 创建 → wrangler deploy → workers.dev 自检 24-48h） |
| 5 | 你 | 域名绑定 + secret 布防 + 逐旗开旗（R4-2 WAR → R4-3 EVOLUTION → R4-4 COMMUNITY，每旗间隔 ≥24h） |
| 6 | 我 | 每旗开旗时给冒烟断言脚本 + 回滚阀，gas 台账每日盯 |
