# murmur v1.5 开旗放行顺序与云端部署 Runbook

> 适用版本：v1.5.0（P0 冻结治理 + 指数退避 + 公告条/CA 芯片；P1 五层 Bourse/Faith/Laureate/反馈总线/快时钟全旗默认关；前端 v70：Reddit seat / netting 芯片 / 两段式编年史 / 透明度页）
> 铁律：只同步"机制思想+样式"，代码 100% 自写；六合约全部本部署；上游地址（0x8faa…代币 / 0x3d90…金库 / 0xaf1a…竞技场）一个都不碰；一切收款 = ADMIN `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`。

---

## 一、为什么必须"逐旗放行"而不是一次全开

wrangler.toml 文件面永远是安全基线（REAL_SPEND=false / simulated / 六旗全关）。生产旗位全部走 `deploy --var` 链叠加在文件面之上。这保证了：

1. **裸 deploy 自动回退无钥模拟态**——任何人误跑 `wrangler deploy` 不会点亮真钱路径；
2. 每面旗都可以**单独熄灭**（`--var KEY:false` 重部署），秒级回滚、互不牵连；
3. 每开一面旗都对应一组**可 curl 的冒烟断言**，绿了才开下一面。

⚠ 代价与纪律：每次部署必须**逐字复刻完整 var 链**（§2.1 的 7 个 --var）。漏掉 `ECONOMY_REAL_SPEND:true` 等任何一个，生产立即掉回基线（经济回模拟态、竞技场写路径熄火）——这就是为什么必须用脚本部署，不要手敲。

---

## 二、第 0 步：部署 v1.5 改进界面（今日必做）

### 2.1 单命令部署（用户自己机器执行，令牌永不进聊天）

```bash
# 先到 Cloudflare 控制台创建【新的】可编辑权限令牌
#   权限：Account → Workers Scripts:Edit + D1:Edit
#   （旧令牌曾在聊天中暴露，无论是否还有效都不再使用）
export CLOUDFLARE_API_TOKEN="<新令牌>"
export CLOUDFLARE_ACCOUNT_ID="6facaca88940309cadc971558fe0a166"

bash packages/trader-worker/scripts/deploy-v15-flyx402.sh
```

脚本自动完成：凭据预检 → dry-run 校验 → 携 R4-4 完整 var 链部署 → 10 项冒烟断言（/health v1.5.0、/state onchain、首页 v70/netting-chip/Reddit、/proofs、/bourse 关旗 501、三域名 200）→ 失败时打印回滚命令。

### 2.2 部署后立刻能看到的改进（无需开任何 P1 旗）

| 改进 | 位置 | 生效条件 |
|---|---|---|
| 公告条（羊皮纸细条，× 可关记忆） | 首页顶部 | announcements.json 静态驱动，即时 |
| token CA 一键复制芯片 `0x43D8…B490` | 首页 | 即时 |
| **Reddit seat `r/flyx402`**（替代 X 链接） | 右上角 | announcements.json `socials.reddit`，即时 |
| **netting 信任芯片**「N 笔交易 → 1 笔结算 ↗」 | 右上角 | 第一笔真实并账结算上链后自动点亮（诚实默认隐藏） |
| 两段式编年史（卷轴索引 → 全高卷页） | CHRONICLE | 即时 |
| 透明度页（六合约地址 + ADMIN + 验证链接） | /transparency.html | 即时 |
| P0 可靠性：DO 冻结治理 / 指数退避 / /history 直读 D1 / 前端 12s 轮询 | 后端 | 部署即生效 |

---

## 三、第 1 步：W1 注资（开 Bourse 前、也是真实结算的前置）

### 3.1 生成注资清单（零密钥输出）

```bash
cd packages/trader-worker
node scripts/funding-addresses.mjs        # 表格 + 缺口；--json 机器可读
```

脚本只打印公开地址与链上余额（助记词不落日志不进网络），并自动与 flyx402.xyz/economy 的云端真实地址 24/24 交叉核验。

### 3.2 本次实测清单（2026-09-24，转账前请重跑脚本取实时余额）

| 角色 | 地址 | 现余额 | 目标 | 说明 |
|---|---|---|---|---|
| facilitator（gas 钱包，专用 PK） | `0x20c54D8Fa205af293181833b46494d97d54753f3` | 3.2102 | 5.0 | 全部 RESOLVER/COMMITTER + 结算 gas payer；按 0.6 USDC/天燃烧 ≈ 8 天缓冲 |
| agent #0 | `0xea2c1589E949317342B6DD1d8d9e4869c605a6FA` | 0 | 1.2 | 24 个 HD 代理（与云端 /economy 逐一核验一致） |
| agent #1 | `0x1236F5A2DaF37EddF9F57652951487Ce5C002901` | 0 | 1.2 | |
| agent #2 | `0x7B214b5c425C745C1e843D0DBa5Da1aBB9814dcc` | 0 | 1.2 | |
| agent #3 | `0x761A9BBF371C27Ee1706bD35aF94eAf3FF0b7acd` | 0 | 1.2 | |
| agent #4 | `0xCcC2162659e1b341432a4393B95C3Db3E1FDA58A` | 0 | 1.2 | |
| agent #5 | `0xcE0dAb87ad480ebff5FbB3B4959De99DAa7475A8` | 0 | 1.2 | |
| agent #6 | `0x5580a308DC209Df993EABBaa06702A0F0f901732` | 0 | 1.2 | |
| agent #7 | `0x260FE26BC030d79386AE3bf4B8ebb8618656973A` | 0 | 1.2 | |
| agent #8 | `0x8975221A76E94DfBdCC150d7C8B1e7e8948a0a14` | 0 | 1.2 | |
| agent #9 | `0x4a5b33F7bB55681F25FEAB84Ecd8fFF02E4eB924` | 0 | 1.2 | |
| agent #10 | `0x2c6c448589d777b4401D7D24061e1a4C63d59799` | 0 | 1.2 | |
| agent #11 | `0x3DFC10321991D7806e1aca1Fc62D0DbBd125181c` | 0 | 1.2 | |
| agent #12 | `0x797572062b65C8528E06950CF8B5a4e9eDf6dB3B` | 0 | 1.2 | |
| agent #13 | `0xC7F6026d372e4E73B7B2AA4F3b0DA4fE08082EEc` | 0 | 1.2 | |
| agent #14 | `0xaF4fc22FC64Dc58107e42814ea656D7b3977EcEc` | 0 | 1.2 | |
| agent #15 | `0x842DDb23ac5903e3407462E42F0e3e0B869f1d08` | 0 | 1.2 | |
| agent #16 | `0x77Dd33cac7F3B4fF2f7FC3FcbbAd3B9A146fC659` | 0 | 1.2 | |
| agent #17 | `0x84E61f89887B149a2Adc129ff8920C6b0E073641` | 0 | 1.2 | |
| agent #18 | `0xB97b009C3dFE088ee3bFbA048F65bCc4a37e7596` | 0 | 1.2 | |
| agent #19 | `0x77eaFe7BCbd02B356e7c4E60E89CCD54103c0Ffb` | 0 | 1.2 | |
| agent #20 | `0x2e4A4945bac982eBA377EC4E15343FD3094C8b2A` | 0 | 1.2 | |
| agent #21 | `0x5dbF74222B1484A1D896E719fFCE4EbcA54C1047` | 0 | 1.2 | |
| agent #22 | `0xDB9a3CfB81387bC92ec14ed886f8b05Ab9B1ecfA` | 0 | 1.2 | |
| agent #23 | `0xDB6f25A2E156c4c835451b3D5072CB41F2FdEd1A` | 0 | 1.2 | |
| ADMIN（身份/收款，无需 gas） | `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1` | 2.1388 | — | 终极管理钱包；只在透明度页展示 |

- **合计缺口 ≈ 30.6 USDC**（≈ 预算 ~29；如需压缩：24 agent 各 1.1 = 26.4 + facilitator 1.8 = 28.2）
- 必须是**原生 USDC**（Arc gas precompile），不是 ERC-20 MURMUR
- 转完 1–2 分钟后重跑脚本，"缺口"列应归零

### 3.3 注资生效验证（等着看飞轮转起来）

```bash
watch -n 60 'curl -s https://flyx402.xyz/economy | python3 -m json.tool | grep -E "settleOk|settleFail|volumeUsdc"'
```

注资后首个 cron 起：settleOk 开始增长、settleFail 停止增长（P0 指数退避把失败对的广播预算让给健康对）；**netting 芯片点亮**；经济面板 "USDC SETTLED" 从 0.000 起跳。

---

## 四、第 2 步：P1 五旗放行顺序（一次一旗，绿了再开下一面）

> 每一面的部署命令都必须**完整携带 §2.1 的 7 个生产 var**。下面命令里用 `$BASE` 代指它们。

```bash
# 一次性定义完整生产 var 链（照抄，勿改勿漏）
BASE=(--var ECONOMY_FACILITATOR:onchain --var ECONOMY_REAL_SPEND:true --var ECONOMY_SHADOW:false \
      --var WAR_ENABLED:true --var EVOLUTION_ENABLED:true \
      --var EVOLUTION_TREASURY:0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1 --var COMMUNITY_ENABLED:true)
```

### 旗 1 —— BOURSE + POET（零资金纯读出，一起开，最安全最先）

```bash
npx wrangler deploy "${BASE[@]}" --var BOURSE_ENABLED:true --var POET_ENABLED:true
```

**冒烟（等 2–3 个 cron ≈ 3 分钟）：**
```bash
curl -s https://flyx402.xyz/health | grep -o '"bourse-optional"\|"laureate-optional"'   # 两面旗出现在特性面
curl -s https://flyx402.xyz/bourse | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['enabled'],d.get('fever'))"   # true + 冷启动 0.5 定标
curl -s https://flyx402.xyz/poem | head -c 300    # 桂冠诗人第一首（≤30 分钟内成诗）
```
- 机理：Bourse 只读 `eth_getLogs` 监听本部署 MURMUR Transfer（零 gas 无托管）；空投期国库转出被排除（叙事零污染）。注资后代理间真实结算一发生，FEVER/WHALE/SILENCE 叙事即有真材。
- POET 每 30 cron（≈30 分钟）成诗一首，D1 持久化，crowned poem 截图即 X/Reddit 传播素材。
- **回滚**：`npx wrangler deploy "${BASE[@]}"`（两个 --var 去掉即熄）。

### 旗 2 —— TOKEN_STIMULUS（行情 → 群体感受腿）

```bash
npx wrangler deploy "${BASE[@]}" --var BOURSE_ENABLED:true --var POET_ENABLED:true \
  --var TOKEN_STIMULUS_ENABLED:true
```
**冒烟**：编年史出现 COIN_FEVER/COIN_SILENCE 类叙事条目；`/annals` 有新 kind。cap 0.35 硬封顶，不会压过温度主通道。
**回滚**：去掉该 --var 重部署。

### 旗 3 —— SOCIAL_STIMULUS（时代 → 群体反馈总线）

```bash
npx wrangler deploy "${BASE[@]}" --var BOURSE_ENABLED:true --var POET_ENABLED:true \
  --var TOKEN_STIMULUS_ENABLED:true --var SOCIAL_STIMULUS_ENABLED:true
```
**冒烟**：era 推进（ERAS/时代 HUD 变化）后群体 arousal 出现有界摆动；编年史出现 SECT/PROPHET 预备剧情。cap 0.3。
**回滚**：去掉该 --var。

### 旗 4 —— RELIGION（信仰卷：先知/教派/圣日/分裂）

```bash
npx wrangler deploy "${BASE[@]}" --var BOURSE_ENABLED:true --var POET_ENABLED:true \
  --var TOKEN_STIMULUS_ENABLED:true --var SOCIAL_STIMULUS_ENABLED:true --var RELIGION_ENABLED:true
```
**冒烟**：编年史新增 FAITH 卷 tab（两段式 codex 卷轴索引里点亮）；SECT_FOUNDED/HOLY_DAY 类条目开始出现。
**回滚**：去掉该 --var（卷自动隐藏，数据保留在 D1）。

### 旗 5 —— AGES_FAST_CLOCK（社会记忆快时钟，最后开）

```bash
npx wrangler deploy "${BASE[@]}" --var BOURSE_ENABLED:true --var POET_ENABLED:true \
  --var TOKEN_STIMULUS_ENABLED:true --var SOCIAL_STIMULUS_ENABLED:true \
  --var RELIGION_ENABLED:true --var AGES_FAST_CLOCK:true
```
**冒烟**：bond/grudge 半衰期 ~5× 缩短（编年史恩怨翻篇明显加快）；无资金路径。
**回滚**：去掉该 --var。

### 放行顺序原理（为何这样排）

1. BOURSE/POET：**纯读出、零资金、零状态风险**，且立即给编年史喂真内容（行情→叙事→社交素材飞轮的起点）；
2. TOKEN_STIMULUS → SOCIAL_STIMULUS：都是"有界刺激注入"（四通道 + cap 封顶），先行情后时代，刺激面逐步放大；
3. RELIGION：消费前两者的状态生成剧情，放最后才能在第一卷就有完整素材；
4. AGES_FAST_CLOCK：改社会记忆节奏，影响所有叙事的翻篇速度，等前四面稳定一个观察日再开。

### 暂缓区（明确不在本轮）

| 项 | 暂缓原因 | 重启条件 |
|---|---|---|
| 发明卷 / 城市卷 | genome 42→49 种 → **manifestHash 轮转** → 触碰 NeuralManifestRegistry 链上承诺 | manifest v2 单独决策 |
| 学徒 / 档案馆 / 工坊卷 | 内容工程量大，非运营瓶颈 | Bourse/faith 飞轮跑顺后 |
| world-atlas 底图 + 领地征服层 | 最大工程 | 上四项消费验证后 |
| 存活退休 + 繁殖上限 | 联动注资成本结构 | 单独经济决策 |
| 分片扩容（12 → 24） | 先观察 P0 批量持久化后的 CPU 面貌 | DO CPU 告警再动 |

---

## 五、回滚矩阵（秒级）

| 想回滚什么 | 命令 |
|---|---|
| 单面 P1 旗 | `npx wrangler deploy "${BASE[@]}"`（去掉该 --var） |
| 全部 P1 旗（回 v1.5 基线） | `npx wrangler deploy "${BASE[@]}"` |
| 经济全局熄火（真钱零风险） | `npx wrangler deploy "${BASE[@]}" --var ECONOMY_REAL_SPEND:false --var ECONOMY_SHADOW:true` |
| 域名路由 | 注释 wrangler.toml routes 块重部署（workers.dev 兜底常在） |

## 六、红线自查（每次部署后 30 秒过一遍）

```bash
curl -s https://flyx402.xyz/state | grep -o '"adminWallet":"[^"]*"'
# 必须是 0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1
rg -n "0x8faa|0x3d90|0xaf1a" packages/trader-worker/src packages/frontend/public   # 必须零命中
```

## 七、运营衔接（Bourse 开旗后自动生效）

- **每日温度快讯 / 每周战报**：从编年史取材（`/annals` 卷条目 + `/bourse` 行情读出 + `/poem` 本周桂冠诗），运营成本趋零；
- **netting 首屏信任要素**：芯片显示"N 笔交易 → 1 笔结算"，点击直达 Arc explorer 逐笔核验——"真实上链"最直观的证明；
- **Laureate 传播钩子**：每期 crowned poem 截图发 r/flyx402（Reddit seat 已上首页）；
- **公告纪律**：announcements.json 每周 ≤1–2 条；大事件（空投日 / DEX 上线日）用全屏开场卡，不占常驻条。
