// ============================================================================
// R3 主网六合约逐单部署编排器 —— 用户已放行（充值 5.05 USDC 到 facilitator 并明确指令）。
// ----------------------------------------------------------------------------
// 职责：
//   1. 预检：chainId 5042 / facilitator 派生一致（钥匙零回显）/ 余额充足 / 黑名单零命中
//   2. 顺序部署六合约（每个子脚本自带 *_CONFIRM=1 主网阀 + 构造参数回读自检）：
//        MurmurToken → NeuralReceiptRegistry → NeuralManifestRegistry(+commit)
//        → ConnectomeLineage → WarCoffer → PredictionArena
//   3. 每单独立链上回读断言（不用子脚本自说自话，编排器二次读链核对黄金值）
//   4. 每单部署字节码 PUSH20 主权扫描（黑名单硬失败）
//   5. gas 台账 + 证据落盘 scripts/r3-run-log.json
// 用法: node scripts/r3-mainnet-deploy.mjs
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// ---- 黄金常量 ----
const FUNDED = "0x20c54D8Fa205af293181833b46494d97d54753f3"; // facilitator（用户已充值 5.05）
const ADMIN = "0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1"; // 用户主权收款钱包（无钥，只收不发）
const PRECOMPILE = "0x3600000000000000000000000000000000000000"; // Arc 原生 USDC (FiatTokenV2)
const ZERO32 = `0x${"00".repeat(32)}`;
const RPC_URL = "https://rpc.mainnet.arc.io";
const EXPLORER = "https://explorer.arc.io";

const BLACKLIST = {
  "0x3d900b8d1d48b46fc18a3f57dfd15a4a28bb454b": "上游 WarCoffer",
  "0x94d0c38bcc9957eaf8f318e6bbc6557f8cc3c815": "上游 NeuralReceiptRegistry",
  "0x3412eb909252adb983aaf793f97a3754ca029a37": "上游 NeuralManifestRegistry",
  "0x482b7a3bbef796c9627d86d5a23c67728a78096f": "上游 ConnectomeLineage",
  "0xaf1ae61e12c101d179a2f65a5f2e02e690968525": "上游 PredictionArena",
  "0x8faae5592b9acc27a79fca745c6b872adf514a5d": "上游 MURMUR 代币",
  "0x307d8a9333bd3e4fce93fffac6468eb7478423a0d": "上游项目部署者钱包",
  "0x168145bedf51773b639e83c6c8321eb91d969f22": "R2 测试网彩排 DEPLOYER",
};
const BLACKLIST_PREFIX = ["0x2b9a"]; // 上游 Worker facilitator（…055c，全文不可考）

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

const chain = {
  id: 5042,
  name: "Arc Mainnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const pc = createPublicClient({ chain, transport: http(RPC_URL) });

// ---- 断言引擎 ----
const evidence = { startedAt: new Date().toISOString(), network: "arc-mainnet-5042", facilitator: FUNDED, admin: ADMIN, units: {}, asserts: [], gas: {} };
let fails = 0;
function assert(cond, label, detail) {
  const line = `${cond ? "✓" : "✗"} ${label}${detail ? "  " + detail : ""}`;
  console.log("  " + line);
  evidence.asserts.push({ ok: !!cond, label, detail: detail || "" });
  if (!cond) fails++;
}
function hardFail(msg) {
  console.error(`\n✗✗ ${msg}`);
  fs.writeFileSync(path.join(root, "scripts", "r3-run-log.json"), JSON.stringify(evidence, null, 2));
  process.exit(1);
}

// ---- 预检 ----
console.log("════════ R3 预检 ════════");
const chainId = await pc.getChainId();
assert(chainId === 5042, `chainId=${chainId}`);

const env = readEnv(path.join(root, ".env.local"));
if (!env.ECONOMY_MNEMONIC) hardFail(".env.local 无 ECONOMY_MNEMONIC");
const facilitator = mnemonicToAccount(env.ECONOMY_MNEMONIC.trim(), { accountIndex: 2_000_000 }).address;
assert(facilitator.toLowerCase() === FUNDED.toLowerCase(), "种子派生(index 2M) == 充值地址", facilitator);

const bal0 = await pc.getBalance({ address: FUNDED });
console.log(`  facilitator 初始余额: ${(Number(bal0) / 1e18).toFixed(6)} USDC(native)`);
evidence.gas.balanceBefore = bal0.toString();
if (bal0 < 500_000_000_000_000_000n) hardFail("余额 < 0.5 USDC，不足以覆盖六单部署 gas");
assert(bal0 > 0n, "gas 余额就绪");

for (const a of [facilitator]) {
  assert(!BLACKLIST[a.toLowerCase()] && !BLACKLIST_PREFIX.some((p) => a.toLowerCase().startsWith(p)), "facilitator 黑名单零命中");
}

// ---- PUSH20 主权扫描（操作码级准确遍历，黑名单硬失败）----
const ourAddresses = new Set([FUNDED.toLowerCase(), ADMIN.toLowerCase(), PRECOMPILE.toLowerCase()]);
function scanPush20(codeHex, label) {
  const code = codeHex.replace(/^0x/i, "");
  let i = 0;
  const hits = [];
  while (i < code.length / 2) {
    const op = parseInt(code.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(op)) break;
    if (op === 0x73) {
      hits.push("0x" + code.slice(i * 2 + 2, i * 2 + 42));
      i += 21;
      continue;
    }
    i += op >= 0x60 && op <= 0x7f ? op - 0x5f + 1 : 1;
  }
  for (const a of hits) {
    const al = a.toLowerCase();
    if (BLACKLIST[al]) assert(false, `${label} PUSH20 命中黑名单：${BLACKLIST[al]}`, a);
  }
  const unknown = hits.filter((a) => !ourAddresses.has(a.toLowerCase()) && !BLACKLIST[a.toLowerCase()] && a !== "0x" + "00".repeat(20));
  return { total: hits.length, unknown };
}

function readArtifact(name) {
  return JSON.parse(fs.readFileSync(path.join(root, "contracts", "build", name + ".json"), "utf8"));
}
const artifactFile = { murmur: "MurmurToken", registry: "NeuralReceiptRegistry", manifest: "NeuralManifestRegistry", lineage: "ConnectomeLineage", war: "WarCoffer", arena: "PredictionArena" };
const addrFile = { murmur: "MURMUR_ADDRESS.txt", registry: "REGISTRY_ADDRESS.txt", manifest: "MANIFEST_REGISTRY_ADDRESS.txt", lineage: "LINEAGE_ADDRESS.txt", war: "WAR_ADDRESS.txt", arena: "ARENA_ADDRESS.txt" };

// 断点续跑：本编排器首次运行时 murmur/registry/manifest 已上链（记录在案），重跑时只验不重部署
const RESUME_TXS = {
  murmur: [{ kind: "deploy", hash: "0xdb4039523db7f1a6059336038e9f2e00ac18b9962929ca8cadcfe139e1d42880" }],
  registry: [{ kind: "deploy", hash: "0x52b49c93550d42afcd6d88f264eb4570bc0fef3bb2fbe773e7e85cd7f4805d2b" }],
  manifest: [
    { kind: "deploy", hash: "0x26dcbf8da78e72eb3422a5d27c5677e88d792438f357e9c909d4cf29af78c9a5" },
    { kind: "commit", hash: "0x34f54af5a16953bcd253eb553b3eb4bad04ade2526c36dc0bfbd584cf5e909c8" },
  ],
};

// ---- 逐单部署 ----
const balBeforeEach = {};
async function deployUnit(key, script, extraEnv, verifyFn) {
  console.log(`\n════════ 部署 ①→⑥ · ${key} ════════`);
  balBeforeEach[key] = (await pc.getBalance({ address: FUNDED })).toString();
  const addrPath = path.join(root, "contracts", addrFile[key]);

  // 断点续跑：既有地址文件 + 链上有代码 + 全部独立断言通过 → 只验不重部署
  const existing = fs.existsSync(addrPath) ? fs.readFileSync(addrPath, "utf8").trim() : "";
  if (/^0x[0-9a-fA-F]{40}$/.test(existing)) {
    const mark = { fails, asserts: evidence.asserts.length };
    evidence.units[key] = { address: existing, txs: RESUME_TXS[key] || [], resumed: true, gasBefore: balBeforeEach[key] }; // 先登记（verifyFn 可能追加字段）
    try {
      const abi = readArtifact(artifactFile[key]).abi;
      await verifyFn(existing, abi);
      const code = await pc.getCode({ address: existing });
      if (code && code !== "0x" && fails === mark.fails) {
        const scan = scanPush20(code, key);
        if (fails === mark.fails) {
          console.log(`  ⏭ ${key} 已上链且全部独立断言通过 —— 断点续跑：跳过重复部署`);
          ourAddresses.add(existing.toLowerCase());
          console.log(`  explorer: ${EXPLORER}/address/${existing}`);
          return existing;
        }
      }
      // 校验未过 → 回滚断言标记与登记，走全新部署
      fails = mark.fails;
      evidence.asserts.length = mark.asserts;
      delete evidence.units[key];
      console.log(`  ↻ ${key} 既有地址校验未过 —— 清除后全新部署`);
    } catch {
      fails = mark.fails;
      evidence.asserts.length = mark.asserts;
      delete evidence.units[key];
      console.log(`  ↻ ${key} 既有地址无法在当前链上验证（疑似陈旧/异链残留）—— 全新部署`);
    }
  }

  if (fs.existsSync(addrPath)) fs.unlinkSync(addrPath); // 清掉残留，杜绝陈旧地址混入

  const r = spawnSync("node", [path.join("scripts", script)], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CHAIN_ID: "5042", RPC_URL, ...extraEnv },
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) hardFail(`${key} 部署子脚本退出码 ${r.status} —— 停线排查（后续单未执行）`);

  const txs = [...r.stdout.matchAll(/(deploy|commit) tx: (0x[0-9a-fA-F]{64})/g)].map((m) => ({ kind: m[1], hash: m[2] }));
  const address = fs.readFileSync(addrPath, "utf8").trim();
  assert(/^0x[0-9a-fA-F]{40}$/.test(address), `${key} 地址已落盘`, address);
  ourAddresses.add(address.toLowerCase());
  evidence.units[key] = { address, txs, gasBefore: balBeforeEach[key] }; // 先登记，再验证（verifyFn 可追加字段）
  console.log(`  explorer: ${EXPLORER}/address/${address}`);
  for (const t of txs) console.log(`  ${t.kind} tx : ${EXPLORER}/tx/${t.hash}`);

  // 独立回读断言（编排器二次读链）
  const abi = readArtifact(artifactFile[key]).abi;
  try {
    await verifyFn(address, abi);
  } catch (e) {
    assert(false, `${key} 独立回读异常`, String(e).slice(0, 160));
  }

  // PUSH20 主权扫描
  const code = await pc.getCode({ address });
  const scan = scanPush20(code || "0x", key);
  assert(scan.total >= 0, `${key} PUSH20 扫描完成`, `立即数地址 ${scan.total} 个，非白名单 ${scan.unknown.length} 个（数据区候选不硬败，黑名单命中才硬败）`);

  return address;
}

// ① MurmurToken —— treasury=ADMIN（无钥），1B 一次性铸
const murmurAddr = await deployUnit("murmur", "deploy-murmur-auto.mjs", { MURMUR_CONFIRM: "1" }, async (address, abi) => {
  const symbol = await pc.readContract({ address, abi, functionName: "symbol" });
  const dec = await pc.readContract({ address, abi, functionName: "decimals" });
  const supply = await pc.readContract({ address, abi, functionName: "totalSupply" });
  const adminBal = await pc.readContract({ address, abi, functionName: "balanceOf", args: [ADMIN] });
  assert(symbol === "MURMUR" && dec === 18, "symbol=MURMUR decimals=18", `${symbol}/${dec}`);
  assert(supply === 10n ** 27n, "totalSupply = 1,000,000,000 MURMUR（一次性铸后固化）", supply.toString());
  assert(adminBal === supply, "treasury(ADMIN 0x1068…58B1) 持有全额供应", adminBal.toString());
});

// ② NeuralReceiptRegistry —— committer=facilitator
await deployUnit("registry", "deploy-registry-auto.mjs", { REGISTRY_CONFIRM: "1", REGISTRY_COMMITTER: facilitator }, async (address, abi) => {
  const committer = await pc.readContract({ address, abi, functionName: "committer" });
  const head = await pc.readContract({ address, abi, functionName: "chainHead" });
  assert(committer.toLowerCase() === facilitator.toLowerCase(), "committer == facilitator", committer);
  assert(head === ZERO32, "chainHead 为空（Worker 首次 commit 惰性播种）");
});

// ③ NeuralManifestRegistry —— committer=facilitator(=deployer)，含生产脑 manifest commit
await deployUnit("manifest", "deploy-manifest-auto.mjs", { MANIFEST_CONFIRM: "1" }, async (address, abi) => {
  const committer = await pc.readContract({ address, abi, functionName: "committer" });
  const latest = await pc.readContract({ address, abi, functionName: "latestHash" });
  const committed = latest === ZERO32 ? false : await pc.readContract({ address, abi, functionName: "isCommitted", args: [latest] });
  assert(committer.toLowerCase() === facilitator.toLowerCase(), "committer == facilitator", committer);
  assert(latest !== ZERO32, "latestHash 非空（生产脑已锚定）");
  assert(committed === true, "isCommitted(latestHash) = true");
  evidence.units.manifest.manifestHash = latest;
});

// ④ ConnectomeLineage —— committer=facilitator
await deployUnit("lineage", "deploy-lineage-auto.mjs", { LINEAGE_CONFIRM: "1", LINEAGE_COMMITTER: facilitator }, async (address, abi) => {
  const committer = await pc.readContract({ address, abi, functionName: "committer" });
  const count = await pc.readContract({ address, abi, functionName: "commitCount" });
  assert(committer.toLowerCase() === facilitator.toLowerCase(), "committer == facilitator", committer);
  assert(count === 0n, "commitCount = 0（全新）", count.toString());
});

// ⑤ WarCoffer —— usdc=原生 USDC precompile，resolver=facilitator，硬顶 50，grace 3 天
await deployUnit("war", "deploy-war-auto.mjs", { WAR_CONFIRM: "1", WAR_RESOLVER: facilitator }, async (address, abi) => {
  const usdc = await pc.readContract({ address, abi, functionName: "usdc" });
  const resolver = await pc.readContract({ address, abi, functionName: "resolver" });
  const cap = await pc.readContract({ address, abi, functionName: "maxEscrow" });
  const grace = await pc.readContract({ address, abi, functionName: "staleGrace" });
  const count = await pc.readContract({ address, abi, functionName: "warCount" });
  assert(usdc.toLowerCase() === PRECOMPILE.toLowerCase(), "usdc == Arc 原生 USDC precompile(0x3600…0000)", usdc);
  assert(resolver.toLowerCase() === facilitator.toLowerCase(), "resolver == facilitator", resolver);
  assert(cap === 50_000_000n, "maxEscrow = 50 USDC（immutable 硬顶）", cap.toString());
  assert(grace === 259_200n, "staleGrace = 3 天（生产参数）", grace.toString());
  assert(count === 0n, "warCount = 0（战库空仓启动）", count.toString());
});

// ⑥ PredictionArena —— token=本部署 MURMUR，resolver=facilitator
await deployUnit("arena", "deploy-arena-auto.mjs", { ARENA_CONFIRM: "1", ARENA_TOKEN: murmurAddr, ARENA_RESOLVER: facilitator }, async (address, abi) => {
  const token = await pc.readContract({ address, abi, functionName: "token" });
  const resolver = await pc.readContract({ address, abi, functionName: "resolver" });
  const grace = await pc.readContract({ address, abi, functionName: "staleGrace" });
  const count = await pc.readContract({ address, abi, functionName: "roundCount" });
  assert(token.toLowerCase() === murmurAddr.toLowerCase(), "token == 本部署 MurmurToken", token);
  assert(resolver.toLowerCase() === facilitator.toLowerCase(), "resolver == facilitator", resolver);
  assert(grace === 259_200n, "staleGrace = 3 天（生产参数）", grace.toString());
  assert(count === 0n, "roundCount = 0（全新）", count.toString());
});

// ---- gas 台账 + 收尾 ----
const bal1 = await pc.getBalance({ address: FUNDED });
evidence.gas.balanceAfter = bal1.toString();
evidence.gas.spent = (bal0 - bal1).toString();
evidence.finishedAt = new Date().toISOString();
evidence.ok = fails === 0;

console.log("\n════════ R3 部署总表 ════════");
for (const [k, u] of Object.entries(evidence.units)) {
  console.log(`  ${k.padEnd(9)} ${u.address}${u.txs.length ? "  tx " + u.txs.map((t) => t.hash.slice(0, 10) + "…").join(",") : ""}`);
}
console.log(`  gas 消耗 : ${(Number(evidence.gas.spent) / 1e18).toFixed(6)} USDC（余额 ${(Number(bal1) / 1e18).toFixed(6)} USDC 剩余）`);
console.log(`  断言     : ${evidence.asserts.filter((a) => a.ok).length}/${evidence.asserts.length} 通过`);

fs.writeFileSync(path.join(root, "scripts", "r3-run-log.json"), JSON.stringify(evidence, null, 2));
console.log(`\n${fails === 0 ? "🟢 R3 六合约主网部署全部通过。" : `🔴 ${fails} 项断言未过——详见 scripts/r3-run-log.json`}`);
process.exit(fails === 0 ? 0 : 2);
