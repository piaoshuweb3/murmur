// ============================================================================
// facilitator 私钥导出工具（用户本人执行 · 我方 AI 全程不接触输出）
// ============================================================================
// 用途：从 packages/trader-worker/.env.local 的 ECONOMY_MNEMONIC（24 词）
//       按 BIP-44 路径 m/44'/60'/2000000'/0/0 派生 facilitator 地址
//       0x20c54D8Fa205af293181833b46494d97d54753f3 的私钥，打印到【你的终端】。
//
// ⚠️ 安全纪律（不可协商）：
//   1. 只在【你自己的机器】上运行；私钥只会打印在你的屏幕上，绝不发给任何人，
//      绝不粘贴进任何聊天/AI/网页表单。
//   2. 导出即扩大暴露面：facilitator 是运营热钥（部署 gas 付款人 + 六合约的
//      RESOLVER/COMMITTER + Worker 签名钥）。导入任何在线钱包前想清楚——
//      真正该冷存的是【助记词本身】（纸上/钢板 = 等级最高的冷钱包）。
//   3. 导完即走：不要截图、不要存云笔记、不要留在剪贴板历史。
//   4. 若怀疑泄露：立即按 runbook《密钥轮换》换种子（新种子→注资→
//      wrangler secret 换钥→旧钱包扫空），合约层无需任何操作。
//
// 用法：
//   node scripts/export-facilitator-key.mjs --check        # 只验证地址匹配，不显示私钥（安全）
//   node scripts/export-facilitator-key.mjs --show         # 显示私钥（导入钱包时用）
//   node scripts/export-facilitator-key.mjs --show --index N   # 派生其他 accountIndex（默认 2000000）
// ============================================================================

import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", ".env.local");

const show = process.argv.includes("--show");
const idxArg = process.argv.indexOf("--index");
const accountIndex = idxArg > -1 ? Number(process.argv[idxArg + 1]) : 2_000_000;
const EXPECTED = "0x20c54D8Fa205af293181833b46494d97d54753f3"; // 充值/部署用 facilitator

// ---- 读取助记词（不打印）----
const env = readFileSync(envPath, "utf8");
const m = env.match(/^ECONOMY_MNEMONIC=(.*)$/m);
if (!m) { console.error("✗ .env.local 里没有 ECONOMY_MNEMONIC"); process.exit(1); }
const mnemonic = m[1].trim().replace(/^"|"$/g, "");

// ---- 派生 accountIndex 对应账户 ----
const hd = mnemonicToAccount(mnemonic, { accountIndex });
const address = hd.address;
const hdKey = hd.getHdKey();

// ---- 自校验：用导出的私钥重建地址，必须与 HD 派生逐位一致 ----
const privBuf = Buffer.from(hdKey.privateKey);
const privHex = "0x" + privBuf.toString("hex");
const rebuilt = privateKeyToAccount(/** @type {`0x${string}`} */ (privHex));
if (rebuilt.address.toLowerCase() !== address.toLowerCase()) {
  console.error("✗ 自校验失败（私钥重建地址 ≠ HD 派生地址），不要使用该输出！");
  process.exit(1);
}

console.log("════════ facilitator 密钥派生（本机离线计算，零网络请求）════════");
console.log("助记词来源 :", envPath, "（24 词，值不显示）");
console.log("BIP-44 路径: m/44'/60'/" + accountIndex + "'/0/0");
console.log("地址       :", address);
if (accountIndex === 2_000_000) {
  console.log("地址核验   :", address.toLowerCase() === EXPECTED.toLowerCase()
    ? "✓ 与充值/部署地址逐位一致"
    : "✗ 与期望 facilitator 不一致！停下，别导入任何东西");
}
console.log("私钥自校验 : ✓（privateKeyToAccount 重建地址 == HD 派生地址）");
if (!show) {
  console.log("\n（--check 模式：私钥未显示。导入钱包时加 --show 重跑）");
  process.exit(0);
}
console.log("\n──────────────────────── 以下仅显示在你的终端 ────────────────────────");
console.log("私钥       :", privHex);
console.log("──────────────────────── 显示完毕，即刻清理终端 ────────────────────────");
console.log("清屏命令: `clear` 或 `reset`；确认 history 不留痕（交互式命令不会进 bash history）");
