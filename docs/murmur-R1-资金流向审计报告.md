# murmur R1 本地 fork 彩排 · 资金流向审计报告

> 专项：《murmur 合约部署彩排手册》阶段 **R1（本地 fork 演练）** 执行结果。
> 红线唯一且不可协商：**100% 自主知识产权与协议** —— 所有合约自部署、所有收款地址=用户钱包（ADMIN）、零上游地址、零第三方托管。
> **结论速览：67/67 断言全部通过 · 17 笔链上转账逐笔入账 · 第四方收付款地址 0 个 · WarCoffer 托管零流出 · 判定 R1 通过，放行 R2（测试网）。**

| 项目 | 值 |
|---|---|
| 执行日期 | 2026-09-22 |
| 执行环境 | anvil 1.8.3 `--fork-url https://rpc.mainnet.arc.io`（Arc 主网 5042，fork 块 22190776 → 22190826，本地 chainId 31337） |
| 编译器 | npm solc 0.8.37（optimizer 200 runs，六合约 + MockUSDC 全部零错误） |
| 驱动 | viem 2.56.5（复用仓库 deploy 脚本同源调用方式） |
| 真钱暴露 | **零**（所有私钥为彩排钥/助记词派生；TREASURY=ADMIN 仅以地址出现，全程无签名需求） |
| 运行日志 | `packages/trader-worker/scripts/r1-run-log.json`（断言/流水/角色全量原始证据） |
| 复跑命令 | `anvil --fork-url https://rpc.mainnet.arc.io --port 8545 --chain-id 31337` + `node packages/trader-worker/scripts/r1-rehearsal.mjs` |

---

## 1. 参与者身份（全部归 ADMIN 体系，钥匙分离）

| 角色 | 地址 | 私钥来源 | 说明 |
|---|---|---|---|
| DEPLOYER | `0xf39F…2266`（anvil #0） | 彩排测试钥 | 只付 gas，不持任何协议角色 |
| **RESOLVER**（facilitator） | `0x069990134faaae9670406AE9C9d3407C34e6704b` | 彩排助记词 BIP-44 **accountIndex 2,000,000**（与 `src/keys.ts` `FACILITATOR_ACCOUNT_INDEX` 同源派生路径） | WarCoffer/Arena/收据链/血统的唯一操作者；与 Worker 上线后将持同一身份 |
| **TREASURY = ADMIN** | `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1` | **无钥**（本彩排从头到尾不需要也不持有该钥） | MurmurToken 全额铸币接收方、繁殖费收款方 |
| BETTOR_A | `0x7099…79C8` | 彩排测试钥 | 竞技场下注者 / 繁殖费付款人 / G0 breeder（版税收款人） |
| BETTOR_B | `0x9965…A4dc` | 彩排测试钥 | 竞技场下注者 / 版税付款人 |
| OUTSIDER（路人） | `0x90F7…B906` | 彩排测试钥 | 专用于负向测试（越权必须 revert + stale 解锁"任何人可触发"） |

---

## 2. 部署清单与生产参数校验（依赖顺序，全部回读断言）

| # | 合约 | 地址（本次 fork 实例） | gas | 关键 immutable 回读 |
|---|---|---|---|---|
| 0 | MockUSDC（彩排资产，见 §6-F1） | `0xb6aa91e8904d691a10372706e57ae1b390d26353` | 704,456 | name/symbol/decimals + EIP-3009 域（见 §3.2） |
| ① | MurmurToken | `0x499aa73a1d27e54b33e7db05ffd22854ec70257e` | 399,683 | totalSupply=1,000,000,000；treasury=ADMIN 收全额 |
| ② | NeuralReceiptRegistry | `0x4c04377f90eb1e42d845ab21de874803b8773669` | 336,933 | committer=RESOLVER |
| ③ | NeuralManifestRegistry | `0xf93b0549cd50c849d792f0eae94a598fa77c7718` | 276,481 | committer=RESOLVER |
| ④ | ConnectomeLineage | `0x8cea85ec7f3d314c4d144e34f2206c8ac0bbada1` | 555,811 | committer=RESOLVER |
| ⑤ | WarCoffer | `0x29023de63d7075b4cc2ce30b55f050f9c67548d4` | 1,014,704 | usdc=资产 / resolver=RESOLVER / **maxEscrow=50 USDC（immutable 硬顶）** / staleGrace=3 天 |
| ⑥ | PredictionArena | `0xca87833e830652c2ab07e1e03eba4f2c246d3b58` | 1,248,558 | token=① / resolver=RESOLVER / staleGrace=3 天 |

部署合计 gas ≈ 4.54M；按 Arc 主网 20 gwei 基费折算 ≈ 0.09 USDC 等值（R3 真实部署预算参考，<$0.5）。
六合约构造参数**逐一回读**并断言与预期一致（R3 主网同款自验逻辑已内置于 deploy 脚本）。

---

## 3. 资金路径逐笔流水（17 笔，全链 getLogs 回放重构）

### 3.1 MurmurToken —— 一次性铸币 + 发钞（2 条路径，4 笔）

| blk | 流向 | 数额 | 断言 |
|---|---|---|---|
| 22190781 | 零地址 → **TREASURY=ADMIN** | 1,000,000,000 MURMUR | 构造一次性铸币；之后 mint 路径不存在（ABI 扫描 0 特权函数） |
| 22190787 | ADMIN → BETTOR_A | 90,000 MURMUR | 发钞（fork 上以 impersonation 模拟签名 —— **主网等价=必须 ADMIN 本人私钥**，见 §5 钥匙分离证明） |
| 22190788 | ADMIN → BETTOR_B | 20,000 MURMUR | 同上 |

负向证明：路人以 `transferFrom` 动 ADMIN 余额 → revert（allowance=0）。MURMUR 不存在第四条出路。

### 3.2 x402 EIP-3009 结算 —— 繁殖费 / 版税（协议自主的原语级演练）

| blk | 流向 | 数额 | 断言 |
|---|---|---|---|
| 22190795 | BETTOR_A → **TREASURY=ADMIN** | 1.000000 USDC | **繁殖费确切落 EVOLUTION_TREASURY（=ADMIN）**；`AuthorizationUsed` 事件落链（客户端按 topic0 复核 count=2） |
| 22190796 | BETTOR_B → BETTOR_A（=breederOf(G0)） | 0.500000 USDC | 版税收款人**从链上血统读出**后按同原语结算；A 净值 = −1.0（费）+0.5（版税）与断言精确一致 |

要点：买家（BETTOR）只出 EIP-712 签名、从不交钥；facilitator（RESOLVER）代为提交 `transferWithAuthorization`；nonce 防重放、validAfter/validBefore 时窗生效。**这就是 arc-circle-x402 自持协议的生产结算原语，端到端落在用户钱包。**

### 3.3 WarCoffer —— 战争托管 + 税收（2 笔入、全程零流出）

| 步骤 | 资金动作 | 断言 |
|---|---|---|
| deposit ×2（blk 22190798/99） | RESOLVER → WarCoffer 各 25.000000 USDC | 实币 50.000000 == totalEscrow == **immutable 硬顶 50**；超顶 deposit → `EscrowCap` revert |
| declareWar #1 | 双方各 5 USDC 入 pot（**合约内转移**） | pot=10.000000；powerA=700/powerB=300 在 declare 时固化（resolve 时 resolver 无法干预） |
| resolveWar #1（deadline 后） | 胜者金库 +10 | **确定性胜者本地重算==合约裁定**（roll=186 < 700 → ATTACKER）；A=30 / B=20，净赢一个 stake |
| levyTax 1 USDC | vault → commonsPurse | 守恒不变；escrow 实币不动 |
| sweepTo(HOUSE_A) | purse → 金库 | purse 归零；**税留在自主金库体系内，不触任何外部地址** |
| expireStaleWar #2（OUTSIDER 触发） | 双方各拿回本方 5 USDC | 回到战前水位（30/20）；**resolver 死亡也不会锁死托管** |

守恒矩阵（4 个检查点全部通过）：`Σ(金库) + Σ(在战 pot) + commonsPurse == totalEscrow == WarCoffer 实币` = 50.000000 USDC，分毫不差。
**WarCoffer 全程 USDC 流出笔数 = 0** —— 合约层不存在任何把托管资金送出体系外的路径。

### 3.4 PredictionArena —— 竞技场（平价零和，零抽水）

| 轮次 | 下注 | 结果 | 派出 | 断言 |
|---|---|---|---|---|
| Round#1 | A 12,000 UP / B 8,000 DOWN | exit Δ=+0.05 > band 0.008 → **UP** | A 拿 20,000（本金+全额败池）；B 0 | **Σpayout(20,000) == Σstake(20,000)**；结清后托管归零；resolver/ADMIN MURMUR 余额分毫未动（**协议层零抽水，与设计一致**） |
| Round#2 | A 1,000 UP | Δ=+0.002 ≤ band → **FLAT** | A 全额退款 1,000 | 退款路径精确 |
| Round#3 | A 500 UP | resolver 未 resolve → OUTSIDER `expireStale` | A 全额退款 500 | **stale-grace 任何人可解锁，用户资金不可被死 resolver 锁定** |

负向：同轮反押 `SideTaken`、零注 `ZeroAmount`、注期内 resolve `BettingClosed` 全部按预期 revert。
竞技场最终托管 = 0；**竞技场全部 3 笔付款对象 100% 为下注者本人**。

### 3.5 全链账本总表（17 笔，角色白名单 100%）

USDC(mock)：3 笔 fork 注资（零地址铸币，非协议路径）+ 2 笔 x402 结算 + 2 笔战库存款；
MURMUR：1 笔铸币 + 2 笔发钞 + 3 笔下注 + 3 笔派出/退款。
**每一笔的 from/to 都落在白名单角色集合 {零地址(铸币), RESOLVER, TREASURY=ADMIN, BETTOR_A/B, WarCoffer, PredictionArena} 内 —— 第四方收付款地址：0 个。**

---

## 4. 主权与安全断言（负向矩阵 + 字节码级扫描）

| # | 攻击面 | 结果 |
|---|---|---|
| 1 | 非 resolver 调 WarCoffer `declareWar` / `sweepTo` | revert ✅ |
| 2 | 非 committer 调血统/清单 `commit`、断链 `commit`（prevHead 不匹配） | revert ✅ |
| 3 | 世代跳变（BadGeneration）、重复提交（AlreadyCommitted） | revert ✅ |
| 4 | 同轮反押 / 零注 / 注期内 resolve | revert ✅ |
| 5 | 超硬顶 deposit（EscrowCap） | revert ✅（50 USDC 上限不可突破） |
| 6 | 路人动 ADMIN 余额（无签名无授权） | revert ✅ |
| 7 | 第四方收付款地址（全链账本回放） | **0 个** ✅ |
| 8 | WarCoffer 托管流出 | **0 笔** ✅ |
| 9 | 竞技场付款对象 | 100% 下注者 ✅ |
| 10 | 路人收款 | 0 ✅ |
| 11 | MurmurToken 特权函数面（mint/pause/blacklist/owner/upgrade/setTreasury/burnFrom） | **不存在** ✅（唯一"特权"=构造器一次性铸币，随后永久消失） |
| 12 | 字节码 PUSH20 操作码走查（七合约） | 无真 PUSH20 地址立即数；3 个候选均为字符串/代码数据区误报（`eth_getCode` 复核无链上代码）。地址以 solc 0.8 immutable 尾部方案存在，且已由 §2 回读断言逐一比对 = {资产, RESOLVER} ✅ |
| 13 | 钥匙分离证明 | ADMIN 的 1,000 亿枚 MURMUR，彩排中必须 `anvil_impersonateAccount` 才能动 —— 主网等价 = **必须用户本人私钥**；协议合约内不存在任何绕过路径 ✅ |

---

## 5. 发现与决议（彩排的价值所在）

**F1 · Arc USDC precompile 在 anvil fork 上"只读可复刻、写入被阻断"（重要发现）**
现象：`0x3600…0000` 读路径（name/symbol/decimals/balanceOf）完全正常；任何写路径（含 eth_call 模拟的 `transfer`）一律 `execution reverted`。
根因：Arc 节点把 FiatTokenV2 的实际逻辑实现在节点原生 precompile 层，链上代码只是代理壳——anvil 只复刻 EVM 层，无法复刻原生层。
**决议**：资金路径彩排切换到自写 `contracts/MockUSDC.sol`（6 decimals + EIP-3009 `transferWithAuthorization` + `AuthorizationUsed` 事件 + EIP-712 域 `name="USDC"/version="2"`，与 Circle FiatTokenV2 语义同构；零依赖手写、MIT）。该资产与手册 R2 测试网方案本就一致；**合约头已声明"绝不上主网"**——R3 主网 WarCoffer 始终指向 Arc 原生 USDC precompile。真实 USDC 写路径的最终验证顺延到 R2（真实 Arc 测试网节点上执行，同一剧本复跑）。

**F2 · anvil 1.8.3 fork 模式 `eth_getLogs` 忽略 topics 过滤（方法学记录）**
实测：带 `topics:[X]` 的查询返回该地址全部事件。彩排账本本就采用客户端按 topic0 复核过滤（未受影响）；已把 AUTHUSED 断言改为客户端过滤后计数（=2 精确断言）。R2 在真实链上不受此影响。

**F3 · viem 多返回值为位置数组（集成提醒）**
`warInfo/roundInfo/payoutFor` 等多返回值经 viem 解码为无名数组，须按下标取值。前端 `app.js` 与 `src/war.ts` 集成时若换用 viem 需按索引访问（或改 ABI 命名输出）。

---

## 6. 放行结论与 R2 检查单

**R1 放行判定：通过。** 五件套 + 自发代币的全部资金路径在 Arc 主网 fork 环境逐笔演练并断言：
- 收款终点的并集 = {TREASURY=ADMIN, RESOLVER（项目自有 facilitator）, 胜者金库（WarCoffer 内部，仍属自主体系）, 下注者本人}，**不存在第五种去向**；
- 托管合约（WarCoffer/Arena）在演练中"只进不出或只对用户出"，无需信任任何第三方；
- 全部负向权限测试按设计 revert，不存在越权、后门、抽水、锁定。

**R2（Arc testnet 5042002）检查单**：
1. 测试网 DEPLOYER 领 gas（faucet 或小额）；
2. 继续使用 MockUSDC 作 `usdc_` 参数（同 R1 剧本），若测试网节点可写原生 USDC 则优先真 USDC 复跑 §3.2/§3.3；
3. 六合约真实部署 + explorer 肉眼核对构造参数；记录确认数与 gas 实耗；
4. 全剧本断言复跑（`r1-rehearsal.mjs` 改 RPC/CHAIN_ID 即可复用）；
5. 通过后进入 R3 主网部署（用户本人持 DEPLOYER 钥 + `*_CONFIRM=1` 门控）。

> 彩排剧本与断言引擎已固化为可复用工件：
> `packages/trader-worker/scripts/r1-lib.mjs`（断言引擎/账本/EIP-3009 签名/胜者复算/PUSH20 走查）
> `packages/trader-worker/scripts/r1-rehearsal.mjs`（七幕全剧本）
> `packages/trader-worker/scripts/compile-mock.mjs` + `contracts/MockUSDC.sol`（彩排/测试网资产）
