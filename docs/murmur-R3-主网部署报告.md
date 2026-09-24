# murmur R3 主网部署报告（Arc Mainnet · chainId 5042）

> 执行时间：2026-09-23 07:45–07:46 UTC · 执行者：facilitator `0x20c54D8Fa205af293181833b46494d97d54753f3`
> 结果：**🟢 六合约全部上链，29/29 独立断言通过，gas 实耗 0.056659 USDC，资金层四旗仍全部关闭**

---

## 1. 执行概览

本阶段是三级彩排流水线（R1 本地 fork 67/67 → R2 测试网 71/71 → R3 主网）的收官一战。部署全程由编排器 `scripts/r3-mainnet-deploy.mjs` 驱动：六个子脚本 `deploy-*-auto.mjs` 逐单执行，每单均过 `*_CONFIRM=1` 主网确认阀，编排器在子脚本自检之外**二次独立读链**核对全部构造参数（resolver / committer / treasury / token / usdc / 硬顶 / 宽限期），并对每份部署字节码做操作码级 PUSH20 主权扫描。资金预检确认用户充值 5.05 USDC 已到账（tx `0x24e25306db728dc90229bd0c4d16a4a0644e16384fbbaf2c4f7ed2032fb3bab7`，block 22311644），且 `.env.local` 种子在 BIP-44 accountIndex 2,000,000 派生出的地址与充值地址逐位一致——钥匙自始至终未离开本机 `.env.local`（chmod 600、gitignored、零聊天零日志）。

执行中出现一次编排器证据记录层 bug（赋值时序，合约层零影响），修复后以**断点续跑**模式收尾：已上链的三单（MurmurToken / ReceiptRegistry / ManifestRegistry）只验不重部署，后三单全新部署——链上无任何重复合约，gas 零浪费。

## 2. 六合约地址总表（explorer 逐单可核）

| # | 合约 | 地址（checksummed） | 构造参数（链上回读 ✓） | 部署 tx |
|---|------|---------------------|------------------------|---------|
| ① | **MurmurToken** | [`0x43D84EfE7174637cdA55Ae1560cd4BFf4BaAB490`](https://explorer.arc.io/address/0x43D84EfE7174637cdA55Ae1560cd4BFf4BaAB490) | treasury=**ADMIN `0x1068…58B1`**（无钥），总量 1,000,000,000 MURMUR 一次性铸给 treasury 后铸币路径永不存在；symbol=MURMUR / 18-dec | [`0xdb403952…1d42880`](https://explorer.arc.io/tx/0xdb4039523db7f1a6059336038e9f2e00ac18b9962929ca8cadcfe139e1d42880) |
| ② | **NeuralReceiptRegistry** | [`0x87F6a942bb563dd7Bba4d3CdbD5d51477E71fc34`](https://explorer.arc.io/address/0x87F6a942bb563dd7Bba4d3CdbD5d51477E71fc34) | committer=facilitator `0x20c5…53f3`；chainHead 空（Worker 首次 commit 惰性播种） | [`0x52b49c93…4805d2b`](https://explorer.arc.io/tx/0x52b49c93550d42afcd6d88f264eb4570bc0fef3bb2fbe773e7e85cd7f4805d2b) |
| ③ | **NeuralManifestRegistry** | [`0x6caCEd7513b6E0b5B2c0CCD669c8A9dE6a0ce20e`](https://explorer.arc.io/address/0x6caCEd7513b6E0b5B2c0CCD669c8A9dE6a0ce20e) | committer=facilitator；**生产脑已锚定**：`0x403551bb4ed89402632e2e3c9c3abec3883e84b27931be78928e2f100f6efc02`（24 蝶离线重放 PASS 后才上链） | 部署 [`0x26dcbf8d…f78c9a5`](https://explorer.arc.io/tx/0x26dcbf8da78e72eb3422a5d27c5677e88d792438f357e9c909d4cf29af78c9a5) · commit [`0x34f54af5…5e909c8`](https://explorer.arc.io/tx/0x34f54af5a16953bcd253eb553b3eb4bad04ade2526c36dc0bfbd584cf5e909c8) |
| ④ | **ConnectomeLineage** | [`0xCbe979EE7ccB54823e43Df0B3D815f10E8eeaB07`](https://explorer.arc.io/address/0xCbe979EE7ccB54823e43Df0B3D815f10E8eeaB07) | committer=facilitator；commitCount=0（全新）；零资金托管 | [`0x42903f3a…52dc75f9`](https://explorer.arc.io/tx/0x42903f3a5c5bc050df9221418427d9926ebbcdbb35f917d4a013e0f352dc75f9) |
| ⑤ | **WarCoffer** | [`0x37a630e56bEa9B9214A638D31F761e9489C9f9C0`](https://explorer.arc.io/address/0x37a630e56bEa9B9214A638D31F761e9489C9f9C0) | usdc=**原生 USDC precompile `0x3600…0000`**；resolver=facilitator；**maxEscrow=50 USDC（immutable 硬顶）**；staleGrace=3 天（生产）；warCount=0 空仓启动 | [`0x0d2a0252…25db3bb`](https://explorer.arc.io/tx/0x0d2a02522babf997edc6f248b9e546fcc80bccdfcd18dabe8379bb11525db3bb) |
| ⑥ | **PredictionArena** | [`0x0243F95C2654C888a36B7B0DE1D200AaF7C16B60`](https://explorer.arc.io/address/0x0243F95C2654C888a36B7B0DE1D200AaF7C16B60) | token=**本部署 MURMUR ①**（上游兜底地址已在部署前从脚本剔除）；resolver=facilitator；staleGrace=3 天；roundCount=0 | [`0xb4e412b1…a9244be0`](https://explorer.arc.io/tx/0xb4e412b1e94b80c36e4ed3e7f233d6b4c4f201e96be3edee4de8fc49a9244be0) |

**地址三合一确认**：facilitator `0x20c5…53f3` = 部署 gas 付款人 = 全部五合约的 RESOLVER/COMMITTER = Worker 运营 gas 钱包（BIP-44 index 2,000,000，与 `src/keys.ts` 逐位一致）。

## 3. 主权矩阵（R3 专项核验）

| 检查项 | 结果 |
|--------|------|
| ADMIN `0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1` 全程零出流、零密钥 | ✓ 用户钱包只作为 MurmurToken treasury 接收全额供应，永不支付任何 gas |
| 上游黑名单（WarCoffer `0x3d90…454b` / Registry `0x94d0…c815` / Manifest `0x3412…9a37` / Lineage `0x482b…096f` / Arena `0xaf1a…8525` / 代币 `0x8faa…4a5d` / 部署者 `0x307D…3a0d` / 上游 facilitator `0x2b9a…` / R2 彩排钥 `0x1681…9f22`） | ✓ 构造参数逐一比对 + PUSH20 字节码扫描，**零命中** |
| 六合约 PUSH20 立即数地址扫描 | ✓ murmur 仅 treasury 自身；其余五合约零立即数地址 |
| 资金托管上界 | ✓ WarCoffer 硬顶 50 USDC 写死在字节码；stale 3 天后任何人可 `expireStale` 退款 |
| 生产脑锚定 | ✓ manifestHash 离线重放（24 蝶结构从承诺种子完整重建）PASS 后才 commit——不可复现的脑永不上链 |
| R2 测试网隔离 | ✓ 测试网 10 件套不接线、不销毁，仅作证据留档 |

## 4. gas 台账

| 项目 | 数值 |
|------|------|
| 充值入账 | 5.05 USDC（native, block 22311644） |
| 六单部署 + 一次脑锚定 commit（共 7 笔 tx） | **0.056659 USDC** |
| 剩余余额 | 4.970674 USDC（足够 Worker 影子期 + 逐旗开旗阶段的全部 gas） |

## 5. R4 逐旗开旗清单（待用户放行执行）

> 原则：**地址先接线、旗后开、每旗一冒烟、异常即翻回**。合约已上链不可变，所有开旗/回滚都只是 Worker 侧 wrangler.toml 变量翻转 + 重新部署，秒级可回。

### R4-0 地址接线（旗全关，纯只读冒烟）

在 wrangler.toml `[vars]` 写入（当前全部处于注释态，取消注释并填入）：

```toml
ECONOMY_REGISTRY_ADDRESS = "0x87F6a942bb563dd7Bba4d3CdbD5d51477E71fc34"
MANIFEST_REGISTRY_ADDRESS = "0x6caCEd7513b6E0b5B2c0CCD669c8A9dE6a0ce20e"
LINEAGE_ADDRESS = "0xCbe979EE7ccB54823e43Df0B3D815f10E8eeaB07"
WAR_ADDRESS = "0x37a630e56bEa9B9214A638D31F761e9489C9f9C0"
WAR_TREASURY = "0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1"
WAR_MAX_ESCROW_USDC = "50"
ARENA_ADDRESS = "0x0243F95C2654C888a36B7B0DE1D200AaF7C16B60"
ARENA_TOKEN = "0x43D84EfE7174637cdA55Ae1560cd4BFf4BaAB490"
COMMUNITY_TOKEN = "0x43D84EfE7174637cdA55Ae1560cd4BFf4BaAB490"
```

冒烟断言（旗全 false 下即可做，纯只读）：`/health` features 上报正常；链上 `chainHead()`/`latestHash()` 可读且与 §2 一致；前端 token ca 显示 `0x43d8…b490`。回滚：无（只读接线零风险）。

### R4-1 ARENA_ENABLED → "true"（竞技场，MURMUR 计价）

冒烟：Worker 首次 `openRound` 由 facilitator 签名成功、explorer 出现 arena tx、`/api/predict` 三态面板出真实轮次。前置：facilitator 需持少量 MURMUR 作为做市库存（从 treasury 拨付需 ADMIN 私钥——由用户决定拨付时点；零库存时空转无害）。回滚：`ARENA_ENABLED="false"` + redeploy。

### R4-2 WAR_ENABLED → "true"（战争 + 战争税，coffer 空仓启动）

冒烟：首轮 deposit→declareWar→resolveWar→levy→sweep 全链路 explorer 逐笔核对；托管余额始终 ≤ 50 USDC 硬顶；stale 演练触发 `expireStale` 退款。回滚：`WAR_ENABLED="false"` + redeploy（托管中资金按 staleGrace 规则自然退款）。

### R4-3 EVOLUTION_ENABLED → "true"（繁殖费，EIP-3009 直付 ADMIN）

冒烟：一笔 0.3 USDC 真实 `transferWithAuthorization` 结算落 ADMIN，收款人从链上 `breederOf` 读出。前置：`wrangler secret put ECONOMY_MNEMONIC`（在用户自有 CF 凭据的机器上执行，种子不经过任何第三方）。回滚：`EVOLUTION_ENABLED="false"` + redeploy。

### R4-4 COMMUNITY_ENABLED → "true"（token-gated 社区，只读门禁）

冒烟：`balanceOf` 门禁生效、社区页可访问。零资金路径。回滚：`COMMUNITY_ENABLED="false"` + redeploy。

### 开旗顺序与纪律

1. **顺序固定**：R4-0 → ARENA → WAR → EVOLUTION → COMMUNITY（资金暴露度从低到高，每旗观察 ≥24h 再开下一旗）。
2. **`ECONOMY_REAL_SPEND` 与 `EXECUTION_REAL_SPEND` 在影子期结论出炉前保持 "false"**——它们与上述四旗是两层独立开关，互不连带。
3. **每旗冒烟不过即停线**：翻回 false + redeploy 即回滚，合约层无需任何操作。
4. Cloudflare 侧的 `wrangler secret put ECONOMY_MNEMONIC` 与 `wrangler deploy` 需在**用户自己的** CF 凭据环境执行（上云手册 C2 节），种子不进任何对话与第三方环境。

## 6. 本轮附带的主权加固（部署前补丁）

- `deploy-arena-auto.mjs`：剔除内置的上游 MURMUR 兜底地址（`0x8faa…4a5d`），改为无显式 `ARENA_TOKEN` 即拒绝部署——上游代币永远不可能被静默接入。
- `deploy-registry-auto.mjs`：补齐缺失的主网确认阀 `REGISTRY_CONFIRM=1`（与其余五单对齐），并把 `RPC_URL`/`REGISTRY_COMMITTER` 纳入 process.env 合并链。
- 前端 `index.html` 的 token ca 展示、`openapi.ts` 示例、`community.test.ts` 夹具统一替换为本部署 MURMUR——全仓对上游代币地址的用户可见引用清零（仅主权黑名单扫描表保留样本）。
- 新增 `scripts/r3-fund-verify.mjs`（资金预检）与 `scripts/r3-mainnet-deploy.mjs`（编排器，含断点续跑），原始证据落盘 `scripts/r3-run-log.json`。

## 7. 三级彩排流水线终局

| 阶段 | 环境 | 断言 | 结论 |
|------|------|------|------|
| R1 | 本地 anvil fork（源链 5042） | 67/67 | 资金路径守恒、13 项负向矩阵全过 |
| R2 | Arc 测试网 5042002（真实时间轴） | 71/71 | 19 笔转账逐笔白名单、violations=0 |
| **R3** | **Arc 主网 5042（真 gas）** | **29/29** | **六合约上链、参数逐项回读一致、主权零让渡** |

三环境 167 项断言、同一套六合约字节码、零合约层缺陷。剩余动作全部在 Worker 配置层（R4 清单），由用户逐旗放行。
