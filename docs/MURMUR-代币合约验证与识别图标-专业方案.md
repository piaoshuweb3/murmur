# MURMUR 代币：合约验证与识别图标专业方案

> 日期：2026-09-24 · 适用：Arc 主网 (chainId 5042) · 代币 `0x43D84EfE7174637cdA55Ae1560cd4BFf4BaAB490`
> 结论先行：**合约验证已 100% 完成（exact match）**；识别图标已生成并自有托管，钱包侧识别按三条路径推进（tokenlist 立即生效、Trust Wallet PR 高价值、explorer 信息提交待其开放）。

---

## 1. 为什么 MetaMask / Uniswap 会显示"未被证实"

这类提示不是"代币不合法"，而是三层信号各自独立判断的结果：

| 提示来源 | 判断依据 | 我们的对策 |
|---|---|---|
| MetaMask 交易/签名警告 | 链上 explorer 是否有已验证源码（Blockaid/安全供应商抓取） | ✅ 已解决：explorer 已显示 exact match 验证 |
| "未知代币/Unknown token" | 代币是否在钱包已知的 token list 里 | ✅ 已发布自有 tokenlist（见 §3） |
| 代币无图标 | 图标库（explorer token 信息、Trust Wallet assets 库、tokenlist logoURI） | ✅ 已生成并托管；Trust Wallet PR 素材就绪（见 §4） |

代币本身自部署起就是完全合规的 ERC-20：固定总量一次性铸出、无 owner、无暂停、无黑名单、无铸币后门——"未验证"只是元数据缺失，不是合约缺陷。

## 2. 合约验证：已完成（exact match）

**遇到的问题**：explorer.arc.io（Blockscout 实例）的 solc 编译器列表冻结在 2026 年 1 月（最高 v0.8.36），而 MURMUR 部署用的是 solc **0.8.37**——实例无法就地重编译。

**解决路径**（已闭环）：
1. 本地以 solc 0.8.37 重编译，与链上 creation/runtime 字节码**逐字节比对一致**（源码、编译器、优化设置、构造参数全部对得上）；
2. 通过 **Sourcify 官方 v2 API**（`POST /server/v2/verify/{chainId}/{address}`，编译器齐全且已注册 Arc 主网）提交 standard-json-input；
3. 返回 **`creationMatch: exact_match` + `runtimeMatch: exact_match`**（matchId 51894544）；
4. Blockscout 实例自动导入，合约页已显示 "Contract source code verified (exact match)"（Verified at Sep 24, 2026 18:22:41）。

可复跑脚本：`scripts/sourcify-verify-murmur.sh`（若未来重部署合约，改地址+参数即可复用同流程）。

**其余五份合约**（Registry/Arena/WarCoffer/Lineage/ManifestRegistry）：同样流程可验证。建议在下次维护窗口逐个执行，每份约 5 分钟；验证需要的全部素材（源码+编译设置+构造参数）都在 `packages/trader-worker/contracts/` 与部署脚本内。

## 3. 代币识别图标：已上线 + 立即可用的接入

- 图标：复古科学插画风格的果蝇徽记（圆章羊皮纸底，与站点视觉一致），已生成 512/128/32 三档。
- 自有托管（永久有效、无第三方依赖）：
  - `https://flyx402.xyz/token/murmur-logo.png`（512×512，主用）
  - `https://flyx402.xyz/token/murmur-logo-128.png`、`-32.png`
- **Uniswap 兼容 token list 已发布**：
  `https://flyx402.xyz/murmur.tokenlist.json`（符合 @uniswap/token-lists schema，chainId 5042，logoURI 指向自有托管）
  - Uniswap 界面 / 支持自定义 list 的钱包：粘贴该 URL 导入 list → 代币即刻显示名称+图标，消除"未知代币"。
  - MetaMask：`设置 → 网络 → (Arc) → Token List` 或在"导入代币"时用地址搜索（MetaMask 会聚合已注册 list）。
- 收款与展示零改动：不碰任何合约，纯元数据层。

## 4. Trust Wallet / MetaMask 图标库（高价值，PR 素材已备好）

**Trust Wallet assets 库已收录 Arc 链**（`blockchains/arc`，coin_type 10005042，active）——该库是 Trust Wallet、MetaMask 等大量钱包的图标数据源，收录后全网收益。

PR 包：`download/trustwallet-pr-package/`
- `logo.png`（512×512）
- 目标路径：`blockchains/arc/assets/0x43D84EfE7174637cdA55Ae1560cd4BFf4BaAB490/logo.png`
- 流程：fork `trustwallet/assets` → 按上述路径提交 → PR（标题 `Add MURMUR token logo for Arc (5042)`）→ CI 自动校验 → 合并生效。
- ⚠️ 需用户确认后再执行（以 piaoshuweb3 账号在第三方公开仓库发起 PR）。

## 5. explorer.arc.io 代币信息提交（待其开放）

尝试结果：该实例的 token-info 提交端点未开放（`/api/v2/tokens/{addr}/token-info-submission` 404）。这是实例运营方的可选项功能。
- 现状兜底：合约页已 verified，图标随 tokenlist/Sourcify 元数据可达。
- 后续：通过 Arc 官方渠道（Discord/支持邮箱）请求开启 token info submission，或直接请求他们为 MURMUR 配置 icon_url。一句话诉求模板：*"We are the deployer of MURMUR (0x43D8…B490, verified exact match). Please enable token-info submission or set our icon URL: https://flyx402.xyz/token/murmur-logo.png"*。

## 6. 长期路线（按优先级）

1. ✅（已完成）合约 exact-match 验证 + explorer 绿标
2. ✅（已完成）自有 tokenlist + logo 托管
3. ⏳ Trust Wallet assets PR（等用户确认）
4. ⏳ explorer token-info / 图标（等实例开放，或走 Arc 官方渠道）
5. 后续（有交易量后）：CoinGecko / CMC 收录申请（需要 DEX 流动性数据佐证）、Uniswap 官方 list 收录（需 Arc 进入 Uniswap 支持链清单）
6. 其余五合约验证（维护窗口批量执行）

## 附：红线重申

- 全程未触碰任何合约代码/权限（验证=只读比对，提交=纯元数据）；
- 图标与 tokenlist 全部托管在自有域名 flyx402.xyz；
- 未引入上游 EvolutionDeep 的任何地址、端点或素材。
