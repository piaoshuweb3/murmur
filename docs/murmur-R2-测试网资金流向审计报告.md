# murmur R2 测试网彩排 · 资金流向审计报告

> 专项：《murmur 合约部署彩排手册》阶段 **R2（Arc 测试网实链演练）** 执行结果。
> 红线唯一且不可协商：**100% 自主知识产权与协议** —— 所有合约自部署、所有收款地址=用户钱包（ADMIN）、零上游地址、零第三方托管。
> **结论速览：71/71 断言全部通过 · 19 笔链上转账逐笔入账 · 第四方收付款地址 0 个 · WarCoffer 托管零流出 · ADMIN 全程零流出（测试网上根本没有 ADMIN 钥）· 判定 R2 通过，R3（主网）就绪待用户持钥。**

| 项目 | 值 |
|---|---|
| 执行日期 | 2026-09-22（UTC 17:58 → 18:03，墙钟 ≈5.5 分钟，真实时间轴含 90s stale 演练段） |
| 执行环境 | **Arc 测试网实链** `rpc.testnet.arc.io`（chainId 5042002），块 63459412 → 63460064，gasPrice 25 gwei |
| 原生 gas | **USDC（18 decimals）**——Arc 特性，gas 预算即 USDC 预算 |
| 资产模式 | MockUSDC（EIP-3009 全兼容彩排资产，绝不上主网）+ 原生 USDC precompile 写路径实测 |
| 编译/驱动 | npm solc 0.8.37（optimizer 200 runs，六合约+MockUSDC 零错误）· viem 2.56.5（与仓库 deploy 脚本同源） |
| 真钱暴露 | **零**（全部彩排钥/助记词派生；faucet 领取的测试网 gas 无真实价值） |
| 运行日志 | `packages/trader-worker/scripts/r2-run-log.json`（断言/流水/角色全量原始证据）· `scripts/r2-run-final.log` |
| 复跑命令 | `RPC_URL=https://rpc.testnet.arc.io CHAIN_ID=5042002 node packages/trader-worker/scripts/r2-rehearsal.mjs`（需 `.env.local` 彩排钥 + faucet gas） |
| gas 实耗 | 全绿单次 ≈2.7 USDC（预算 2.73 精确命中）；本会话 4 次运行（2 次预检试跑+1 次修复跑+1 次全绿跑）合计 ≈10.25 USDC |

---

## 1. 参与者身份（全部归 ADMIN 体系，钥匙分离，与 R1 同源）

| 角色 | 地址 | 私钥来源 | 说明 |
|---|---|---|---|
| DEPLOYER | `0x168145bedF51773b639E83c6c8321eB91d969f22` | 彩排钥（`r2-keygen.mjs` 生成，gitignored） | 只付 gas，不持任何协议角色；faucet 单点入气 |
| **RESOLVER**（facilitator） | `0x1e8200e31078005bBcb74a9fE955187A35c34e87` | 彩排助记词 BIP-44 accountIndex 2,000,000（与 `src/keys.ts` `FACILITATOR_ACCOUNT_INDEX` 同源） | WarCoffer/Arena/收据链/血统唯一操作者；Worker 上线后将持同一身份 |
| **TREASURY = ADMIN** | `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1` | **无钥**（全程不需要也不持有） | MurmurToken 生产实例全额铸币接收方、繁殖费收款方 |
| BETTOR_A | `0xBB8Ba80852efAd555AC6B324A57255Db94247A74` | 彩排钥 | 竞技场下注者 / 繁殖费付款人 / G0 breeder（版税收款人）/ 流通副本发钞人 |
| BETTOR_B | `0xD0d1E7416e88d42300E8277bc3107cFD73E3cFaf` | 彩排钥 | 竞技场下注者 / 版税付款人 |
| OUTSIDER（路人） | `0x3b82dB79a903da2D30CA9c5dd1Adf1b84B898186` | 彩排钥 | 负向测试（越权 revert + stale 任何人可解锁） |

**ADMIN 无钥主权的最强实证**：本轮在真实测试网上部署了生产 MurmurToken（treasury=ADMIN）并铸币 10 亿，而该钥从未出现在任何机器上——测试网根本不存在 ADMIN 私钥，链上却没有任何路径能把这笔钱挪走（ACT 2 负向断言 + ACT 7 全链账本"ADMIN 零流出"双证明）。

## 2. 部署清单与生产参数校验（依赖顺序，全部回读断言，explorer 可查）

| # | 合约 | 测试网地址（本轮全绿实例） | gas | 关键 immutable 回读 |
|---|---|---|---|---|
| 0 | MockUSDC（彩排资产） | [`0xc818439a168ac2e8591caf79077bc7f8c16bb8b3`](https://explorer.testnet.arc.io/address/0xc818439a168ac2e8591caf79077bc7f8c16bb8b3) | 704,456 | EIP-3009 域齐备 |
| ① | MurmurToken（生产·treasury=ADMIN） | [`0x6cd746c1be260056761d811dec3914cefd9460dd`](https://explorer.testnet.arc.io/address/0x6cd746c1be260056761d811dec3914cefd9460dd) | 399,683 | totalSupply=10亿；全额铸 ADMIN |
| ①' | MurmurToken（流通副本·仅测试网） | [`0x4d6b4298d28c237df1ef543d572350be02a3e747`](https://explorer.testnet.arc.io/address/0x4d6b4298d28c237df1ef543d572350be02a3e747) | 399,683 | treasury=BETTOR_A（驱动竞技场） |
| ② | NeuralReceiptRegistry | [`0x23ec3868929e972e4440dd04039bbee709efae4d`](https://explorer.testnet.arc.io/address/0x23ec3868929e972e4440dd04039bbee709efae4d) | 336,909 | committer=RESOLVER |
| ③ | NeuralManifestRegistry | [`0xaa512cef0493d150c910bc0d2e4ad8b16e3cb392`](https://explorer.testnet.arc.io/address/0xaa512cef0493d150c910bc0d2e4ad8b16e3cb392) | 276,457 | committer=RESOLVER |
| ④ | ConnectomeLineage | [`0x674a2752fcca6b6781f338bb9b09daea413c41c7`](https://explorer.testnet.arc.io/address/0x674a2752fcca6b6781f338bb9b09daea413c41c7) | 555,787 | committer=RESOLVER |
| ⑤ | WarCoffer（生产参数） | [`0x64b03c71ee8732dd4392c5a5fbd007d5f9eaf2b2`](https://explorer.testnet.arc.io/address/0x64b03c71ee8732dd4392c5a5fbd007d5f9eaf2b2) | 1,014,680 | maxEscrow=**50 USDC immutable 硬顶** · staleGrace=3天 |
| ⑤' | WarCoffer-stale（90s 演练实例） | [`0x0ae99f09d2645ccd2fe34e2a29d1ce64af915e6c`](https://explorer.testnet.arc.io/address/0x0ae99f09d2645ccd2fe34e2a29d1ce64af915e6c) | 1,014,656 | staleGrace=90s |
| ⑥ | PredictionArena（生产参数） | [`0xe3b7d9c31f89a9593a8eecac4661eb25c235d13d`](https://explorer.testnet.arc.io/address/0xe3b7d9c31f89a9593a8eecac4661eb25c235d13d) | 1,248,534 | token=①' · staleGrace=3天 |
| ⑥' | PredictionArena-stale（90s 演练） | [`0xba4adacc3c72069f4a35ebaaeb2fe30ecb8ae21f`](https://explorer.testnet.arc.io/address/0xba4adacc3c72069f4a35ebaaeb2fe30ecb8ae21f) | 1,248,510 | staleGrace=90s |

部署合计 gas ≈ 7.20M；构造参数逐一回读断言（R3 主网同款自验逻辑已内置于脚本）。

## 3. 资金路径逐笔流水（19 笔，全链 getLogs 回放重构）

### 3.1 MurmurToken —— 铸币 + 发钞（3 笔）

| 流向 | 数额 | 断言 |
|---|---|---|
| 零地址 → **ADMIN**（生产实例） | 1,000,000,000 MURMUR | 一次性构造铸币；ABI 扫描 0 特权函数（mint/pause/owner/upgrade 全无） |
| 零地址 → BETTOR_A（流通副本） | 1,000,000,000 MURMUR | 仅测试网彩排流通层 |
| BETTOR_A → BETTOR_B（流通副本） | 20,000 MURMUR | 真实签名发钞 |

负向证明：路人动 ADMIN 余额 → revert（allowance）。**生产实例 MURMUR 全程零流出**。

### 3.2 x402 EIP-3009 结算 —— 繁殖费 / 版税（2 笔，协议自主原语）

| 流向 | 数额 | 断言 |
|---|---|---|
| BETTOR_A → **TREASURY=ADMIN** | 1.000000 USDC | **繁殖费确切落 EVOLUTION_TREASURY（=ADMIN）**；`AuthorizationUsed` 落链（topic0 复核 count=2） |
| BETTOR_B → BETTOR_A（=breederOf(G0)） | 0.500000 USDC | 版税收款人**从链上血统读出**后同原语结算；A 净值 −1.0+0.5 精确一致 |

买家只出 EIP-712 签名、从不交钥；facilitator（RESOLVER）代提交；nonce 防重放、时窗生效。**arc-circle-x402 自持协议生产结算原语在真实测试网端到端落在用户钱包。**

### 3.3 WarCoffer —— 战争托管 + 税收（4 笔入、全程零流出）

| 步骤 | 资金动作 | 断言 |
|---|---|---|
| deposit ×2（生产实例） | RESOLVER → WarCoffer 各 25.000000 USDC | 实币 50 == totalEscrow == **immutable 硬顶 50**；超顶 deposit → `EscrowCap` revert |
| declareWar #1 | 双方各 5 USDC 入 pot（合约内转移） | pot=10；powerA=700/powerB=300 **declare 时上链固化**（resolve 时 resolver 无法干预） |
| resolveWar #1（真实 deadline 后） | 胜者金库 +10 | **确定性胜者本地重算==合约裁定**（roll=186 < 700 → ATTACKER）；A=30/B=20 净赢一个 stake |
| levyTax 1 USDC → commonsPurse → sweepTo(HOUSE_A) | 税收归集 | purse 归零；**税留在自主金库体系内，不触任何外部地址** |
| expireStaleWar（stale 实例，OUTSIDER 触发，90s 真实 grace） | 双方各拿回本方 1 USDC | 回到战前水位；**resolver 死亡也不会锁死托管，且任何人都能解锁** |

守恒矩阵（5 个检查点全过）：`Σ(金库) + Σ(在战 pot) + commonsPurse == totalEscrow == WarCoffer 实币`（生产 50.000000 / stale 2.000000）。
**WarCoffer（生产+stale）USDC 流出笔数 = 0** —— 存入后没有任何 USDC 离开战库体系。

### 3.4 PredictionArena —— 竞技场（平价零和，零抽水）

| 轮次 | 下注 | 结果 | 派出 | 断言 |
|---|---|---|---|---|
| Round#1（生产实例） | A 12,000 UP / B 8,000 DOWN | exit Δ=+0.05 > band 0.008 → **UP** | A 拿 20,000（本金+全额败池） | **Σpayout(20,000) == Σstake(20,000)**；结清后托管=Round#2 在注 1,000（派彩零泄漏的强断言）；resolver/ADMIN 分毫未动 |
| Round#2 | A 1,000 UP | Δ=+0.002 ≤ band → **FLAT** | A 全额退款 1,000 | 退款路径精确 |
| Round#1（stale 实例） | A 500 UP | resolver 未 resolve → OUTSIDER `expireStale`（90s 真实等待） | A 全额退款 500 | **stale-grace 任何人可解锁，用户资金不可被死 resolver 锁定** |

负向：同轮反押 `SideTaken`、零注 `ZeroAmount`、注期内 resolve `BettingClosed` 全部按预期 revert。
竞技场最终托管（生产+stale）= **0**；流通总量守恒 A+B=10亿；**竞技场全部 3 笔付款对象 100% 为下注者本人**。

### 3.5 原生 USDC precompile 写路径（R3 决策输入，独立于 19 笔表）

`0x3600…0000`（Arc 原生 USDC，FiatTokenV2）：真实 `transfer` 成功 + **EIP-3009 `transferWithAuthorization` 结算 0.3 USDC → ADMIN 成功**（writable=true, eip3009=true）。
→ **R3 可直接把 WarCoffer/繁殖费指向原生 USDC，无需部署任何资产合约**，少一个部署件、少一份审计面。

### 3.6 全链账本总表（19 笔，角色白名单 100%）

USDC(mock)：3 笔彩排注资（零地址铸币，非协议路径）+ 2 笔 x402 结算 + 4 笔战库存款；
MURMUR：2 笔铸币 + 1 笔发钞 + 4 笔下注 + 3 笔派出/退款。
**每一笔 from/to 都落在白名单角色集合 {零地址(铸币), RESOLVER, TREASURY=ADMIN, BETTOR_A/B, WarCoffer(×2), PredictionArena(×2)} 内 —— 第四方收付款地址：0 个（violations=0）。**
全合约字节码 PUSH20 走查：4 个候选全部 ∈ 白名单或为无链上代码的随机数据 —— **零上游地址嵌入**。

## 4. R1 → R2 剧本迁移中暴露并修复的 3 处真实差异（这正是彩排的价值）

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 1 | `dw is not defined`（ACT 0 崩溃） | R2 改写时 gas 分发循环在 `walletFor(DEPLOYER)` 声明前使用 | 声明上移至 gas 种子段前 |
| 2 | stale `declareWar` → `BadDeadline()` | **anvil 可时间跳跃 vs 真实链秒级出块**：`ts0+12s` 截止期扛不住开局 ~12 笔 tx 的出块+RPC 往返 | deadline 阶梯拉宽至 45/70/90/95/110s（真实时间轴安全余量；结算段自然等待，只多花墙钟时间） |
| 3 | `balanceOf` 打到竞技场合约自身 revert | R1→R2 转写笔误：`bal(a.address, a.address)` 应为 `bal(murmurCirc, arena)` | 修正 token 指向（流通副本合约） |
| 附 | "Round#1 结清后托管归零" 断言失败 | R2 把 Round#2 押注排在 Round#1 结清**前**（R1 在后），断言未跟时序 | 改为更强断言：结清后托管==Round#2 在注 1,000（证明派彩零泄漏） |

三处全部是**剧本层**问题；合约行为与 R1 结论逐字节一致——6 个合约无需任何改动。

## 5. R3 主网就绪清单（唯一剩余阶段：全部人工步骤在用户侧）

| # | 事项 | 状态 |
|---|---|---|
| 1 | DEPLOYER 主网钥 | ⬜ **用户本人**离线生成（离线种子操作卡），绝不发给任何人/任何机器 |
| 2 | gas 充值 | ⬜ Arc 主网 gas=原生 USDC；主网部署 6 合约 ≈0.09-0.5 USDC 等值（R1/R2 实测 gas 推算），DEPLOYER 充 ~5 USDC 余量充足 |
| 3 | USDC 模式决策 | ✅ 依据本轮：**推荐原生 USDC precompile**（写路径+EIP-3009 实测通过，免部署资产合约）；默认 MockUSDC 仅测试网 |
| 4 | 部署门控 | ✅ 已内置：`*_CONFIRM` 环境变量 + 构造参数回读断言 + ADMIN 地址即指尖定（`SIGNAL_PAYTO` 同源） |
| 5 | 部署后接线 | ⬜ 主网地址回填 wrangler.toml（本轮测试网地址仅作注释证据，不接线）+ 逐旗开启 WAR/EVOLUTION/COMMUNITY/ARENA |

**R2 判定：通过。** 三级彩排流水线（R1 本地 fork ✅ → R2 测试网实链 ✅ → R3 主网 ⬜ 待用户）前两级全绿收官；合约层经两轮两种环境 138 项断言零合约缺陷、零资金越轨、零主权让渡。
