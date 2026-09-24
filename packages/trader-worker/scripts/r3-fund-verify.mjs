// R3 主网资金核验（只读，零签名、零 gas）——部署前最后一道闸。
// 核验四件事：
//   1. chainId == 5042（Arc 主网）
//   2. facilitator（用户充值目标 0x20c5…53f3）原生 USDC 余额
//   3. 用户提供的充值 tx 回执（status/from/to/value）
//   4. .env.local 的 ECONOMY_MNEMONIC 派生地址 == 充值地址（逐位一致，钥匙零回显）
// 用法: node scripts/r3-fund-verify.mjs [fundingTxHash]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// ---- 主权黑名单（R3 部署前后全参数扫描；缺省无第三方地址）----
const BLACKLIST = {
  "0x3d900b8d1d48b46fc18a3f57dfd15a4a28bb454b": "上游 WarCoffer",
  "0x94d0c38bcc9957eaf8f318e6bbc6557f8cc3c815": "上游 NeuralReceiptRegistry",
  "0x3412eb909252adb983aaf793f97a3754ca029a37": "上游 NeuralManifestRegistry",
  "0x482b7a3bbef796c9627d86d5a23c67728a78096f": "上游 ConnectomeLineage",
  "0xaf1ae61e12c101d179a2f65a5f2e02e690968525": "上游 PredictionArena",
  "0x8faae5592b9acc27a79fca745c6b872adf514a5d": "上游 MURMUR 代币",
  "0x307d8a9333bd3e4fce93fffac6468eb7478423a0d": "上游项目部署者钱包",
  "0x168145bedf51773b639e83c6c8321eb91d969f22": "R2 测试网彩排 DEPLOYER（与主网隔离）",
};
// 前缀黑名单（全文地址不可考的上游钱包）
const BLACKLIST_PREFIX = ["0x2b9a"]; // 上游 Worker facilitator（…055c）

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const FUNDED = "0x20c54D8Fa205af293181833b46494d97d54753f3"; // 用户已充值的目标地址
const txHash = (process.argv[2] || "0x24e25306db728dc90229bd0c4d16a4a0644e16384fbbaf2c4f7ed2032fb3bab7").trim();

const rpcUrl = process.env.RPC_URL || "https://rpc.mainnet.arc.io";
const chain = {
  id: 5042,
  name: "Arc Mainnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};
const pc = createPublicClient({ chain, transport: http(rpcUrl) });

let fails = 0;
const ok = (cond, label, detail) => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? "  " + detail : ""}`);
  if (!cond) fails++;
};

// 1. chainId
const chainId = await pc.getChainId();
ok(chainId === 5042, `chainId = ${chainId}（Arc 主网 5042）`);

// 2. facilitator 余额
const bal = await pc.getBalance({ address: FUNDED });
const balUsdc = Number(bal) / 1e18;
console.log(`  facilitator ${FUNDED}`);
ok(bal > 0n, `余额 = ${balUsdc.toFixed(6)} USDC(native, 18-dec)`, bal >= 2n * 10n ** 18n ? "(≥2 USDC，足够六单部署)" : "(⚠ 低于 2 USDC——建议再补气)");

// 3. 充值 tx 回执
try {
  const receipt = await pc.getTransactionReceipt({ hash: txHash });
  const tx = await pc.getTransaction({ hash: txHash });
  ok(receipt.status === "success", `充值 tx 状态 = ${receipt.status}`, `block ${receipt.blockNumber}`);
  console.log(`  from ${tx.from} → to ${tx.to} · value ${Number(tx.value) / 1e18} USDC(native)`);
  ok((tx.to || "").toLowerCase() === FUNDED.toLowerCase(), "tx 接收方 == facilitator");
  // 到账复核：value 直接进地址（普通转账）
  ok(Number(tx.value) > 0n, `tx value = ${Number(tx.value) / 1e18} USDC`);
} catch (e) {
  ok(false, `充值 tx 读取失败：${String(e).slice(0, 120)}`);
}

// 4. .env.local 种子派生地址 == 充值地址（钥匙零回显）
const env = readEnv(path.join(root, ".env.local"));
if (!env.ECONOMY_MNEMONIC) {
  ok(false, ".env.local 无 ECONOMY_MNEMONIC —— 无法派生 facilitator");
} else if (/^(0x)?[0-9a-fA-F]{64}$/.test(env.ECONOMY_MNEMONIC.trim())) {
  ok(false, "ECONOMY_MNEMONIC 字段是一把裸私钥（不符合种子卡流程）——请人工核查");
} else {
  const derived = mnemonicToAccount(env.ECONOMY_MNEMONIC.trim(), { accountIndex: 2_000_000 }).address;
  ok(derived.toLowerCase() === FUNDED.toLowerCase(), `种子派生(index 2,000,000) == 充值地址`, derived);
}

// 5. facilitator 不在黑名单
ok(!BLACKLIST[FUNDED.toLowerCase()], "facilitator 不在主权黑名单");

// 6. 代码检查：facilitator 必须是 EOA（无合约代码）
const code = await pc.getCode({ address: FUNDED });
ok(!code || code === "0x", "facilitator 是全新 EOA（无合约代码）");

console.log(`\n${fails === 0 ? "🟢 R3 资金预检全部通过 —— 可进入六合约部署。" : `🔴 ${fails} 项未过 —— 部署中止。`}`);
process.exit(fails === 0 ? 0 : 2);
