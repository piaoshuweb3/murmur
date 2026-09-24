// Fully-automatic MurmurToken deployment — the deployment's OWN ERC-20 (0 号工件).
//
// You fill packages/trader-worker/.env.local with ONE of:
//   ECONOMY_MNEMONIC          (the same seed the Worker uses — we derive the identical facilitator wallet)
//   ECONOMY_FACILITATOR_PK    (a dedicated gas key, if the Worker was configured with one)
//   MURMUR_DEPLOYER_PK        (any gas wallet key to deploy)
// then run:  node scripts/deploy-murmur-auto.mjs
//
// It deploys MurmurToken(treasury, supply) — the FULL fixed supply is minted once to TREASURY and
// the mint path ceases to exist after construction (see contracts/MurmurToken.sol). TREASURY defaults
// to this deployment's own admin wallet; override with MURMUR_TREASURY. The secret key is never printed.
//
// SAFETY: this spends REAL gas. A MAINNET deploy is gated behind MURMUR_CONFIRM=1 — drill on
// testnet (CHAIN_ID=5042002) first. Wiring ARENA_TOKEN/COMMUNITY_TOKEN is a SEPARATE, deliberate step.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/** Sovereignty default: this deployment's own admin wallet. Override with MURMUR_TREASURY. */
const DEFAULT_TREASURY = "0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1";

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
const envFile = path.join(root, ".env.local");
const env = { ...readEnv(envFile) };
for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "CHAIN_ID", "RPC_URL", "MURMUR_TREASURY", "MURMUR_SUPPLY", "MURMUR_CONFIRM"]) {
  if (!env[k] && process.env[k]) env[k] = process.env[k];
}

const proxy = env.HTTPS_PROXY || env.HTTP_PROXY;
if (proxy) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxy));
  console.log("proxy    :", proxy);
}

const FACILITATOR_ACCOUNT_INDEX = 2_000_000; // must match src/keys.ts
const normPk = (s) => (s.startsWith("0x") ? s : `0x${s}`);
const isHexKey = (s) => /^(0x)?[0-9a-fA-F]{64}$/.test(s.trim());
let account;
if (env.MURMUR_DEPLOYER_PK) {
  account = privateKeyToAccount(normPk(env.MURMUR_DEPLOYER_PK.trim()));
  console.log("key src  : MURMUR_DEPLOYER_PK");
} else if (env.ECONOMY_FACILITATOR_PK) {
  account = privateKeyToAccount(normPk(env.ECONOMY_FACILITATOR_PK.trim()));
  console.log("key src  : ECONOMY_FACILITATOR_PK");
} else if (env.ECONOMY_MNEMONIC) {
  const m = env.ECONOMY_MNEMONIC.trim();
  if (isHexKey(m)) {
    account = privateKeyToAccount(normPk(m));
    console.log("key src  : ECONOMY_MNEMONIC field held a raw hex private key (used as PK)");
  } else {
    account = mnemonicToAccount(m, { accountIndex: FACILITATOR_ACCOUNT_INDEX });
    console.log("key src  : ECONOMY_MNEMONIC (derived facilitator, accountIndex " + FACILITATOR_ACCOUNT_INDEX + ")");
  }
} else {
  console.error("\n✗ 没有密钥。请在 packages/trader-worker/.env.local 里填写 ECONOMY_MNEMONIC 或一把私钥，然后重跑。");
  process.exit(1);
}

const chainId = Number(env.CHAIN_ID || "5042");
const rpcUrl = env.RPC_URL || (chainId === 5042 ? "https://rpc.mainnet.arc.io" : "https://rpc.testnet.arc.io");
const chain = {
  id: chainId,
  name: chainId === 5042 ? "Arc Mainnet" : "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
};
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const wallet = createWalletClient({ chain, transport: http(rpcUrl), account });

const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts", "build", "MurmurToken.json"), "utf8"));
console.log("chain    :", chainId, rpcUrl);

// ---- resolve TREASURY (the one-shot mint recipient) ----
const treasury = (env.MURMUR_TREASURY || DEFAULT_TREASURY).trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(treasury)) {
  console.error("\n✗ MURMUR_TREASURY 不是合法地址（0x + 40 hex）。中止。");
  process.exit(1);
}

// ---- fixed supply (whole tokens; 18-dec applied here) ----
const supplyWhole = Number(env.MURMUR_SUPPLY || "1000000000"); // 1,000,000,000 MURMUR
if (!Number.isFinite(supplyWhole) || supplyWhole <= 0 || !Number.isInteger(supplyWhole)) {
  console.error("\n✗ MURMUR_SUPPLY 必须是正整数（枚）。一次性 mint，铸完即固化。");
  process.exit(1);
}
const supply = BigInt(supplyWhole) * BigInt(10) ** BigInt(18);

console.log("deployer :", account.address, "(pays gas)");
console.log("treasury :", treasury, treasury.toLowerCase() === DEFAULT_TREASURY.toLowerCase() ? "(deployment admin — default)" : "(override)");
console.log("supply   :", supplyWhole.toLocaleString("en-US"), "MURMUR (fixed forever, minted once)");

const bal = await publicClient.getBalance({ address: account.address });
console.log("deployer gas bal:", (Number(bal) / 1e18).toFixed(6), "USDC(native)");
if (bal === 0n) {
  console.error("\n✗ deployer 余额为 0，无法支付部署 gas。请先给该地址充值。");
  process.exit(1);
}

// ---- MAINNET gate ----
if (chainId === 5042 && env.MURMUR_CONFIRM !== "1") {
  console.error("\n✗ 这是【主网 5042】部署：会花真 gas，并把总供应 " + supplyWhole.toLocaleString("en-US") + " MURMUR 一次性铸给 " + treasury + "。");
  console.error("  · 想先演练：CHAIN_ID=5042002 重跑（测试网）。");
  console.error("  · 确认要上主网：加 MURMUR_CONFIRM=1 重跑（并与助手确认过参数）。");
  console.error("  部署后代币不会自动接线：ARENA_TOKEN/COMMUNITY_TOKEN 是单独的、刻意的步骤。");
  process.exit(1);
}

// ---- deploy ----
console.log("\ndeploying MurmurToken …");
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [treasury, supply] });
console.log("deploy tx:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== "success") { console.error("✗ 部署交易 revert 了"); process.exit(1); }
const address = receipt.contractAddress;
console.log("token    :", address);

// ---- self-verify the deployed immutables ----
const onName = await publicClient.readContract({ address, abi: artifact.abi, functionName: "name" });
const onSymbol = await publicClient.readContract({ address, abi: artifact.abi, functionName: "symbol" });
const onDec = await publicClient.readContract({ address, abi: artifact.abi, functionName: "decimals" });
const onSupply = await publicClient.readContract({ address, abi: artifact.abi, functionName: "totalSupply" });
const onBal = await publicClient.readContract({ address, abi: artifact.abi, functionName: "balanceOf", args: [treasury] });
console.log("verify   : name/symbol/dec =", onName, "/", onSymbol, "/", onDec, onSymbol === "MURMUR" && onDec === 18 ? "✓" : "✗ MISMATCH");
console.log("verify   : totalSupply     =", onSupply.toString(), onSupply === supply ? "✓" : "✗ MISMATCH");
console.log("verify   : treasury bal    =", onBal.toString(), onBal === supply ? "✓ (full supply held by treasury)" : "✗ MISMATCH");

// ---- persist the address for the Worker wiring step ----
fs.writeFileSync(path.join(root, "contracts", "MURMUR_ADDRESS.txt"), address + "\n");
let envTxt = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
if (/^\s*MURMUR_ADDRESS\s*=/m.test(envTxt)) {
  envTxt = envTxt.replace(/^\s*MURMUR_ADDRESS\s*=.*$/m, `MURMUR_ADDRESS=${address}`);
} else {
  envTxt += `\nMURMUR_ADDRESS=${address}\n`;
}
fs.writeFileSync(envFile, envTxt);

console.log("\n✅ MurmurToken 已部署。地址：", address);
console.log("已写入 contracts/MURMUR_ADDRESS.txt 和 .env.local(MURMUR_ADDRESS)。");
console.log("下一步(需与助手确认后再做)：wrangler.toml 里设 ARENA_TOKEN=" + address + "（竞技场）与 COMMUNITY_TOKEN=" + address + "（社区门禁）。");
