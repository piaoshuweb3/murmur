#!/usr/bin/env node
/**
 * funding-addresses.mjs — W1 注资地址清单生成器（只读 · 零签名 · 零密钥泄露）
 * ----------------------------------------------------------------------------
 * 用途：列出 Arc 主网(5042)上需要持有原生 USDC（= gas + 经济浮动金）的全部钱包，
 *       并实时读取链上余额，算出与目标浮动金的差额 —— 用户照表转账即可。
 *
 * 红线：
 *   · ECONOMY_MNEMONIC 只从 packages/trader-worker/.env.local 读入内存，绝不打印、
 *     绝不写入任何文件、绝不进入网络请求（派生地址在本地完成）。
 *   · 本脚本只做 eth_getBalance 读调用，不签名不广播，不碰任何合约写路径。
 *   · 打印的只有【公开地址 + 余额】——公开地址本就链上可见，无泄露面。
 *
 * 用法：
 *   node scripts/funding-addresses.mjs            # 表格 + 差额建议
 *   node scripts/funding-addresses.mjs --json     # 机器可读输出
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, http, defineChain } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_LOCAL = join(HERE, "..", ".env.local");

// ---- 1. 读 mnemonic（内存即焚：不 log、不落盘、不进 URL）--------------------
function readMnemonic() {
  let raw = "";
  try {
    raw = readFileSync(ENV_LOCAL, "utf8");
  } catch {
    console.error(`FATAL: 读不到 ${ENV_LOCAL}（该文件应含 ECONOMY_MNEMONIC=... ，gitignored）`);
    process.exit(1);
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*ECONOMY_MNEMONIC\s*=\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  console.error("FATAL: .env.local 里没有 ECONOMY_MNEMONIC");
  process.exit(1);
}

// ---- 2. Arc 主网（原生 gas = USDC，18 decimals）-----------------------------
const ARC = defineChain({
  id: 5042,
  name: "Arc Mainnet",
  nativeCurrency: { name: "USDC (native gas)", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

const RPC = process.env.RPC_URL_OVERRIDE || "https://rpc.mainnet.arc.io";
const client = createPublicClient({ chain: ARC, transport: http(RPC, { timeout: 20_000 }) });

// ---- 3. 派生地址（本地，不出网）--------------------------------------------
const MNEMONIC = readMnemonic();
const N_AGENTS = 24;                 // POPULATION_SIZE
const ADMIN = "0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1"; // 终极管理钱包（身份/收款，永不签名）

// ⚠ 云端实际布防（C2）：facilitator 用的是【专用 ECONOMY_FACILITATOR_PK secret】（R3 记录
// 0x20c5…53f3），不走种子派生索引 —— 所以 gas 钱包行直接用部署记录里的地址，不从本地派生。
const FACILITATOR_ADDRESS =
  process.env.FACILITATOR_ADDRESS_OVERRIDE || "0x20c54D8Fa205af293181833b46494d97d54753f3"; // R3 记录

const addr = (i) => mnemonicToAccount(MNEMONIC, { accountIndex: i }).address;  // 与 src/keys.ts 严格一致：m/44'/{coin}'/{i}'/0/0
const agents = Array.from({ length: N_AGENTS }, (_, i) => ({ id: i, path: `m/44'/60'/${i}'/0/0`, address: addr(i) }));

// 交叉核验：拉 live /economy 的云端真实代理地址，与本地派生逐一对比（只读公开端点）。
async function liveAddresses() {
  try {
    const res = await fetch("https://flyx402.xyz/economy", { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const d = await res.json();
    const map = new Map((d.agents || []).map((a) => [a.id, a.address]));
    return map.size ? map : null;
  } catch { return null; }
}
const LIVE = await liveAddresses();
const mismatch = LIVE
  ? agents.filter((a) => (LIVE.get(a.id) || "").toLowerCase() !== a.address.toLowerCase())
  : null;

// ---- 4. 链上余额（原生 USDC = gas + 经济浮动金）----------------------------
const wei = (v) => Number(v) / 1e18;
const targets = [
  { label: "facilitator(gas)", address: FACILITATOR_ADDRESS, target: 5.0 },
  ...agents.map((a) => ({ label: `agent#${a.id}`, address: a.address, target: 1.2 })),
  { label: "ADMIN(收款/身份)", address: ADMIN, target: 0 }, // 仅展示，不注资 gas
];

const rows = await Promise.all(
  targets.map(async (t) => {
    let bal = null;
    for (let k = 0; k < 3 && bal === null; k++) {
      try { bal = wei(await client.getBalance({ address: t.address })); } catch { bal = null; }
    }
    return { ...t, balance: bal };
  }),
);

const fmt = (v) => (v === null ? "RPC_FAIL" : v.toFixed(6));
const need = rows.filter((r) => r.label !== "ADMIN(收款/身份)").reduce((s, r) => s + Math.max(0, r.target - (r.balance ?? 0)), 0);
const totalBal = rows.filter((r) => r.label !== "ADMIN(收款/身份)").reduce((s, r) => s + (r.balance ?? 0), 0);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({
    chain: "arc-mainnet-5042", rpc: RPC, facilitator: FACILITATOR_ADDRESS,
    liveCrossCheck: LIVE ? (mismatch.length === 0 ? "24/24 agents match live /economy" : `MISMATCH: ${mismatch.map((m) => m.id).join(",")}`) : "live endpoint unreachable (skipped)",
    admin: ADMIN,
    wallets: rows.map((r) => ({ label: r.label, address: r.address, nativeUsdc: r.balance, target: r.target })),
    totalBalance: totalBal, totalNeededToTarget: need,
  }, null, 2));
} else {
  console.log("═".repeat(88));
  console.log(" W1 注资地址清单 · Arc 主网 5042 · 原生 USDC（gas+经济浮动金）· 只读派生，零密钥输出");
  console.log("═".repeat(88));
  console.log(` 地址核验: ${LIVE ? (mismatch.length === 0 ? "✅ 24/24 agent 地址与 flyx402.xyz/economy 云端真实地址一致" : `⚠️ ${mismatch.length} 个不一致: ${mismatch.map((m) => m.id).join(",")} —— 停！`) : "live 端点不可达，仅本地派生"}`);
  console.log("");
  console.log(" 地址                                                                 现余额      目标     缺口");
  for (const r of rows) {
    const gap = r.label === "ADMIN(收款/身份)" ? "—" : Math.max(0, r.target - (r.balance ?? 0)).toFixed(4);
    console.log(` ${r.label.padEnd(18)} ${r.address}  ${fmt(r.balance).padStart(9)}  ${r.target.toFixed(1).padStart(5)}  ${gap.padStart(7)}`);
  }
  console.log("-".repeat(88));
  console.log(` 合计浮动金现余额 ≈ ${totalBal.toFixed(4)} USDC · 补齐到目标还需 ≈ ${need.toFixed(2)} USDC`);
  console.log("");
  console.log(" 注资建议（~29 USDC 方案）：");
  console.log("   · facilitator 补到 5.0（按实测燃烧 0.6 USDC/天 ≈ 8 天缓冲，之后视燃烧率续充）");
  console.log("   · 24 个 agent 各补到 1.2（ECONOMY_DAILY_CAP=20/天、单 agent 2/天 的护栏内浮动金）");
  console.log("   · ADMIN 是身份/收款钱包，不需要 gas 浮动金（只展示余额）");
  console.log("   · 转账请用原生 USDC（Arc gas precompile），不是 ERC-20 MURMUR");
}
