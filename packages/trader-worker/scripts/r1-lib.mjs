// R1 rehearsal shared library — anvil fork drivers, assertion engine, transfer ledger.
// Zero-real-money drill: every key in this file is a rehearsal key; the only "real" value is
// TREASURY (= ADMIN), which appears as an ADDRESS ONLY and never needs a signature here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http, keccak256, stringToHex, concatHex, toHex, toBytes, pad,
  decodeEventLog, parseAbiItem,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(here, "..");

// ---------------------------------------------------------------------------
// identities (rehearsal-only; mirrors docs/murmur-合约部署彩排手册.md §1)
// ---------------------------------------------------------------------------
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
export const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // anvil #0
export const RESOLVER = mnemonicToAccount(ANVIL_MNEMONIC, { accountIndex: 2_000_000 }); // src/keys.ts FACILITATOR_ACCOUNT_INDEX
export const BETTOR_A = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"); // anvil #1
export const BETTOR_B = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"); // anvil #2
export const OUTSIDER = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"); // anvil #3
export const ADMIN = "0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1"; // TREASURY — address only, no key
export const USDC = "0x3600000000000000000000000000000000000000"; // Arc USDC precompile (FiatTokenV2, 6-dec)

// ---------------------------------------------------------------------------
// clients
// ---------------------------------------------------------------------------
export const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
export const CHAIN_ID = Number(process.env.CHAIN_ID || 31337);
export const chain = {
  id: CHAIN_ID,
  name: "anvil-arc-fork",
  nativeCurrency: { name: "Native", symbol: "NAT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
export const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000, batch: false }) });
export const walletFor = (account) => createWalletClient({ chain, transport: http(RPC, { timeout: 30_000 }), account });

// ---------------------------------------------------------------------------
// assertion engine
// ---------------------------------------------------------------------------
export const results = [];
export function A(cond, label, detail = "") {
  results.push({ ok: !!cond, label, detail });
  const tag = cond ? "  ✓ " : "  ✗ FAIL ";
  console.log(`${tag}${label}${detail ? `  [${detail}]` : ""}`);
  if (!cond) process.exitCode = 1;
  return !!cond;
}
export async function expectRevert(promise, label, marker = "") {
  try {
    await promise;
    A(false, label, marker ? `expected revert (${marker}) but call SUCCEEDED` : "expected revert but call SUCCEEDED");
    return false;
  } catch (e) {
    const msg = String(e?.shortMessage || e?.message || e);
    const hit = marker ? msg.toLowerCase().includes(marker.toLowerCase()) : true;
    A(true, label, hit ? `reverted as expected${marker ? `: ${marker}` : ""}` : `reverted but WITHOUT marker ${marker}: ${msg.slice(0, 140)}`);
    return hit;
  }
}
export const section = (t) => console.log(`\n──────────────────────────── ${t} ────────────────────────────`);

// ---------------------------------------------------------------------------
// anvil helpers
// ---------------------------------------------------------------------------
async function anvil(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`anvil ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
export const setBalance = (addr, wei) => anvil("anvil_setBalance", [addr, toHex(wei)]);
export const anvilCall = (method, params = []) => anvil(method, params);
export const impersonate = (addr) => anvil("anvil_impersonateAccount", [addr]);
export const stopImpersonate = (addr) => anvil("anvil_stopImpersonatingAccount", [addr]);
export const increaseTime = async (sec) => { await anvil("evm_increaseTime", [Number(sec)]); await anvil("evm_mine", []); };
export const nowTs = async () => Number((await pub.getBlock()).timestamp);

// ---------------------------------------------------------------------------
// deployment helper
// ---------------------------------------------------------------------------
export async function deploy(wallet, artifactPath, args, label) {
  const art = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args });
  const rc = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (rc.status !== "success") throw new Error(`deploy reverted: ${label}`);
  console.log(`  deployed ${label.padEnd(24)} ${rc.contractAddress}  (gas ${rc.gasUsed})`);
  return { address: rc.contractAddress, abi: art.abi, txHash: hash, gasUsed: rc.gasUsed };
}

// ---------------------------------------------------------------------------
// transfer ledger — every value-bearing ERC20 movement gets one row
// ---------------------------------------------------------------------------
export const TRANSFER_TOPIC = keccak256(stringToHex("Transfer(address,address,uint256)"));
export const AUTHUSED_TOPIC = keccak256(stringToHex("AuthorizationUsed(address,address,uint256)"));
export const ledger = [];
export function collectTransfers(logs, tokenName) {
  for (const lg of logs) {
    if (lg.topics[0] !== TRANSFER_TOPIC || lg.topics.length < 3) continue;
    if (!lg.data || lg.data.length < 66) continue; // 空/短 data：非标准余额转移，跳过
    const from = "0x" + lg.topics[1].slice(26);
    const to = "0x" + lg.topics[2].slice(26);
    const value = BigInt(lg.data);
    ledger.push({ token: tokenName, from, to, value, txHash: lg.transactionHash, logIndex: lg.logIndex, block: Number(lg.blockNumber) });
  }
}
export function fmt(value, decimals) {
  const s = value.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals) || "0"}.${s.slice(-decimals)}`;
}
export const fmtU = (v) => fmt(v, 6);   // USDC
export const fmtM = (v) => fmt(v, 18);  // MURMUR

// address roles for the sovereignty whitelist
export const ROLES = new Map();
export const role = (addr, r) => ROLES.set(addr.toLowerCase(), r);
export const roleOf = (addr) => ROLES.get(addr.toLowerCase()) || "⚠ UNKNOWN";

// ---------------------------------------------------------------------------
// EIP-3009 (production protocol of packages/arc-circle-x402 — inlined verbatim semantics)
// ---------------------------------------------------------------------------
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};
export async function signEip3009(account, { asset, to, value, chainId = CHAIN_ID, usdcVersion = "2", validBefore }) {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const message = { from: account.address, to, value, validAfter: 0n, validBefore: BigInt(validBefore), nonce };
  const signature = await account.signTypedData({
    domain: { name: "USDC", version: usdcVersion, chainId, verifyingContract: asset },
    types: EIP3009_TYPES, primaryType: "TransferWithAuthorization", message,
  });
  return { signature, ...message };
}

// ---------------------------------------------------------------------------
// WarCoffer winner recomputation — must byte-match the contract's _deriveWinner
// ---------------------------------------------------------------------------
export function deriveWinner(warId, attacker, defender, powerA, powerB) {
  const total = powerA + powerB;
  const pack = concatHex([toHex(warId, { size: 32 }), toHex(attacker, { size: 32 }), toHex(defender, { size: 32 }), toHex(powerA, { size: 32 }), toHex(powerB, { size: 32 })]);
  const roll = BigInt(keccak256(pack)) % total;
  return { winner: roll < powerA ? 1 : 2, roll, total }; // 1=WIN_ATTACKER 2=WIN_DEFENDER
}

// ---------------------------------------------------------------------------
// USDC 注资兜底：直接写 balanceOf 槽位（FiatToken 布局，slot 9 优先；带探测校验与还原）
// ---------------------------------------------------------------------------
export async function fundViaSlot(who, amt) {
  for (const slot of [9n, 0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 10n, 11n, 12n]) {
    const key = keccak256(concatHex([pad(who, { size: 32 }), pad(toHex(slot), { size: 32 })]));
    const orig = await anvil("eth_getStorageAt", [USDC, key, "latest"]);
    await anvil("anvil_setStorageAt", [USDC, key, pad(toHex(amt, { size: 32 }))]);
    const b = await pub.readContract({ address: USDC, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [who] });
    if (b === amt) return true;
    if (orig && orig !== "0x" + "0".repeat(64)) await anvil("anvil_setStorageAt", [USDC, key, orig]);
  }
  return false;
}

// ---------------------------------------------------------------------------
// PUSH20 address-constant scan (sovereignty audit over deployed runtime code)
// 字节级操作码走查：只在真 PUSH20 指令处取 20 字节立即数（避免数据段误报）
// ---------------------------------------------------------------------------
export async function scanPush20(address) {
  const code = (await pub.getCode({ address })).slice(2).toLowerCase();
  const out = [];
  let i = 0;
  while (i + 1 < code.length) {
    const op = parseInt(code.slice(i, i + 2), 16);
    if (op >= 0x60 && op <= 0x7f) {
      const size = op - 0x5f;
      if (op === 0x73 && i + 2 + 40 <= code.length) out.push("0x" + code.slice(i + 2, i + 2 + 40));
      i += 2 + size * 2;
    } else i += 2;
  }
  return out;
}
