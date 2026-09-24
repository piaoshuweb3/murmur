#!/usr/bin/env node
// ============================================================================
// murmur 专用种子离线生成器 —— 部署手册 §2.3 密钥规划表配套工具（真实资金用）
// ----------------------------------------------------------------------------
// 为什么是这个脚本：
//   · 与 Worker 生产代码同一派生库（viem/accounts，见 src/keys.ts）
//     → 打印的地址与 Worker 上线后派生的地址逐位一致，可以放心按清单注资
//   · 零网络请求：只 import 本地 node_modules 与 node:crypto，不发送任何数据
//   · 熵源：window 等价物无关——直接 crypto.getRandomValues 级别的 CSPRNG（256-bit）
//
// 标准流程（手册 §2.3 纪律）：
//   1) 联网机器:  npm install          （装好 viem 即可，仓库根目录执行）
//   2) 彻底断网:  拔网线 / 关 WiFi / 关蓝牙（可选：进系统单用户或 Live USB）
//   3) 断网机器:  node scripts/offline-seed-gen.mjs
//        → 打印 24 词助记词（仅此一次显示）+ 全部派生地址（24 代理 + gas 钱包）
//   4) 纸质双备份 → 分开存放 → 回读校验:
//        node scripts/offline-seed-gen.mjs --check seed.txt
//        （seed.txt 内容 = 24 个单词，空格分隔；校验模式只派生地址、不回显助记词）
//   5) 真钱注入（仅阶段三、C2 之前）: npx wrangler secret put ECONOMY_MNEMONIC
//
// 红线：不截图 / 不拍照 / 不粘贴到任何聊天窗口 / 不存云笔记 / 不复用为执行层钱包。
// ============================================================================
import { generateMnemonic, mnemonicToAccount, english } from "viem/accounts";
import { readFileSync } from "node:fs";

const FACILITATOR_ACCOUNT_INDEX = 2_000_000; // 与 src/keys.ts 完全一致（gas 钱包专用高位索引）
const POP = Number(process.env.POPULATION_SIZE ?? 24); // 与 wrangler.toml POPULATION_SIZE 对齐

const derive = (mnemonic) => {
  const addr = (idx) => mnemonicToAccount(mnemonic, { accountIndex: idx }).address;
  return {
    agents: Array.from({ length: POP }, (_, id) => ({ id, address: addr(id) })),
    facilitator: addr(FACILITATOR_ACCOUNT_INDEX),
  };
};

const printDerived = (mnemonic, label) => {
  const { agents, facilitator } = derive(mnemonic);
  console.log(`\n── ${label} · 派生地址（BIP-44 m/44'/60'/0'/0/{index}，与 Worker 生产代码逐位一致）──`);
  for (const a of agents) console.log(`  agent #${String(a.id).padStart(2, "0")}  ${a.address}`);
  console.log(`  gas/facilitator    ${facilitator}   (accountIndex ${FACILITATOR_ACCOUNT_INDEX})`);
  console.log(`\n  注资清单（阶段三 §5.3，实盘 S2 之前才需要）：`);
  console.log(`    · gas/facilitator ← 少量 Arc 原生代币（结算手续费；净额结算下消耗极慢）`);
  console.log(`    · 各 agent 钱包    ← USDC（EIP-3009 买方直付；scripts/fund-agents.mjs 可批量分发）`);
  console.log(`  影子期（S1）一分钱都不需要 —— C2 全绿前不要注入任何资金。`);
};

const args = process.argv.slice(2);
if (args[0] === "--check") {
  if (!args[1]) {
    console.error("用法: node scripts/offline-seed-gen.mjs --check seed.txt（文件 = 24 个单词，空格分隔）");
    process.exit(1);
  }
  const words = readFileSync(args[1], "utf8").trim().replace(/\s+/g, " ");
  printDerived(words, "校验模式（只派生地址，不显示助记词）");
} else {
  const mnemonic = generateMnemonic(english, 256); // 24 词 / 256-bit 熵
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  专用助记词 —— 仅此一次显示。立即抄到两张纸质卡片，分开存放。        ║");
  console.log("║  抄完立即 --check 校验。此后：不截图 / 不拍照 / 不进聊天 / 不进云盘。║");
  console.log("║  这串词 = 全部代理钱包 + gas 钱包的资金最高权限（审计 F-9）。       ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("  " + mnemonic);
  printDerived(mnemonic, "新生成");
}
