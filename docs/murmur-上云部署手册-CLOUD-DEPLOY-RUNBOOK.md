# murmur 逐步上云部署手册（含逐旗点亮检查点）

> **版本 v1.4** · 2026-09-20 · 适用代码基线：`CHANGELOG v1.4.0`（自托管就绪版）
> 配套文档：《murmur-安全审计报告-SECURITY-AUDIT.md》（F-1~F-12 发现与整改溯源）、《docs/AGENT-ECONOMY.md》（经济层机制）、《二次开发技术实现路径与任务清单.md》（§9 阶段 A→B 上线路径）
>
> **本手册回答一个问题：如何把 v1.4 代码从零部署到你自己的 Cloudflare 账户，并把每一面"真钱旗"按安全顺序逐一点亮，每一步都有可执行的验证命令与回滚命令。**

---

## 0. 阅读须知：旗（Flag）与检查点（Checkpoint）

本系统的一切真钱行为都由**旗**控制。v1.4 的承诺是：**一面旗都不点亮，系统一分钱也动不了**（无助记词时经济层自动降级为 keyless 模拟器；执行层缺任何一旗都在签名前抛错）。上云部署因此不是"一次部署到位"，而是：

```text
部署（全旗熄灭）──→ 验证 ──→ 点亮 1 面旗 ──→ 验证 ──→ … … ──→ 实盘
```

- **旗**：一个环境变量或 secret，只有 var（明文、随 wrangler.toml 提交）与 secret（`wrangler secret put` 加密注入）两类。**任何私钥/助记词/API key 永远不进 wrangler.toml、不进 git**。
- **检查点**：编号 `C<阶段>-<序号>`（如 C2-3）。每个检查点给出【命令】【期望输出】【不通过时怎么办】。**当前阶段检查点未全部通过前，禁止执行下一阶段的点亮命令**——这是本手册唯一需要严格遵守的纪律。
- **回滚**：每个阶段都附带回滚命令。所有回滚都是"把旗翻回去 + 重新 deploy"，无需删库。

### 全旗位图（先看全景，再逐个点亮）

```text
┌─ 管理面（先点亮，保护后面所有操作）──────────────────────────────┐
│ [A1] ADMIN_TOKEN            secret  ✦ 第一优先：锁死 /tick /reset │
│ [A2] CORS_ALLOW_ORIGINS     var     ✦ 白名单你自己的前端域名       │
│ [A3] STIMULUS_ADMIN_ONLY    var     ◦ 决策项（公网建议 true）      │
│ [A4] 自定义域名 + WAF 限速   CF 面板  ◦ P1 周内完成               │
└──────────────────────────────────────────────────────────────┘
┌─ 经济层（内部 x402 代理经济 · Arc 主网 USDC）─────────────────────┐
│ [F1] ECONOMY_FACILITATOR    var     simulated ──→ onchain        │
│ [F2] ECONOMY_MNEMONIC       secret  (未设) ──→ 注入专用种子        │
│ [F3] ECONOMY_SHADOW         var     true ──→ false（先影子后实盘） │
│ [F4] ECONOMY_REAL_SPEND     var     false ──→ true（最后点亮）     │
│ [F5] ECONOMY_DAILY_CAP=20   var     ✦ 护栏，点亮 F4 前必须确认     │
└──────────────────────────────────────────────────────────────┘
┌─ 执行层（外部 meme 交易 · Solana/Base，四旗联锁）──────────────────┐
│ [E1] MEME_ENABLED           var     false ──→ true（仅监控）      │
│ [E2] EXECUTION_ENABLED      var     false ──→ true（shadow=true） │
│ [E3] EXECUTION_SIGNING_ENABLED var  false ──→ true（第 4 军旗）    │
│ [E4] EXECUTION_REAL_SPEND   var     false ──→ true（最后点亮）     │
│ 护栏: MAX_PER_TRADE_USDC=1~2 · MAX_DAILY_VOLUME_USDC=50 · EXIT_* │
└──────────────────────────────────────────────────────────────┘
┌─ 可选链上模块（经济层实盘验证干净后才允许碰）────────────────────────┐
│ [O1] PREDICT_ENABLED        var     false ──→ true                │
│ [O2] ARENA_ENABLED(+自有合约) var    false ──→ true                │
│ [O3] ECONOMY_REGISTRY_ADDRESS(自有合约) · [O4] Circle facilitator │
└──────────────────────────────────────────────────────────────┘
```

**两条不可逾越的红线**（来自安全审计 F-1/F-2）：

1. **资金隔离**：执行层钱包（`SOLANA_PRIVATE_KEY` / `EVM_PRIVATE_KEY`）必须与经济层钱包（`ECONOMY_MNEMONIC` 派生）完全独立，两套种子互不复用。
2. **自有资源**：路由域名、D1 数据库、NeuralReceiptRegistry / PredictionArena 合约地址，一律用自己的——v1.4 的 wrangler.toml 已把上游绑定全部清除为占位（①②③标记），照着填即可。

---

## 1. 目标拓扑

部署完成后，你的云上系统长这样：

```text
                       ┌──────────────────────────────────────────┐
   浏览器 ── HTTPS ──→ │ Cloudflare Pages（静态前端）               │
                       │  packages/frontend/public                 │
                       │  murmur.pages.dev / www.your-domain.com   │
                       └───────────────┬──────────────────────────┘
                                       │  fetch("/api/…")（同源代理）或直连 API 域
                                       ▼
                       ┌──────────────────────────────────────────┐
   cron 每分钟 ──────→ │ Cloudflare Worker "murmur"（v1.4.0）      │
   （平台自动触发）      │  api.your-domain.com  或 *.workers.dev    │
                       │  · FlyStateDO（协调者 DO，SQLite 状态）     │
                       │  · FlyShardDO ×12（SHARD_COUNT=12 分片脑） │
                       │  · 读 Arc 主网（rpc.mainnet.arc.io）       │
                       └───────┬──────────────────┬───────────────┘
                               │                  │
                               ▼                  ▼
                       ┌──────────────┐   ┌──────────────────────────┐
                       │ D1 murmur-db │   │ Arc 主网 (chainId 5042)   │
                       │ 每 cron 一行  │   │ 只读采样 / EIP-3009 结算  │
                       └──────────────┘   └──────────────────────────┘
```

- **Worker** = API + 每分钟 cron + Durable Object 神经模拟 + x402 经济结算，全部在一个 Cloudflare Worker 里。
- **Pages** = 纯静态前端，`/api/*` 由前端默认请求同源路径，需在 Pages 配一个代理或让前端直连 API 域名（见 §3.5）。
- **D1** = 长期档案库（每 cron 一行历史），丢失不影响运行，仅影响 `/history` 曲线。
- 全程只需一个 Cloudflare 账户，无服务器、无运维进程。

---

## 2. 阶段零：部署前准备（不动云端，30 分钟）

### 2.1 工具与账号清单

| 项 | 要求 | 核验命令 |
|---|---|---|
| Node.js | ≥ 20 | `node -v` |
| npm | 随 Node | `npm -v` |
| Cloudflare 账户 | 免费版可跑通全流程；建议 Workers 付费版 $5/月（每分钟 cron + DO 分片更从容） | dashboard.cloudflare.com 注册 |
| wrangler CLI | 仓库自带 ^4.133 | `npx wrangler --version` |
| 自有域名（可选但推荐） | 托管到同一 Cloudflare 账户（Add site，NS 生效） | Dashboard → Websites |

```bash
# 拿到代码后第一件事：本地预检（全部通过再上云）
npm install
npm run typecheck        # 三个 workspace 全绿
npm test                 # v1.4 基线：204/204 通过
```

### 2.2 登录 wrangler

```bash
npx wrangler login                 # 交互式，开浏览器授权
# 或 CI/无浏览器环境：
export CLOUDFLARE_API_TOKEN="…"    # Token 模板选 "Edit Cloudflare Workers"，
                                   # 需包含 Workers Scripts:Edit、Workers Routes:Edit、
                                   # D1:Edit、Account Settings:Read
npx wrangler whoami                # 核验：应打印你的账户邮箱/Account ID
```

### 2.3 密钥规划（本表决定你后面所有 `secret put`）

| Secret 名 | 用途 | 何时注入 | 生成方式 |
|---|---|---|---|
| `ADMIN_TOKEN` | 锁 POST /tick、/reset（可选 /stimulus） | **阶段二立刻** | `openssl rand -hex 32` |
| `ECONOMY_MNEMONIC` | 经济层最高权限：HD 派生全部代理钱包 + gas 钱包（accountIndex 2,000,000） | 阶段三（C2 前） | **离线**新建 BIP-39 种子（12/24 词），专用、永不复用、纸质双备份 |
| `ECONOMY_FACILITATOR_PK` | 可选：独立 gas 钱包私钥（不设则从种子派生） | 阶段三可选 | 离线生成 0x 私钥 |
| `ALCHEMY_ARC_RPC_URL` | 私有付费 Arc RPC（结算写入更稳） | 阶段三可选 | alchemy.com 建 Arc app |
| `SOLANA_PRIVATE_KEY` | 执行层 Solana 钱包（**独立种子/私钥**） | 阶段四（C5 前） | 离线生成 base58 密钥对 |
| `SOLANA_RPC_URL` | 执行层 Solana RPC（Helius 付费端点佳） | 阶段四 | helius.dev |
| `JUPITER_API_KEY` | Jupiter 路由（可选但推荐） | 阶段四 | jup.ag |
| `EVM_PRIVATE_KEY` / `BASE_RPC_URL` / `ETH_RPC_URL` / `ZEROX_API_KEY` | 执行层 EVM（Base/ETH）路由 | 阶段四可选 | 同上，独立钱包 |

> **助记词 = 资金最高权限**（审计 F-9）。生成专用种子的正确姿势：断网机器/硬件钱包生成 → 纸质两份分开存放 → 只把助记词本身经 `wrangler secret put` 注入 → 永远不在任何聊天窗口/截图/云笔记里出现明文。
>
> **工具已备好**：`packages/trader-worker/scripts/offline-seed-gen.mjs` —— 联网 `npm install` 后**断网**运行，生成 24 词种子 + 全部派生地址（agent #0~23 + gas 钱包 index 2,000,000）。与生产 `src/keys.ts` 同库（viem/accounts）派生，**地址逐位一致**；`--check seed.txt` 可校验纸面备份（只派生地址，不回显助记词）。

### 2.4 本地影子试跑（强烈建议，上云前最后一道确认）

```bash
cp packages/trader-worker/.dev.vars.example packages/trader-worker/.dev.vars
npm run dev:worker
# 另开终端：
curl http://localhost:8787/health        # {"ok":true,"version":"1.4.0",…}
curl http://localhost:8787/state | head  # economyFacilitator:"simulated"（keyless 安全默认）
```

本地跑通即可 `Ctrl-C`。`.dev.vars` 已被 gitignore，**不要**把它提交，也不要把它带到云上。

---

## 3. 阶段一：零密钥冷启动上云（检查点 C0）

本阶段结束时：Worker 跑在你的 Cloudflare 账户上、每分钟 cron 自主推进、经济层是 keyless 模拟器、D1 开始归档。**全程无任何 secret，天然零资金风险。**

> **一键脚本**：`bash packages/trader-worker/scripts/cloud-deploy-c0.sh`（在你自己的电脑上运行）—— 登录核验 → D1 创建 → database_id 写回 → schema 应用 → deploy → **C0-1/2/3/4 自动验收**（幂等，FAIL 修复重跑即可；自定义域名已绑定时传 URL 参数）。下文为逐步说明。

### 3.1 创建你自己的 D1 数据库（wrangler.toml 标记 ②）

```bash
cd packages/trader-worker
npx wrangler d1 create murmur-db
# 输出示例：
#   database_name = "murmur-db"
#   database_id  = "b1a2c3d4-5678-90ab-cdef-1234567890ab"   ← 复制这一行
```

编辑 `wrangler.toml`，把 id 粘进占位（v1.4 已预置好位置）：

```toml
[[d1_databases]]
binding = "DB"
database_name = "murmur-db"
database_id = "b1a2c3d4-…（你刚拿到的 id）"     # ← 替换 REPLACE_WITH_YOUR_OWN_D1_DATABASE_ID
```

初始化表结构（`FlyStateDO` 首次写入也会懒建表，这步是双保险 + 让 `/history` 立即可用）：

```bash
npx wrangler d1 execute murmur-db --remote --file=./schema.sql
```

### 3.2 首次部署（routes 保持注释 → 落在 *.workers.dev）

v1.4 的 `wrangler.toml` 中自定义域名 `routes` 是**注释状态（标记 ①）**——这是刻意的：首次部署不碰 DNS，一定成功。

```bash
cd packages/trader-worker        # 或仓库根目录：npm run deploy:worker
npx wrangler deploy
# 成功输出：
#   Uploaded murmur (x.xx sec)
#   Deployed murmur triggers (x.xx sec)
#     - crons: ["* * * * *"]
#   https://murmur.<你的子域>.workers.dev
```

> 若 deploy 报 D1 相关错误（`database_id` 无效/不存在），说明 3.1 的 id 没粘对——修正后重跑即可；D1 故障不影响 Worker 本体（归档是 fail-soft 的）。

### 3.3 检查点 C0：冷启动验收（全部通过才进入阶段二）

| # | 命令 | 期望 | 不通过时 |
|---|---|---|---|
| C0-1 | `curl https://murmur.<子域>.workers.dev/health` | `"ok":true` 且 `"version":"1.4.0"` | 404/522 → 等 30s 重试；版本旧 → 确认部署的是 v1.4 代码 |
| C0-2 | `curl -s …/state \| head -40` | `config.economyFacilitator:"simulated"` | 出现 `onchain` → wrangler.toml 被改过，恢复 `ECONOMY_FACILITATOR="simulated"` 再部署 |
| C0-3 | 等 70~90s 后再查 `/state` | `tickIndex` 自主增长（cron 在跑）、`populationSize:24` | 不增长 → Dashboard → Workers → murmur → Triggers 确认 cron 存在；`wrangler tail` 看报错 |
| C0-4 | `curl -s "…/history?limit=3"` | `"enabled":true` 且 `rows` 逐分钟累积 | `enabled:false` → D1 id 未生效，重做 3.1 |
| C0-5 | `npx wrangler tail --format pretty` 观察 2 分钟 | 每分钟一轮 cron 日志；**keyless 降级告警**（`[economy] no ECONOMY_MNEMONIC … simulated`）是**预期行为** | 出现红字异常 → 把日志贴给排查 |

### 3.4 （可选，本阶段）绑定自定义域名

域名 Zone 已在你账户时，取消注释 wrangler.toml 标记 ① 并填自己的域：

```toml
routes = [
  { pattern = "api.your-domain.com", custom_domain = true }
]
```

再 `npx wrangler deploy`——Cloudflare 自动配 DNS + 证书。核验：`curl https://api.your-domain.com/health` 返回 C0-1 同样内容。**F-3 附带验证**：`curl https://api.your-domain.com/signal/requirements` 的 `resource` 字段应等于 `https://api.your-domain.com/signal/pulse`（v1.4 起自动归属你自己的域名，不再硬编码上游）。

### 3.5 部署前端（Pages）

```bash
# 仓库根目录
npm run deploy:frontend
# → wrangler pages deploy public --project-name=murmur --branch=main
# → https://murmur.pages.dev 或项目别名
```

让前端连上你的 API（二选一）：

- **方案 a（零改动）**：访问时带上 API 参数 `https://murmur.pages.dev/?api=https://api.your-domain.com`；
- **方案 b（推荐）**：Pages 项目 → Settings → Functions & Pages 添加 `_redirects` 或用 Pages Function 把 `/api/*` 反代到 API 域；仓库前端默认请求同源 `/api`，配好代理后开箱即用。

---

## 4. 阶段二：管理面加固（检查点 C1）

经济层还没点亮，先把**门锁**装好。此阶段只加一个 secret + 一行 var，不碰任何资金逻辑。

### 4.1 [A1] 注入 ADMIN_TOKEN（F-4 整改，公网部署必做）

```bash
openssl rand -hex 32                     # 生成强随机 token，例如 9f1c…（保存到你的密码管理器）
cd packages/trader-worker
npx wrangler secret put ADMIN_TOKEN
# 粘贴 token，回车。生效约数秒，无需重新 deploy。
```

机制说明：设置后，`POST /tick`、`POST /reset` 必须携 `x-admin-token` 头（或 `?token=`）；**每分钟的内部 cron 会自动携带该 token**（index.ts 的 scheduled 已内置），所以上锁不会冻结 Swarms。

### 4.2 [A2] CORS 白名单（F-6 整改，有独立前端域时必做）

wrangler.toml 取消注释并填你的前端源：

```toml
CORS_ALLOW_ORIGINS = "https://www.your-domain.com,https://your-domain.com"
```

部署后：白名单外的 Origin 将**拿不到** `Access-Control-Allow-Origin` 头（浏览器拦截跨域写操作）；同源/服务端调用不受影响。

### 4.3 [A3] 决策项：POST /stimulus 是否上锁（F-5）

`/stimulus` 是访客"戳一下蜂群"的互动端点，默认仅 IP 冷却（30s 一次）。三个选项：

| 选项 | 配置 | 适合 |
|---|---|---|
| 保持开放（上游行为） | 不设置 | 你想要访客互动的公开展示站 |
| 仅管理员 | `STIMULUS_ADMIN_ONLY = "true"` | 公网自托管推荐；之后戳蜂群需带 ADMIN_TOKEN |
| 暂时下线 | Cloudflare WAF 规则拦截该路径 | 过渡期 |

### 4.4 检查点 C1：门锁验收

| # | 命令 | 期望 |
|---|---|---|
| C1-1 | `curl -s -X POST https://api.your-domain.com/tick` | `{"error":"forbidden"}` + HTTP 403 |
| C1-2 | `curl -s -X POST -H "x-admin-token: <你的token>" …/tick` | `{"ok":true,…}` 200 |
| C1-3 | `curl -s -X OPTIONS -H "Origin: https://evil.example" -H "Access-Control-Request-Method: GET" -D - -o /dev/null …/state` | 响应头**无** `Access-Control-Allow-Origin`（白名单生效） |
| C1-4 | 同上但 `Origin: https://www.your-domain.com` | 有 `Access-Control-Allow-Origin: https://www.your-domain.com` |
| C1-5 | 等 70s 后 `/state` 的 tickIndex | 仍在增长（cron 未被锁死） |

### 4.5 （P1，第一周内）WAF 限速

Dashboard → 你的域 → Security → WAF → Rate limiting rules：对 `/tick`、`/reset`、`/stimulus` 按 IP 限速（如 1 req/10s）；管理路径可再加 Cloudflare Access（邮箱 OTP）。此项不阻塞阶段三，但请在第一周补上（审计 P1 清单）。

**C1 全绿 → 允许进入阶段三。**

---

## 5. 阶段三：经济层逐旗点亮（检查点 C2 → C3）

经济层五旗的点亮顺序是刚性的，**顺序错 = 要么不动钱（安全但白做），要么跳过影子直接真金（禁止）**：

```text
S0 现在：FACILITATOR=simulated + 无助记词                （keyless 模拟器）
        │ 点亮 [F1]+[F2]，保持 [F3] shadow=true、[F4] realSpend=false
        ▼
S1 影子链上：onchain + MNEMONIC 已注入 + SHADOW=true     （真签名 + eth_call 模拟，零广播）
        │ POST /reset 重铸真实 HD 地址 → C2 全绿 + 24~48h 观察
        ▼
S2 实盘小额：SHADOW=false + REAL_SPEND=true + DAILY_CAP=20
        │ C3 全绿，链上可查 txHash → 逐步放宽
        ▼
S3 常态运行：按需调高 DAILY_CAP / 取消 MAX_DEAL 顶
```

### 5.1 [F1]+[F2] 点亮：onchain 模式 + 注入专用助记词（此时仍一分钱不动）

先注入 secret（注意：从 `packages/trader-worker` 目录执行，wrangler 才能读到正确的应用）：

```bash
cd packages/trader-worker
npx wrangler secret put ECONOMY_MNEMONIC
# 粘贴 12/24 个助记词（单词间空格），回车
# 可选：npx wrangler secret put ECONOMY_FACILITATOR_PK   （独立 gas 钱包；不设则 m/44'/60'/0'/0/2000000 派生）
# 可选：npx wrangler secret put ALCHEMY_ARC_RPC_URL      （付费 RPC，写结算更稳）
```

再把 wrangler.toml 两行旗翻过来：

```toml
ECONOMY_FACILITATOR = "onchain"    # [F1] simulated → onchain
ECONOMY_SHADOW = "true"            # [F3] 保持 true（影子：签名+eth_call，零广播）
ECONOMY_REAL_SPEND = "false"       # [F4] 保持 false（v1.4 代码默认，双保险）
ECONOMY_DAILY_CAP = "20"           # [F5] 实盘护栏先写好（USDC/UTC 日）
ECONOMY_PER_AGENT_DAILY_CAP = "2"  # 单代理日上限
```

部署：`npx wrangler deploy`。

**关键一步（否则影子模式跑在假地址上）**——重置 DO，让全部代理钱包按你的新种子重新派生真实地址：

```bash
curl -s -X POST -H "x-admin-token: <token>" https://api.your-domain.com/reset
```

### 5.2 检查点 C2：影子链上验收（真签名、零广播）

| # | 命令 | 期望 | 不通过时 |
|---|---|---|---|
| C2-1 | `curl -s …/state \| grep economyFacilitator` | `"economyFacilitator":"onchain"` | 仍 simulated → MNEMONIC 未生效（`wrangler secret list` 核对）或 wrangler.toml 未部署 |
| C2-2 | `curl -s …/economy \| head -60` | 每个代理钱包是**真实校验和地址**（非 `sim-` 前缀伪址）；日志行含 `shadowOnly=true, realSpend=false` | 地址仍是伪址 → 补 POST /reset |
| C2-3 | `npx wrangler tail --format pretty` 观察 3~5 分钟 | 每轮结算打印 `shadowOnly=true`、`realSpend=false`；**无任何 txHash** | 出现 txHash → 严重：说明 REAL_SPEND 被误开，立即执行 §9 K-1 |
| C2-4 | `curl -s …/economy` 的 settlements | `shadow:true` 标记；总量随 tick 增长但 Arc 浏览器上你的 gas 地址余额不变 | — |
| C2-5 | （若有 Arc 浏览器访问条件）查 gas 钱包地址 | 零外发交易 | — |

**C2 全绿后保持影子运行 24~48 小时**（审计纪律）：期间每天看一眼 C2-3 日志与 `…/history` 曲线。影子期的意义：验证签名域（EIP-712 name/version）、nonce、RPC 连通、净额结算（netting）逻辑——所有会炸的都在这炸，且炸掉不花钱。

### 5.3 资金准备（S2 实盘前）

1. 给 **gas 钱包**（facilitator 地址，见 `/economy` 顶部或 C2-2 日志）转入少量 Arc 原生代币作 gas（按 `ECONOMY_GAS_PRICE_GWEI≈20` 估算，净额结算下消耗极慢）；
2. 给各**代理钱包**转入 USDC（买方以 EIP-3009 授权直付，facilitator **不托管资金**）。上游脚本可批量完成：

```bash
node scripts/fund-agents.mjs     # 从 gas 钱包向 HD 派生的各代理钱包分发 USDC（金额脚本内可调）
```

3. 核验：`curl -s …/economy` 各地址链上余额 > 0。

### 5.4 [F3]+[F4] 点亮：实盘（先小额，再放宽）

wrangler.toml：

```toml
ECONOMY_SHADOW = "false"          # [F3] 关影子：签名后真正广播
ECONOMY_REAL_SPEND = "true"       # [F4] 总开关：允许真结算（最后点亮的旗）
# ECONOMY_MAX_DEAL = "0.05"       # 建议初期取消注释：单笔硬顶 0.05 USDC
# ECONOMY_GAS_PRICE_GWEI = "20"   # 固定 gas 价，避免尖峰
```

`npx wrangler deploy` → 等 2~3 个 cron 周期。

### 5.5 检查点 C3：实盘小额验收

| # | 命令 | 期望 | 不通过时 |
|---|---|---|---|
| C3-1 | `npx wrangler tail` 3~5 分钟 | 结算日志 `shadowOnly=false, realSpend=true`；出现真实 txHash | 连续 revert → 通常是 EIP-712 域参数，调 `ECONOMY_USDC_EIP712_NAME/VERSION`（探针默认 USDC/2） |
| C3-2 | `curl -s …/economy` | settlements 带 txHash 且链接 Arc 浏览器可打开、金额 ≤ MAX_DEAL | 金额超顶 → 检查 ECONOMY_MAX_DEAL 是否部署生效 |
| C3-3 | `curl -s "…/history?limit=60"` | summary.settlements / volumeUsdc 持续累计 | — |
| C3-4 | Arc 浏览器查 gas 钱包 | 有少量外发交易（净额结算，每 cron 至多一笔/对） | gas 消耗异常大 → 调高 `ECONOMY_NET_MIN_BROADCAST` |
| C3-5 | 连续 24h | 无 revert 风暴、DAILY_CAP 未被打满 | 被打满 → 这是护栏在工作；确认额度符合预期后再放宽 |

**C3 全绿 48h 后**，可按需放宽：调高 `ECONOMY_DAILY_CAP`、放开 `ECONOMY_MAX_DEAL`。放快的代价自己扛，放慢的代价只是少赚——**永远选慢**。

---

## 6. 阶段四：外部执行层逐旗点亮（检查点 C4 → C5）

执行层（二次开发新增）把蜂群的意图读出变成 Solana/Base 上的第三方 DEX 交易。它是**四旗联锁**：`EXECUTION_ENABLED` × `EXECUTION_REAL_SPEND` × `!EXECUTION_SHADOW` × `EXECUTION_SIGNING_ENABLED` —— 缺任何一旗，live 路径都会在签名存在之前抛错（P0-5 第 4 军旗设计）。因此点亮只能是下面的顺序，跳步不可能"意外"触达真钱。

### 6.1 [E1] 数据源先行：MEME 监控通道·三链默认清单（零交易风险）

wrangler.toml —— 三链观察清单为 **2026-09-20 实测验证过的默认配置**（深池 + 规范合约 + 有真实成交），照抄即用：

```toml
MEME_ENABLED = "true"
MEME_WEIGHT = "0.35"

# ── Solana（3 币，实测流动性 $0.28M~$5.8M）──────────────────
MEME_SOURCE_SOLANA = "dexscreener"        # 免钥起步；进阶换 "helius"/"bitquery"（key 为 secret）
MEME_WATCHLIST_SOLANA = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263,EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm,7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"
#                                          ↑ BONK / WIF / POPCAT

# ── Base（4 币，实测流动性 $0.85M~$4.27M）───────────────────
MEME_SOURCE_BASE = "dexscreener"
MEME_WATCHLIST_BASE = "0x532f27101965dd16442E59d40670FaF5eBB142E4,0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b,0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed,0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4"
#                                          ↑ BRETT / VIRTUAL / DEGEN / TOSHI

# ── ETH 主网（3 币，实测流动性 $5.4M~$29.7M）────────────────
MEME_SOURCE_ETH = "dexscreener"
MEME_WATCHLIST_ETH = "0x6982508145454Ce325dDbE47a25d4ec3d2311933,0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a,0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C"
#                                          ↑ PEPE / MOG(2023 建池正主) / SPX6900
```

**加币纪律（血泪教训）**：同名假币（impostor）在聚合器上很多——MOG/TURBO 各查到 2~3 个 2026 年新建的同名合约，池子流水看着深、真实成交为零。加任何新币前必须过两道筛查：① **建池年龄**（规范合约的池子应该早于该币的公认发行时间）；② **真实成交量**（1h/5m volume 非零且与流动性量级匹配）。DexScreener 逐项核对后再进清单。

部署后核验：`wrangler tail` 中 meme 采样每轮打印 heat 值；`/execution/logs` 的记录带 `chain` 字段（solana/base/eth），前端 EXECUTION LOG 面板有对应颜色的链徽标（紫/蓝/靛）。**三链信号何时出现由真实行情决定**（平静期可能只有单链有记录，属正常）——先确认"观察样本数 > 0"（说明采样通），再等行情。**先用 dexscreener 跑几天，稳定后再 `wrangler secret put HELIUS_API_KEY`（或 BITQUERY）换付费源。**

### 6.2 [E2] 影子纸面交易：ENABLED=true + SHADOW=true（REAL_SPEND 保持 false）

```toml
EXECUTION_ENABLED = "true"
EXECUTION_SHADOW = "true"                 # 记录纸面成交，永不广播
EXECUTION_REAL_SPEND = "false"
```

部署后开始 **24~48h 影子挂机**（§9 阶段 B 纪律）。

### 6.3 检查点 C4：影子执行验收

| # | 命令 | 期望 |
|---|---|---|
| C4-1 | `curl -s …/execution/logs` | `flags` 块回报 `enabled:true, realSpend:"false", shadow:"true"` |
| C4-2 | 同上 30 分钟后 | `rows` 出现 `status:"shadow"` 的纸面成交（buy 优先；含 confidence/reason/chain 字段）；`chain` 分布覆盖观察清单所配链（行情平静期单链有记录即通过，三链齐活视行情） |
| C4-3 | 前端 EXECUTION LOG 面板 | 与 /execution/logs 同步渲染，旗标芯片为"影子"色 |
| C4-4 | `curl -s …/execution/logs` 观察 24h+ | 止损五规则（EXIT_*）开始产生 sell/sheet 行；PositionBook 台账随 tick 持久恢复 |
| C4-5 | `wrangler tail` | 无红色异常；拒绝类日志（cooldown/预算/置信度）按预期出现 |

影子期复盘清单（每 24h 一次）：成交笔数、平均 confidence、五规则各自触发次数、若按实盘价差估算的纸面盈亏。**数字难看就调参（EXIT_*/MIN_CONFIDENCE/MAX_SLIPPAGE_BPS）再看一轮，不要带着未调参的策略进实盘。**

### 6.4 [E3]+[E4] 实盘：注入执行层钱包 → 签名旗 → 小额真单

**红线**：执行钱包必须是**新钱包**，与经济层种子无关；只转入你输得起的金额（建议 ≤ 50 USDC 等值试盘）。

```bash
cd packages/trader-worker
npx wrangler secret put SOLANA_PRIVATE_KEY    # base58 私钥（独立新钱包）
npx wrangler secret put SOLANA_RPC_URL        # Helius 等付费 RPC
npx wrangler secret put JUPITER_API_KEY       # 可选但推荐
# EVM（Base 先行）：EVM_PRIVATE_KEY / BASE_RPC_URL / ZEROX_API_KEY
```

```toml
EXECUTION_SIGNING_ENABLED = "true"        # [E3] 第 4 军旗：允许签名存在
EXECUTION_REAL_SPEND = "true"             # [E4] 最后点亮
EXECUTION_SHADOW = "false"
MAX_PER_TRADE_USDC = "1"                  # ← 实盘首周锁 1~2 USDC
MAX_DAILY_VOLUME_USDC = "50"
```

`npx wrangler deploy` → 等 cron 触发首笔。

### 6.5 检查点 C5：实盘小额验收

| # | 命令 | 期望 | 不通过时 |
|---|---|---|---|
| C5-1 | `curl -s …/execution/logs` | flags 显示 `realSpend:"true", shadow:"false"`；首笔 `status:"executed"` 行带 txHash | 无成交 → 影子期是否有 intent？检查 MIN_CONFIDENCE/冷却 |
| C5-2 | Solana 浏览器查执行钱包 | swap 交易存在、金额 ≤ 1 USDC、滑点 ≤ MAX_SLIPPAGE_BPS | 金额异常 → 立即 K-2，查 adapter sizing 日志 |
| C5-3 | 24h 观察 | MAX_DAILY_VOLUME_USDC 未打满；EXIT_* 止损在真实 mark 上工作 | 打满 → 护栏生效，复核策略后再说 |
| C5-4 | 一周后 | 纸面期 vs 实盘期成交率/滑点差异可解释 | 滑点显著劣化 → 降 MAX_PER_TRADE_USDC 或提高 MIN_LIQUIDITY_USD |

---

## 7. 阶段五：可选链上模块（检查点 C6，经济层实盘干净后才碰）

> 四个模块全部依赖经济层 onchain 且 `realSpend && !shadow`（state.ts 门控），所以它们**天然被阶段三挡住**。在 C3 达成前，以下任何配置都是惰性的。

| 模块 | 点亮条件 | 命令/配置 | 检查点 C6 |
|---|---|---|---|
| [O1] 预测市场 PREDICT | C3 全绿 | wrangler.toml `PREDICT_ENABLED="true"`（v1.4 出厂 false，须显式打开） | `/predictions` 出现当轮 book；两 cron 后自动 parimutuel 结算；`/predictions/verify?round=N` 回算 receipt hash 一致 |
| [O2] 人机对抗 ARENA | 自有合约已部署 | `contracts/README.md` 流程部署 PredictionArena.sol（**resolver = 你的 facilitator 地址**）→ `ARENA_ADDRESS`/`ARENA_TOKEN` 填自己合约 → `ARENA_ENABLED="true"` | `/arena` 出现回合；小额 MURMUR 下注 → 回合结算到账；resolver 非你的 facilitator 时 resolve 会失败（这是设计） |
| [O3] 神经回执 Registry | 自有合约已部署 | 部署 NeuralReceiptRegistry.sol（committer = 你的 facilitator）→ 取消注释 `ECONOMY_REGISTRY_ADDRESS` | 结算日志出现 commit；`/predictions/verify` 能读到链上 commitment |
| [O4] Circle 代付 facilitator | 可选 | `ECONOMY_CIRCLE_FACILITATOR="external"`；持续用量再 `wrangler secret put CIRCLE_API_KEY` | seller 侧结算经 Circle 成功；免费试用限额打满会 403 `registration_required`（换 key 或回 `"off"`） |

> **审计 F-2 红线重申**：绝不把上游的 registry/arena 合约地址抄进来用——你的 Worker 对那些合约没有 resolver 权限，调用必然失败且暴露意图。合约一定要用自己的钱包部署、自己的 facilitator 做 resolver/committer。

---

## 8. 逐旗总表（一页速查）

| 旗 | 层 | 类型 | 出厂值 | 影子值 | 实盘值 | 点亮阶段 | 通过检查点 | 回滚（翻回出厂） |
|---|---|---|---|---|---|---|---|---|
| `ADMIN_TOKEN` | 管理 | secret | 未设 | — | 强随机注入 | 二（C1） | C1-1/2 | `wrangler secret delete ADMIN_TOKEN` |
| `CORS_ALLOW_ORIGINS` | 管理 | var | 注释 | — | 自己的前端域 | 二（C1） | C1-3/4 | 注释回去 + deploy |
| `STIMULUS_ADMIN_ONLY` | 管理 | var | 注释(=false) | — | 建议 "true" | 二（决策） | C1 后手测 /stimulus | 注释回去 |
| `ECONOMY_FACILITATOR` | 经济 | var | `simulated` | `onchain` | `onchain` | 三（C2） | C2-1 | `"simulated"` + deploy |
| `ECONOMY_MNEMONIC` | 经济 | secret | 未设 | 注入专用种子 | 同左 | 三（C2） | C2-2 | `wrangler secret delete ECONOMY_MNEMONIC`（核弹级：必定 keyless） |
| `ECONOMY_SHADOW` | 经济 | var | `true` | `true` | `false` | 三（C3） | C3-1 | `"true"` + deploy |
| `ECONOMY_REAL_SPEND` | 经济 | var | `false` | `false` | `true` | 三（C3·最后） | C3-2 | `"false"` + deploy（K-1） |
| `ECONOMY_DAILY_CAP` | 经济·护栏 | var | `20` | — | 按风险预算 | 三（C3 前） | C3-5 | 调小即刻生效（下次 deploy） |
| `MEME_ENABLED` | 执行 | var | `false` | `true` | `true` | 四（E1） | tail heat 日志 | `"false"` |
| `MEME_SOURCE_*`+`WATCHLIST_*` | 执行 | var | 注释 | 三链默认清单（§6.1） | 同影子 | 四（E1） | /execution/logs 带 chain 字段 | 注释回去 |
| `EXECUTION_ENABLED` | 执行 | var | `false` | `true` | `true` | 四（E2/C4） | C4-1 | `"false"`（K-2 前置） |
| `EXECUTION_SHADOW` | 执行 | var | `true` | `true` | `false` | 四（C5） | C5-1 | `"true"` |
| `EXECUTION_SIGNING_ENABLED` | 执行 | var | `false` | `false` | `true` | 四（E3） | C5-1 | `"false"`（签名前抛错=彻底断路） |
| `EXECUTION_REAL_SPEND` | 执行 | var | `false` | `false` | `true` | 四（E4·最后） | C5-2 | `"false"`（K-2） |
| `MAX_PER_TRADE_USDC` | 执行·护栏 | var | `5` | — | 实盘首周 `1` | 四（C5 前） | C5-2 | 调小 |
| `PREDICT_ENABLED` | 可选 | var | `false` | 惰性 | 按需 `true` | 五（C6） | /predictions | `"false"` |
| `ARENA_ENABLED`(+地址) | 可选 | var | `false` | 惰性 | 自有合约后 | 五（C6） | /arena 回合 | `"false"` |
| `ECONOMY_REGISTRY_ADDRESS` | 可选 | var | 注释 | 惰性 | 自有合约 | 五（C6） | commit 日志 | 注释回去 |
| `ECONOMY_CIRCLE_FACILITATOR` | 可选 | var | `off` | 惰性 | `external` | 五（C6） | seller 结算 | `"off"` |

> 记忆口诀：**管理面 → 经济层（影子→实盘）→ 执行层（影子→实盘）→ 玩具层**。每层"最后点亮的旗"永远是 REAL_SPEND。

---

## 9. 紧急制动 runbook（kill switch，按速度排序）

**任何异常**（异常 revert 风暴 / 金额超顶 / 钱包余额流失 / 被陌生流量打）——按下面顺序执行，前面的更快：

| # | 场景 | 动作 | 生效时间 |
|---|---|---|---|
| K-1 | 经济层真钱停 | `ECONOMY_REAL_SPEND="false"` → `npx wrangler deploy` | ~10s（下次结算即被挡） |
| K-2 | 执行层真钱停 | `EXECUTION_REAL_SPEND="false"`（或干脆 `EXECUTION_ENABLED="false"`）→ deploy | ~10s |
| K-3 | 全部回模拟 | `ECONOMY_FACILITATOR="simulated"` → deploy | ~10s，且不依赖 secret |
| K-4 | 核弹（确定没有钥匙能动钱） | `npx wrangler secret delete ECONOMY_MNEMONIC`（及两个私钥 secret） | 数秒，必定 keyless |
| K-5 | 版本级回滚 | Dashboard → Workers → murmur → Deployments → Rollback 到上一个版本 | ~10s |
| K-6 | 挡流量不删代码 | 域名 WAF：`http.request.uri.path in {"/tick" "/reset" "/stimulus"}` → Block；或临时把 routes 注释掉 | ~1min |

**注意**：K-1/K-2 是"翻旗 + 重新部署"，需本地有代码与 wrangler 登录态——**请确保至少两台设备能执行 deploy**（或提前配好 CI），否则紧急时你只能用 K-5/K-6（纯 Dashboard 操作）。

---

## 10. 部署后运维

- **日志**：`npx wrangler tail --format pretty`（实时）；Dashboard → Workers → murmur → Logs（历史，observability 已开 `head_sampling_rate=1` 全采样）。
- **拨测**：用 UptimeRobot/健康页等对 `GET /health` 做 1~5 分钟拨测（free 层够用）；连续失败 → 看 K-5。
- **D1 备份**：`npx wrangler d1 export murmur-db --remote --output=backup-$(date +%F).sql`（建议每周 cron 到本地/CI）。
- **升级流程**：`git pull`（或拉新版 zip）→ `diff` 自己的 wrangler.toml 与新版默认（保住你自己的 D1 id/routes/旗）→ `npm run typecheck && npm test` → `npx wrangler deploy` → 30s 后 C0-1/C0-3 复验。
- **密钥轮换（经济层）**：新种子离线生成 → fund 新 gas/代理钱包 → `wrangler secret put ECONOMY_MNEMONIC`（新种子）→ **旧钱包余额先人工扫空** → `POST /reset`（重派生+清模拟态）→ C2 复验 → 旧种子纸质备份销毁。
- **成本速估**：Workers Paid $5/月起步（每分钟 cron + DO + 12 分片的量级正好在付费层舒适区）；D1 免费额度内；Arc gas 由净额结算摊薄（NET_MIN_BROADCAST 越高越省）。
- **周检清单（审计 P1）**：DAILY_CAP 消耗曲线、`/history` 行数增速、WAF 拦截数、`npm audit`、secret 是否有明文泄漏（GitHub/聊天记录）。

---

## 11. 附录

### 11.1 检查点速查卡（复制即用）

```bash
BASE=https://api.your-domain.com        # 换成你的 API 域
TOKEN=<你的 ADMIN_TOKEN>

# C0 冷启动
curl -s $BASE/health | grep version                     # "1.4.0"
curl -s $BASE/state | grep -o '"economyFacilitator":"[a-z]*"'
curl -s "$BASE/history?limit=3" | head -c 200

# C1 门锁
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/tick              # 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "x-admin-token: $TOKEN" $BASE/tick   # 200

# C2 经济影子
curl -s $BASE/economy | head -c 400            # 真实地址 + shadow:true
npx wrangler tail --format pretty              # shadowOnly=true, realSpend=false，无 txHash

# C3 经济实盘
curl -s $BASE/economy | grep -o 'txHash' | head # 真实 txHash 出现
curl -s "$BASE/history?limit=60" | grep -o '"settlements":[0-9]*'

# C4/C5 执行影子 → 实盘
curl -s $BASE/execution/logs | head -c 400     # flags 回报 + shadow 行 → executed 行 + txHash
curl -s $BASE/execution/logs | grep -o '"chain":"[a-z]*"' | sort | uniq -c   # 三链信号分布（solana/base/eth）

# F-3 归属
curl -s $BASE/signal/requirements | grep -o '"resource":"[^"]*"'   # = $BASE/signal/pulse
```

### 11.2 常见故障

| 症状 | 原因 | 处置 |
|---|---|---|
| `*.workers.dev` 打开但自定义域 522/1000 | DNS 未生效 / Zone 不在同一账户 | 等 5 分钟；核对 Zone；或先用 workers.dev 完成阶段三 |
| deploy 报 D1 `database_id` 不存在 | ② 没粘对 / 用了上游 id | 重做 §3.1 |
| 设了 ADMIN_TOKEN 后 swarm 冻结 | 正常情况不会（cron 自带 token）；若冻结 | 核对 secret 名拼写恰为 `ADMIN_TOKEN`；C0-3 复验 |
| C3 结算连续 revert | EIP-712 域参数 / gas 不足 / USDC 余额不足 | 调 `ECONOMY_USDC_EIP712_NAME/VERSION`；fund-agents 补钱 |
| Circle 403 `registration_required` | 免费试用按 payTo 限额 | `CIRCLE_API_KEY` 注入或回 `"off"` |
| 执行层无成交 | 无 intent（置信度/冷却/预算）或 watchlist 太小 | 先看 C4 影子是否正常，再放宽参数 |
| `/state` 可见 `rpcUrl` | 设计如此：只暴露公共 RPC | 付费端点只放 `ALCHEMY_ARC_RPC_URL` secret，绝不写进 `RPC_URL`（审计 F-8） |

### 11.3 与安全审计 F-1~F-12 的处置映射

| 审计项 | 处置 | 在本手册的位置 |
|---|---|---|
| F-1 上游真钱配置残留 | v1.4 wrangler.toml 出厂即安全基线；REAL_SPEND 代码默认 false | §0 / §5（出厂即 S0 态） |
| F-2 上游基础设施绑定 | routes/D1/合约全部占位 ①②③ | §3.1 / §3.4 / §7 |
| F-3 resource 硬编码 | SIGNAL_RESOURCE + 请求 origin 动态推导 | §3.4 验证 |
| F-4 变更端点无鉴权 | ADMIN_TOKEN | §4.1 |
| F-5 /stimulus 决策 | STIMULUS_ADMIN_ONLY / WAF | §4.3 / §4.5 |
| F-6 CORS 反射 | CORS_ALLOW_ORIGINS 白名单 | §4.2 |
| F-7 无限速 | WAF Rate limiting | §4.5 |
| F-8 rpcUrl 暴露边界 | 公共/付费 RPC 分离纪律 | §11.2 末行 |
| F-9 密钥治理 | 专用种子 + 离线备份 + 轮换流程 | §2.3 / §10 |
| F-10 ADMIN_WALLET 语义 | 身份声明，不参与鉴权；真权限根 = CF 账户 + ADMIN_TOKEN + MNEMONIC | §0 / §2.3 |
| F-11 前端与供应链 | npm audit + lockfile + CSP（P1 周检） | §10 |
| F-12 上游生产领先快照 | 跟踪上游、选择性移植（P2） | 审计报告 §6 P2 |
