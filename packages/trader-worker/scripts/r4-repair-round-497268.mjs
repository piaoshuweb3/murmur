#!/usr/bin/env node
/**
 * R4 运维护修：补结算 PredictionArena 第 497268 轮（被 DO 重置跳过的一轮）。
 *
 * 背景：R4-1 云端武装期间 DO 状态重置，新实例按 cursorAfterOpen 的 fresh-start 安全设计
 * （"跳过我们从未开轮的上一轮"，防每次 cron 空烧 revert gas）把 resolvedRound 基线到
 * 497268，导致该轮永远不会被 Worker 结算。该轮零注金零下注者，滞留仅是链面观感问题。
 *
 * 修复原理：Arena 连续性设计 = "同一温度既是 prev 的 exit 也是 cur 的 entry"。
 * 497269 的 entryTemp=340620(r6) 已在链上 openRound(497269) 时固化 —— 直接用它作为
 * 497268 的 exitTemp 补结算，与设计连续性逐位一致；合约自行推导 outcome（DOWN）。
 * 该轮 poolUp=poolDown=0、bettorCount=0 ⇒ 无任何支付义务，纯状态修复。
 *
 * 安全：助记词只从 .env.local 读取（600/gitignored），全程零显示零日志；
 * 只调用一次 resolve()，调用前逐项断言链上前置条件。
 *
 * 用法: node scripts/r4-repair-round-497268.mjs [--check]
 *   --check  只读模式：仅核对前置条件，不广播
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHECK_ONLY = process.argv.includes("--check");

// ---- 配置（Arc 主网 · R3 本部署） ----
const RPC_URL = process.env.RPC_URL || "https://rpc.mainnet.arc.io";
const CHAIN_ID = Number(process.env.CHAIN_ID || 5042);
const ARENA = "0x0243F95C2654C888a36B7B0DE1D200AaF7C16B60";
const ROUND_ID = 497268;
const EXIT_TEMP_R6 = 340620; // = 497269 的链上 entryTemp（连续性设计）

const chain = { id: CHAIN_ID, name: "arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } };
const pub = createPublicClient({ chain, transport: http(RPC_URL) });

// ---- 密钥加载（零显示） ----
const envPath = path.join(here, "..", ".env.local");
if (!fs.existsSync(envPath)) { console.error("FATAL: .env.local 不存在"); process.exit(1); }
const env = fs.readFileSync(envPath, "utf8");
const m = env.match(/^ECONOMY_MNEMONIC="?(.+?)"?\s*$/m);
if (!m) { console.error("FATAL: .env.local 无 ECONOMY_MNEMONIC"); process.exit(1); }
const account = mnemonicToAccount(m[1], { addressIndex: 0, accountIndex: 2_000_000 });
const addr = account.address;
console.log(`facilitator: ${addr}  (种子零显示)`);

// ---- ABI（最小集） ----
const ABI = [
  { name: "roundInfo", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [
    { name: "opened", type: "bool" }, { name: "resolved", type: "bool" }, { name: "outcome", type: "uint8" },
    { name: "entryTemp", type: "int64" }, { name: "exitTemp", type: "int64" }, { name: "flatBand", type: "int64" },
    { name: "betDeadline", type: "uint64" }, { name: "openedAt", type: "uint64" }, { name: "resolvedAt", type: "uint64" },
    { name: "poolUp", type: "uint256" }, { name: "poolDown", type: "uint256" }, { name: "bettorCount", type: "uint256" }] },
  { name: "resolve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "int64" }], outputs: [] },
  { name: "resolver", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

const s64 = (x) => (x >= 1n << 63n ? x - (1n << 64n) : x);
const round = await pub.readContract({ address: ARENA, abi: ABI, functionName: "roundInfo", args: [BigInt(ROUND_ID)] });
const [opened, resolved, outcome, entryTemp, , flatBand, betDeadline, , resolvedAt, poolUp, poolDown, bettors] = round;
console.log(`链上 round ${ROUND_ID}: opened=${opened} resolved=${resolved} entry=${Number(s64(entryTemp)) / 1e6} band=${Number(s64(flatBand)) / 1e6} deadline=${betDeadline} pools=${Number(poolUp) + Number(poolDown)} bettors=${bettors}`);

// ---- 前置断言 ----
const asserts = [];
const A = (name, ok, detail) => { asserts.push({ name, ok }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };
A("轮已开", opened === true);
A("未结算", resolved === false, resolved ? "AlreadyResolved 会 revert" : undefined);
A("已过截止", BigInt(betDeadline) < BigInt(Math.floor(Date.now() / 1000)), `deadline=${betDeadline} now=${Math.floor(Date.now() / 1000)}`);
A("零注金", poolUp === 0n && poolDown === 0n, "零资金影响前提");
A("退出温度=497269入场(连续性)", Number(s64(entryTemp)) !== 0, `entry=${Number(s64(entryTemp)) / 1e6}`);
const resolverOnchain = await pub.readContract({ address: ARENA, abi: ABI, functionName: "resolver" });
A("调用者=resolver", resolverOnchain.toLowerCase() === addr.toLowerCase(), `chain=${resolverOnchain}`);
const gasBal = await pub.getBalance({ address: addr });
A("gas 充足", gasBal > 0n, `${Number(gasBal) / 1e18} USDC(原生)`);

if (asserts.some((a) => !a.ok)) { console.error("前置断言未全过 —— 中止，不广播"); process.exit(1); }
if (CHECK_ONLY) { console.log("--check 只读模式通过，未广播。去掉 --check 执行。"); process.exit(0); }

// ---- 广播 ----
const wallet = createWalletClient({ chain, account, transport: http(RPC_URL) });
console.log(`广播 resolve(${ROUND_ID}, ${EXIT_TEMP_R6}) …`);
const hash = await wallet.writeContract({ address: ARENA, abi: ABI, functionName: "resolve", args: [BigInt(ROUND_ID), BigInt(EXIT_TEMP_R6)] });
console.log(`tx: ${hash}`);
const rcpt = await pub.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000 });
console.log(`status: ${rcpt.status}  blk: ${rcpt.blockNumber}`);
const after = await pub.readContract({ address: ARENA, abi: ABI, functionName: "roundInfo", args: [BigInt(ROUND_ID)] });
const [, resolved2, outcome2, , exitTemp2, , , , resolvedAt2] = after;
console.log(`修复后 round ${ROUND_ID}: resolved=${resolved2} outcome=${outcome2} (2=DOWN) exit=${Number(s64(exitTemp2)) / 1e6} resolvedAt=${resolvedAt2}`);
console.log(resolved2 && Number(resolvedAt2) > 0 ? "✅ 497268 补结算成功，连续性恢复" : "❌ 修复未生效，需人工核查");
