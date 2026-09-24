# murmur 使用说明书 · USER GUIDE（多语种 / Multilingual）

> 版本 v1.3 · 适用部署：murmur 二次开发版（Helius 数据源 · 动态 decimals · Solana 签名 · 影子执行 · 多语种界面）
> 本文档与站内 "guide 📚 / 使用说明 📚" 帮助抽屉内容一致，并提供更完整的配置与常见问题说明。
> Languages: [简体中文](#一简体中文) · [English](#2-english) · [日本語](#3-日本語) · [한국어](#4-한국어) · [Español](#5-espaol) · [Français](#6-franais)

---

# 一、简体中文

## 1.1 murmur 是什么

murmur 是一群由果蝇神经系统构成的活体种群，漂浮在 Arc 市场之上。页面持续读取全链活跃度，将其归结为一个"市场温度"（冷 / 平稳 / 热），蝇群的画面冷暖与行为随之变化。每只果蝇同时是一个自治经济主体（agent）：由 10,800 个神经元组成的连接组决定它买什么、向谁买，主体之间通过 x402 协议用 USDC 互相结算，每笔真实结算都是可在 Arc 浏览器上核验的链上交易。没有大模型——只有神经元在真实付款。

本次二次开发在原版之上新增：
- **meme 通道（P0-1）**：接入 dexscreener / Helius 真实数据源，产出真实 meme 信号；
- **动态 decimals（P0-3）**：Helius getTokenSupply 主源 + 回退链，实盘卖出前的硬门槛；
- **Solana 签名激活（P0-5）**：Keypair 加载 + VersionedTransaction 签名 + REAL_SPEND 门控；
- **卖出/止损规则（P2-1）**：止损 −20% / 止盈 +50% / 移动止盈 15% / 最长持仓 360 分钟 / RUG 熔断；
- **多语种界面（v1.3）**：简体中文 / English / 日本語 / 한국어 / Español / Français；
- **终极管理权限钱包（v1.3）**：`0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`。

## 1.2 界面导览（四个面板 + 抽屉）

| 区域 | 名称 | 内容 |
|------|------|------|
| 左上 | 主体经济 | x402 结算总账、最近成交滚动条、代币 CA 行、**管理权限钱包行（admin）** |
| 左下 | 市场温度 | 冷/平稳/热温度计、历史曲线、活力/区块/每块交易/节拍；从这里打开：种群历史、**执行日志**、arc 脉冲、预测市场、竞技场 |
| 右上 | 种群 | 24 只果蝇在躁动/探索/聚集/休眠四种行为间的实时分布 |
| 右下 | 关于 | 项目简介 + **语言切换**（EN/中/日/한/ES/FR） |
| 顶部 | 使用说明 📚 | 打开多语种帮助抽屉（即本文档精简版） |

点击任意抽屉按钮（右上侧滑出）：全部主体钱包、神经凭证、种群历史、arc 脉冲 · x402、预测市场、竞技场、执行日志、使用说明。

## 1.3 如何互动

1. **点触任意果蝇**：展开它的神经绽放（bloom）、实时脉冲栅格、五项驱动条（觉醒度/转向/凝聚力/振翅/静息）与专属 x402 钱包（余额/已付/已收/成交）。
2. **拖拽画面**：搅动蝇群（有冷却时间，默认 30 秒一次）。
3. **点击任意链上哈希**：跳转 Arc 官方浏览器（explorer.arc.io）核验该笔交易。
4. **切换语言**：右下"关于"面板的 EN/中/日/한/ES/FR 按钮；选择保存在浏览器本地（localStorage），刷新后仍生效。
5. **执行日志**：左下"执行日志 →"打开审计面板，查看每一笔交易意图、风控裁决与影子成交；可按 全部/已执行/影子/已拒绝/失败 过滤。

## 1.4 执行日志与影子模式（重要）

当前部署按《二次开发说明》§9 阶段 B 运行：

- `EXECUTION_REAL_SPEND=false` —— 总闸关闭，**永不真实花费**；
- `EXECUTION_SHADOW=true` —— 影子模式，只记录纸面成交，不广播任何链上交易；
- `EXECUTION_SIGNING_ENABLED=false` —— 不注入签名私钥（keyless 本地模式）。

执行日志中每条记录 = 一次完整的交易意图链：meme 信号 → 风控限额裁决 → 影子成交（或拒绝）。四个旗标实时显示开关状态：`meme 开`、`执行 开`、`真实花费 关`、`影子 开`。影子模式下任何记录都不可能成为真实交易。

风控限额（.dev.vars）：每日上限 50 USDC、单笔上限 5 USDC、单币持仓 ≤10%、最低流动性 $10,000、最大持仓集中度 0.35、冷却 300 秒、滑点上限 300 bps。

卖出/止损规则（P2-1）：止损 −20%、止盈 +50%、移动止盈 15%、最长持仓 360 分钟、RUG 流动性熔断 $5,000、每节拍最多卖出 3 笔。

## 1.5 终极管理权限钱包

本部署声明的**终极管理权限钱包（ultimate admin）**为：

```
0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1
```

- 展示位置：左上"主体经济"面板的 **admin** 行（点击复制，↗ 跳转 Arc 浏览器核验）；
- 数据来源：`wrangler.toml` / `.dev.vars` 中的 `ADMIN_WALLET`，经 `/state` 接口（`config.adminWallet`）输出到前端；
- **性质说明**：这是所有权/管辖声明地址，仅作身份展示与核验，**不持有私钥、不参与签名**；结算 gas 钱包仍由部署密钥（ECONOMY_MNEMONIC）HD 派生；
- **如何移交管理权**：修改 `wrangler.toml` 的 `ADMIN_WALLET = "0x新地址"`，重新部署即可；前端与 /state 会自动同步新地址。若地址格式非法（非 0x+40 位十六进制），Worker 会忽略并打印警告。

## 1.6 多语种说明

- 支持语言：简体中文（默认）、English、日本語、한국어、Español、Français；
- 覆盖范围：全部面板标题、按钮、温度刻度、执行日志（旗标/过滤器/统计）、钱包名册、帮助中心、状态栏等 60+ 处 UI 文案；关于面板的完整项目介绍亦同步翻译；
- 切换方式：右下"关于"面板按钮；或修改浏览器 localStorage 的 `murmur-lang` 值（zh/en/ja/ko/es/fr）；
- 缺失回退：任一文案缺失时自动回退英文。

## 1.7 本地运行与配置速查

```bash
# 1) 启动 Worker（:8787）
cd packages/trader-worker && npx wrangler dev --port 8787 --ip 127.0.0.1

# 2) 启动前端（:3000，同源代理 /api → :8787）
node /home/z/my-project/scripts/demo-server.js

# 3) 影子挂机 tick（60 秒一次手动触发 cron）
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

常用配置（wrangler.toml / .dev.vars）：

| 变量 | 说明 |
|------|------|
| `ADMIN_WALLET` | 终极管理权限钱包地址（身份声明） |
| `EXECUTION_REAL_SPEND` | 总闸：false 永不真实花费 |
| `EXECUTION_SHADOW` | true = 影子模式 |
| `MEME_SOURCE_SOLANA` | dexscreener（免钥）/ helius |
| `MEME_WATCHLIST_SOLANA` | meme 观察清单（逗号分隔 mint） |
| `EXIT_*` | 止损/止盈/移动止盈/最长持仓/RUG 熔断 |

## 1.8 常见问题

- **页面打不开 / 显示 offline？** 确认 Worker（:8787）与前端（:3000）均已启动；前端通过同源 `/api` 代理访问 Worker。
- **执行日志一直是"暂无记录"？** meme 信号需要观察清单中的代币出现活跃波动；tick 每 60 秒触发一次，耐心等待即可，也可调低 `TRADE_COOLDOWN_SECONDS` 增加触发频率。
- **会有真实资金损失吗？** 不会。当前 `EXECUTION_REAL_SPEND=false` + `EXECUTION_SHADOW=true`，全部为纸面成交；转实盘必须按 §9 流程先完成 24–48h 影子期。
- **如何更换管理权限钱包？** 见 §1.5。

---

# 2. English

## 2.1 What is murmur

murmur is a living population of fruit-fly nervous systems adrift on the arc market. The page reads whole-chain activity, reduces it to a single "market temperature" (cold / calm / hot), and the swarm cools or warms with it. Every fly is also an autonomous economic agent: a 10,800-neuron connectome decides what to buy and from whom, and agents settle with each other in USDC over the x402 protocol — every real settlement is an on-chain transaction verifiable on the Arc explorer. No LLM — just neurons paying each other for real.

This secondary development adds on top of the original:
- **Meme channel (P0-1)**: dexscreener / Helius real data sources producing real meme signals;
- **Dynamic decimals (P0-3)**: Helius getTokenSupply primary source + fallback chain, a hard gate before live sells;
- **Solana signing activation (P0-5)**: Keypair loading + VersionedTransaction signing, gated by REAL_SPEND;
- **Sell / stop-loss rules (P2-1)**: −20% stop-loss, +50% take-profit, 15% trailing stop, 360-min max hold, rug circuit breaker;
- **Multilingual UI (v1.3)**: 简体中文 / English / 日本語 / 한국어 / Español / Français;
- **Ultimate-admin wallet (v1.3)**: `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`.

## 2.2 Interface map

| Area | Panel | Content |
|------|-------|---------|
| top-left | agent economy | x402 settlement ledger, streaming deals, token CA row, **admin wallet row** |
| bottom-left | market temperature | cold/calm/hot meter, history, vitality/block/tx-per-block/tick; opens swarm history, **execution log**, arc pulse, prediction market, arena |
| top-right | population | live split of the 24 flies across agitate / explore / aggregate / rest |
| bottom-right | about | project note + **language switch** (EN/中/日/한/ES/FR) |
| top bar | guide 📚 | opens the multilingual usage-guide drawer |

Side drawers (slide from the right): all agent wallets, neural proofs, swarm history, arc pulse · x402, prediction market, arena, execution log, usage guide.

## 2.3 How to interact

1. **Touch any fly** — its neural bloom, live spike raster, five drive bars (arousal / turn bias / cohesion / wingbeat / rest) and personal x402 wallet slide in.
2. **Drag the field** — stir the swarm (cooldown applies, default 30s).
3. **Click any on-chain hash** — verifies that exact settlement on explorer.arc.io.
4. **Switch language** — the EN/中/日/한/ES/FR buttons in the about panel; the choice persists in localStorage.
5. **Execution log** — open "execution log →" to audit every trade intent, risk-rail verdict and shadow fill; filter by all / executed / shadow / rejected / failed.

## 2.4 Execution log & shadow mode (important)

This deployment runs §9 phase B:

- `EXECUTION_REAL_SPEND=false` — the master kill switch; real spending is impossible;
- `EXECUTION_SHADOW=true` — shadow mode records paper fills only, broadcasts nothing;
- `EXECUTION_SIGNING_ENABLED=false` — no signing keys injected (keyless local mode).

Each log row is one complete intent chain: meme signal → risk-rail verdict → shadow fill (or rejection). Four flags show the live switch state: `meme on`, `exec on`, `real spend off`, `shadow on`. In shadow mode nothing here can ever become a real transaction.

Risk rails (.dev.vars): 50 USDC daily cap, 5 USDC per-trade cap, ≤10% position per token, $10,000 liquidity floor, 0.35 max holder concentration, 300s cooldown, 300 bps slippage cap.

Sell rules (P2-1): −20% stop-loss, +50% take-profit, 15% trailing stop, 360-min max hold, $5,000 rug-liquidity breaker, ≤3 sells per tick.

## 2.5 Ultimate-admin wallet

The declared **ultimate-admin wallet** of this deployment is:

```
0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1
```

- Displayed as the **admin** row in the agent-economy panel (click to copy, ↗ to verify on the Arc explorer);
- Source: `ADMIN_WALLET` in wrangler.toml / .dev.vars, exposed via `/state` (`config.adminWallet`);
- **Nature**: an ownership/authority declaration for identity and verification only — it **holds no keys and never signs**; the settlement gas wallet remains HD-derived from ECONOMY_MNEMONIC;
- **To transfer authority**: set `ADMIN_WALLET = "0xnewAddress"` in wrangler.toml and redeploy; the frontend and /state sync automatically. Invalid addresses (not 0x + 40 hex) are ignored with a console warning.

## 2.6 Languages

- Supported: 简体中文 (default), English, 日本語, 한국어, Español, Français;
- Coverage: 60+ UI strings — panel titles, buttons, meter scale, execution-log flags/filters/stats, wallet roster, help center, status bar; the about note is fully translated too;
- Switching: the about-panel buttons, or `localStorage["murmur-lang"]` = zh/en/ja/ko/es/fr;
- Fallback: any missing string falls back to English.

## 2.7 Local run & config quick reference

```bash
# 1) Worker on :8787
cd packages/trader-worker && npx wrangler dev --port 8787 --ip 127.0.0.1

# 2) Frontend on :3000 (same-origin /api → :8787)
node /home/z/my-project/scripts/demo-server.js

# 3) Shadow tick (manual cron every 60s)
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

| Variable | Purpose |
|------|---------|
| `ADMIN_WALLET` | ultimate-admin wallet address (identity declaration) |
| `EXECUTION_REAL_SPEND` | kill switch: false never spends |
| `EXECUTION_SHADOW` | true = shadow mode |
| `MEME_SOURCE_SOLANA` | dexscreener (keyless) / helius |
| `MEME_WATCHLIST_SOLANA` | meme watchlist (comma-separated mints) |
| `EXIT_*` | stop-loss / take-profit / trailing / max-hold / rug breaker |

## 2.8 FAQ

- **Page won't load / shows offline?** Make sure the Worker (:8787) and frontend (:3000) are both up; the frontend reaches the Worker through the same-origin `/api` proxy.
- **Execution log says "no records yet"?** Meme signals need volatility in the watched tokens; ticks fire every 60s — or lower `TRADE_COOLDOWN_SECONDS` to trigger more often.
- **Can I lose real funds?** No. `EXECUTION_REAL_SPEND=false` + `EXECUTION_SHADOW=true` means everything is paper; going live requires the full §9 24–48h shadow period first.
- **How to change the admin wallet?** See §2.5.

---

# 3. 日本語

## 3.1 murmur とは

murmur は、arc の市場の上を漂うショウジョウバエの神経系でできた生きた個体群です。ページはチェーン全体の活動を読み取り、ひとつの「市場温度」（寒/穏/熱）に集約し、群はそれに合わせて変化します。一匹ずつが同時に自律的な経済主体でもあり、10,800 個のニューロンからなるコネクトームが何を・誰から買うかを決め、x402 プロトコルで USDC を互いに決済します。LLM はありません。

二次開発の追加要素：meme チャネル（P0-1）、動的 decimals（P0-3）、Solana 署名（P0-5）、売り/ストップロス規則（P2-1：−20%/+50%/15%トレーリング/最長 360 分）、多言語 UI（6 言語）、最高管理ウォレット `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`。

## 3.2 画面と操作

- **左上**：エージェント経済（x402 台帳・トークン CA・**管理者ウォレット行**）。
- **左下**：市場温度。ここから実行ログ・群れの歴史・arc パルス・予測市場・アリーナ。
- **右上**：個体群の行動分布。**右下**：概要 + 言語切替（EN/中/日/한/ES/FR）。**上部**：「ガイド 📚」でヘルプ。
- ハエをタップ → 神経ブルーム・スパイクラスター・ドライブ・専用ウォレット。ドラッグ → 群れを掻き回す。ハッシュをクリック → Arc エクスプローラーで検証。

## 3.3 シャドウモードと管理ウォレット

このデプロイは §9 フェーズ B：`EXECUTION_REAL_SPEND=false`（実支出不可）+ `SHADOW=true`（紙上約定のみ）+ キーレス。実行ログの 1 行 = 取引意図（meme シグナル → リスクレール → シャドウ約定/拒否）。

最高管理ウォレットは宣言済みの `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`。読み取り専用の「管理者」行に表示され、鍵は保持せず署名にも使いません。移管は wrangler.toml の `ADMIN_WALLET` を変更して再デプロイします。

---

# 4. 한국어

## 4.1 murmur란?

murmur는 arc 시장 위를 떠다니는 초파리 신경계 개체군입니다. 전체 체인 활동을 하나의 '시장 온도'(차/평/열)로 환산하고 군집이 그에 반응합니다. 각 초파리는 10,800개 뉴런 연결체로 무엇을·누구에게서 살지 결정하는 자율 경제 주체이며, x402로 USDC를 서로 정산합니다. LLM은 없습니다.

2차 개발 추가 요소: 밈 채널(P0-1), 동적 decimals(P0-3), 솔라나 서명(P0-5), 매도/손절 규칙(P2-1: −20%/+50%/15% 트레일링/최대 360분), 다국어 UI(6개 언어), 최고 관리 지갑 `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`.

## 4.2 화면과 조작

- **좌상단**: 에이전트 경제(x402 원장·토큰 CA·**관리자 지갑 행**).
- **좌하단**: 시장 온도 — 실행 로그·군집 히스토리·arc 펄스·예측 시장·아레나 진입점.
- **우상단**: 개체군 분포. **우하단**: 소개 + 언어 전환(EN/中/日/한/ES/FR). **상단**: "가이드 📚" 헬프.
- 초파리 터치 → 신경 블룸·스파이크 래스터·드라이브·전용 지갑. 드래그 → 군집 젓기. 해시 클릭 → Arc 익스플로러 검증.

## 4.3 섀도 모드와 관리 지갑

이 배포는 §9 단계 B: `EXECUTION_REAL_SPEND=false`(실지출 불가) + `SHADOW=true`(종이 체결만) + 키리스. 실행 로그 한 줄 = 거래 의도(밈 신호 → 리스크 레일 → 섀도 체결/거부).

최고 관리 지갑은 선언된 `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`. 읽기 전용 "관리자" 행에 표시되며 키를 보유하지 않고 서명에도 사용되지 않습니다. 이전은 wrangler.toml의 `ADMIN_WALLET` 변경 후 재배포.

---

# 5. Español

## 5.1 Qué es murmur

murmur es una población viva de sistemas nerviosos de mosca de la fruta a la deriva sobre el mercado de arc. La página lee la actividad de toda la cadena, la reduce a una "temperatura de mercado" (frío/calma/calor) y el enjambre reacciona. Cada mosca es también un agente económico autónomo: un conectoma de 10.800 neuronas decide qué comprar y a quién, y los agentes se liquidan en USDC mediante x402. Sin LLM.

La elaboración secundaria añade: canal meme (P0-1), decimals dinámicos (P0-3), firma Solana (P0-5), reglas de venta/stop (P2-1: −20%/+50%/15% trailing/360 min máx.), UI multilingüe (6 idiomas) y la cartera de administración suprema `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`.

## 5.2 Interfaz y uso

- **Arriba-izquierda**: economía de agentes (libro mayor x402 · CA del token · **fila admin**).
- **Abajo-izquierda**: temperatura del mercado; abre el registro de ejecución, historia del enjambre, pulso arc, mercado de predicción y arena.
- **Arriba-derecha**: población. **Abajo-derecha**: acerca de + idiomas (EN/中/日/한/ES/FR). **Barra superior**: "guía 📚".
- Toca una mosca → bloom neural, raster de picos, drives y cartera. Arrastra → agita el enjambre. Clic en un hash → verifica en el explorador de Arc.

## 5.3 Modo sombra y cartera admin

Este despliegue corre la fase B de §9: `EXECUTION_REAL_SPEND=false` (nunca gasta) + `SHADOW=true` (solo papel) + sin claves. Cada fila del registro = una intención (señal meme → rieles de riesgo → cobertura sombra o rechazo).

La cartera de administración suprema declarada es `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`, mostrada en la fila **admin** solo-lectura; no guarda claves ni firma. Para transferirla, cambia `ADMIN_WALLET` en wrangler.toml y redespliega.

---

# 6. Français

## 6.1 Qu'est-ce que murmur

murmur est une population vivante de systèmes nerveux de drosophiles à la dérive sur le marché arc. La page lit l'activité de toute la chaîne, la réduit en une « température de marché » (froid/calme/chaud) et l'essaim réagit. Chaque mouche est aussi un agent économique autonome : un connectome de 10 800 neurones décide quoi acheter et à qui, et les agents se règlent en USDC via x402. Pas de LLM.

Le développement secondaire ajoute : canal mème (P0-1), decimals dynamiques (P0-3), signature Solana (P0-5), règles de vente/stop (P2-1 : −20 %/+50 %/15 % trailing/360 min max), UI multilingue (6 langues) et le portefeuille d'administration suprême `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`.

## 6.2 Interface et usage

- **En haut à gauche** : économie d'agents (registre x402 · CA du token · **ligne admin**).
- **En bas à gauche** : température du marché ; ouvre le journal d'exécution, l'histoire de l'essaim, la pulsation arc, le marché de prédiction et l'arène.
- **En haut à droite** : population. **En bas à droite** : à propos + langues (EN/中/日/한/ES/FR). **Barre supérieure** : « guide 📚 ».
- Touchez une mouche → bloom neuronal, raster de spikes, drives et portefeuille. Glissez → agitez l'essaim. Clic sur un hash → vérification sur l'explorateur Arc.

## 6.3 Mode ombre et portefeuille admin

Ce déploiement tourne en phase B de §9 : `EXECUTION_REAL_SPEND=false` (ne peut jamais dépenser) + `SHADOW=true` (papier uniquement) + sans clé. Chaque ligne du journal = une intention (signal mème → rails de risque → exécution ombre ou rejet).

Le portefeuille d'administration suprême déclaré est `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1`, affiché en lecture seule sur la ligne **admin** ; il ne détient aucune clé et ne signe jamais. Pour le transférer, changez `ADMIN_WALLET` dans wrangler.toml puis redéployez.
