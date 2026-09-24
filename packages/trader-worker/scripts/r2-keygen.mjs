// R2 keygen — 一次性生成测试网彩排钥匙（绝不复用主网钥、绝不上主网）
// 用法: node scripts/r2-keygen.mjs
// 行为: 若 packages/trader-worker/.env.local 已含 R2_DEPLOYER_PK 则保留（防资金丢失），
//       否则生成全套 R2_* 钥写入 .env.local（gitignored）。控制台只打印地址，绝不打印私钥。
import fs from "node:fs";
import path from "node:path";
import { generateMnemonic, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { wordlist } from "@scure/bip39/wordlists/english";
import { toHex } from "viem";

const root = path.resolve(import.meta.dirname, "..");
const envPath = path.join(root, ".env.local");

const readEnv = () => (fs.existsSync(envPath) ? Object.fromEntries(fs.readFileSync(envPath, "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])) : {});
const env = readEnv();
const out = { ...env };

if (!out.R2_DEPLOYER_PK) out.R2_DEPLOYER_PK = toHex(crypto.getRandomValues(new Uint8Array(32)));
if (!out.R2_BETTOR_A_PK) out.R2_BETTOR_A_PK = toHex(crypto.getRandomValues(new Uint8Array(32)));
if (!out.R2_BETTOR_B_PK) out.R2_BETTOR_B_PK = toHex(crypto.getRandomValues(new Uint8Array(32)));
if (!out.R2_OUTSIDER_PK) out.R2_OUTSIDER_PK = toHex(crypto.getRandomValues(new Uint8Array(32)));
if (!out.R2_MNEMONIC) out.R2_MNEMONIC = generateMnemonic(wordlist);

fs.writeFileSync(envPath, Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });

const dep = privateKeyToAccount(out.R2_DEPLOYER_PK);
const res = mnemonicToAccount(out.R2_MNEMONIC, { accountIndex: 2_000_000 }); // 与 src/keys.ts FACILITATOR_ACCOUNT_INDEX 同源派生路径
const a = privateKeyToAccount(out.R2_BETTOR_A_PK);
const b = privateKeyToAccount(out.R2_BETTOR_B_PK);
const o = privateKeyToAccount(out.R2_OUTSIDER_PK);

console.log("R2 测试网彩排钥匙已就位（.env.local，gitignored，绝不入库）\n");
console.log(`  DEPLOYER (领 faucet gas)      ${dep.address}`);
console.log(`  RESOLVER  (mnemonic idx 2,000,000) ${res.address}`);
console.log(`  BETTOR_A                      ${a.address}`);
console.log(`  BETTOR_B                      ${b.address}`);
console.log(`  OUTSIDER                      ${o.address}`);
console.log(`\n→ 去 https://faucet.circle.com 登录领取 Arc testnet gas 到 DEPLOYER 地址`);
console.log(`→ 领取后运行: RPC_URL=https://rpc.testnet.arc.io CHAIN_ID=5042002 node scripts/r2-rehearsal.mjs`);
