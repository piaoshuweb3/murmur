// ============================================================================
// R2 — Arc 测试网全链路资金彩排（零真钱：测试网资产 + 彩排钥，手册 §R2 剧本复跑）
// Run:  RPC_URL=https://rpc.testnet.arc.io CHAIN_ID=5042002 node scripts/r2-rehearsal.mjs
// 需要: .env.local 内 R2_* 彩排钥（scripts/r2-keygen.mjs 生成）+ DEPLOYER 已领 faucet gas
// 与 R1（anvil fork）的差异——真实链无 cheat code：
//   - 无 setBalance / impersonate / increaseTime → gas 来自 faucet、时间用真实 sleep
//   - ADMIN 无钥红线加强版：生产 MurmurToken(treasury=ADMIN) 全程只收不发（测试网上根本没有 ADMIN 钥）
//   - 竞技场用 MurmurToken 彩排流通副本（treasury=BETTOR_A，仅测试网）驱动真实下注/派彩
//   - stale 退款路径用独立 mini 实例（grace=90s）在真实时间轴上演练
//   - usdc_ 参数默认 MockUSDC（手册 §R2）；另含原生 USDC precompile 写路径实测小节（R3 决策输入）
// 产出: scripts/r2-run-log.json（R2 资金流向审计报告的原始证据）
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { parseAbi, keccak256, stringToHex } from "viem";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";
import {
  pub, walletFor, RPC, CHAIN_ID, ADMIN,
  A, expectRevert, section, results,
  deploy, TRANSFER_TOPIC, AUTHUSED_TOPIC, collectTransfers, ledger,
  fmtU, fmtM, ROLES, role, roleOf, signEip3009, deriveWinner, scanPush20,
} from "./r1-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const art = (n) => path.join(root, "contracts", "build", n + ".json");

// ---- 彩排钥（.env.local，绝不打印私钥） ----
const envPath = path.join(root, ".env.local");
const env = Object.fromEntries(
  fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]) : [],
);
for (const k of ["R2_DEPLOYER_PK", "R2_MNEMONIC", "R2_BETTOR_A_PK", "R2_BETTOR_B_PK", "R2_OUTSIDER_PK"]) {
  if (!env[k]) { console.error(`缺少 ${k} —— 先跑 node scripts/r2-keygen.mjs`); process.exit(2); }
}
const DEPLOYER = privateKeyToAccount(env.R2_DEPLOYER_PK);
const RESOLVER = mnemonicToAccount(env.R2_MNEMONIC, { accountIndex: 2_000_000 });
const BETTOR_A = privateKeyToAccount(env.R2_BETTOR_A_PK);
const BETTOR_B = privateKeyToAccount(env.R2_BETTOR_B_PK);
const OUTSIDER = privateKeyToAccount(env.R2_OUTSIDER_PK);

const ARC_USDC = "0x3600000000000000000000000000000000000000"; // 原生 USDC precompile
const ZERO = "0x0000000000000000000000000000000000000000";

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const E3009 = parseAbi([
  "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "event AuthorizationUsed(address indexed from, address indexed to, uint256 value)",
]);

const bal = (token, who) => pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [who] });
const native = (who) => pub.getBalance({ address: who });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowTs = async () => Number((await pub.getBlock()).timestamp);
async function waitUntilTs(ts, label) {
  for (;;) {
    const now = await nowTs();
    const d = ts + 3 - now;
    if (d <= 0) return;
    console.log(`  …等待 ${label}（真实时间轴，再 ~${d}s）`);
    await sleep(Math.min(d, 20) * 1000);
  }
}
const jsonLog = { startedAt: new Date().toISOString(), chainId: CHAIN_ID, rpc: RPC, phase: "R2-testnet", deployments: {}, asserts: [], ledger: [], flows: {}, sovereignty: {}, nativeUsdcProbe: {} };

// ---- 剧本常量（生产对齐） ----
const MURMUR_SUPPLY = 1_000_000_000n * 10n ** 18n;
const MAX_ESCROW = 50n * 10n ** 6n;
const PROD_GRACE = 259_200n;            // 3 天（生产参数）
const MINI_GRACE = 90n;                 // stale 演练实例（测试网专属）
const HOUSE_A = 1001n, HOUSE_B = 1002n;
const SEED_RESOLVER = 55n * 10n ** 6n, SEED_A = 3n * 10n ** 6n, SEED_B = 2n * 10n ** 6n;
const CIRC_SEED_B = 20_000n * 10n ** 18n;

// ---- 角色注册（主权白名单） ----
role(ADMIN, "TREASURY=ADMIN(无钥,只收钱)");
role(DEPLOYER.address, "DEPLOYER(只付gas/注资)");
role(RESOLVER.address, "RESOLVER(facilitator,mnemonic派生idx2000000)");
role(BETTOR_A.address, "BETTOR_A");
role(BETTOR_B.address, "BETTOR_B");
role(OUTSIDER.address, "OUTSIDER(路人)");
role(ARC_USDC, "Arc原生USDC(precompile)");
role(ZERO, "零地址(仅铸币)");

// ============================================================================
section("ACT 0 · 预检（真实测试网 + gas 预算）");
// ============================================================================
const chainId = await pub.getChainId();
A(Number(chainId) === 5042002, "chainId=5042002（Arc testnet）", `got ${chainId}`);
const gasPrice = await pub.getGasPrice();
const perTx = 1_000_000n * gasPrice;
const need = 100n * perTx + 9_000_000n * gasPrice;
const depNat = await native(DEPLOYER.address);
console.log(`  gasPrice=${gasPrice} · 单笔上限≈${perTx} · 预算下限≈${need} · DEPLOYER 余额=${depNat}`);
if (depNat < need) {
  console.error(`\n■ NEED_MORE_GAS — DEPLOYER ${DEPLOYER.address} 余额不足。`);
  console.error(`  现有 ${depNat} / 需要 ≥ ${need}（参考显示：÷1e18=${Number(need) / 1e18} · ÷1e6=${Number(need) / 1e6}）`);
  console.error(`  → https://faucet.circle.com 领取 Arc testnet gas 后复跑本脚本（exit 2，零状态污染）`);
  process.exit(2);
}
const preBlock = await pub.getBlockNumber();
console.log(`  起始块 ${preBlock} · DEPLOYER=${DEPLOYER.address}`);
console.log(`  角色: RESOLVER=${RESOLVER.address} · A=${BETTOR_A.address} · B=${BETTOR_B.address} · OUTSIDER=${OUTSIDER.address}`);

// 真实链 gas 种子：全部由 DEPLOYER 分发（faucet 单点入口），负向 revert 交易同样要 gas
const dw = walletFor(DEPLOYER);
const GAS_SEED = 15n * perTx, GAS_OUTSIDER = 10n * perTx;
for (const [who, amt, tag] of [[RESOLVER.address, GAS_SEED, "RESOLVER"], [BETTOR_A.address, GAS_SEED, "BETTOR_A"], [BETTOR_B.address, GAS_SEED, "BETTOR_B"], [OUTSIDER.address, GAS_OUTSIDER, "OUTSIDER"]]) {
  const h = await dw.sendTransaction({ to: who, value: amt });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  gas seed ${tag}（≈${Number(amt / perTx)} 笔上限）`);
}

// ============================================================================
section("ACT 1 · 彩排资产 + 合约部署（生产参数 + stale mini 实例，依赖顺序）");
// ============================================================================
const dep = {};
const usdcMode = process.env.R2_USDC === "native" ? "native" : "mock";
let USD;
if (usdcMode === "mock") {
  dep.usdc = await deploy(dw, art("MockUSDC"), [], "MockUSDC(彩排资产·EIP-3009全兼容)");
  USD = dep.usdc.address;
  role(USD, "MockUSDC(彩排资产·绝不上主网)");
  for (const [to, amt, tag] of [[RESOLVER.address, SEED_RESOLVER, "RESOLVER=55"], [BETTOR_A.address, SEED_A, "A=3"], [BETTOR_B.address, SEED_B, "B=2"]]) {
    const h = await dw.writeContract({ address: USD, abi: dep.usdc.abi, functionName: "mint", args: [to, amt] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  mint ${tag} USDC(mock)`);
  }
  A((await bal(USD, RESOLVER.address)) === SEED_RESOLVER, "RESOLVER USDC(mock) 余额=55");
} else {
  USD = ARC_USDC;
  console.log("  native USDC 模式：跳过 MockUSDC，注资走 precompile 转账");
}
dep.murmurProd = await deploy(dw, art("MurmurToken"), [ADMIN, MURMUR_SUPPLY], "MurmurToken(生产·treasury=ADMIN)");
role(dep.murmurProd.address, "MurmurToken(生产·ADMIN)");
dep.murmurCirc = await deploy(dw, art("MurmurToken"), [BETTOR_A.address, MURMUR_SUPPLY], "MurmurToken(彩排流通副本·仅测试网)");
role(dep.murmurCirc.address, "MurmurToken(流通副本)");
dep.receipt = await deploy(dw, art("NeuralReceiptRegistry"), [RESOLVER.address], "NeuralReceiptRegistry");
role(dep.receipt.address, "NeuralReceiptRegistry(零资金)");
dep.manifest = await deploy(dw, art("NeuralManifestRegistry"), [RESOLVER.address], "NeuralManifestRegistry");
role(dep.manifest.address, "NeuralManifestRegistry(零资金)");
dep.lineage = await deploy(dw, art("ConnectomeLineage"), [RESOLVER.address], "ConnectomeLineage");
role(dep.lineage.address, "ConnectomeLineage(零资金)");
dep.coffer = await deploy(dw, art("WarCoffer"), [USD, RESOLVER.address, MAX_ESCROW, PROD_GRACE], "WarCoffer(生产参数)");
role(dep.coffer.address, "WarCoffer(战争托管)");
dep.cofferStale = await deploy(dw, art("WarCoffer"), [USD, RESOLVER.address, MAX_ESCROW, MINI_GRACE], "WarCoffer-stale(90s演练实例)");
role(dep.cofferStale.address, "WarCoffer-stale(演练)");
dep.arena = await deploy(dw, art("PredictionArena"), [dep.murmurCirc.address, RESOLVER.address, PROD_GRACE], "PredictionArena(生产参数)");
role(dep.arena.address, "PredictionArena(竞技场)");
dep.arenaStale = await deploy(dw, art("PredictionArena"), [dep.murmurCirc.address, RESOLVER.address, MINI_GRACE], "PredictionArena-stale(90s演练实例)");
role(dep.arenaStale.address, "PredictionArena-stale(演练)");
jsonLog.deployments = Object.fromEntries(Object.entries(dep).map(([k, v]) => [k, { address: v.address, txHash: v.txHash, gasUsed: String(v.gasUsed) }]));

// 部署即自验（R3 同款检查）
A((await pub.readContract({ address: dep.murmurProd.address, abi: dep.murmurProd.abi, functionName: "totalSupply" })) === MURMUR_SUPPLY, "MurmurToken(生产) totalSupply=10亿");
A((await bal(dep.murmurProd.address, ADMIN)) === MURMUR_SUPPLY, "MURMUR 生产实例全额铸给 ADMIN(=TREASURY)");
A((await pub.readContract({ address: dep.coffer.address, abi: dep.coffer.abi, functionName: "resolver" })) === RESOLVER.address, "WarCoffer.resolver=RESOLVER");
A((await pub.readContract({ address: dep.coffer.address, abi: dep.coffer.abi, functionName: "maxEscrow" })) === MAX_ESCROW, "WarCoffer.maxEscrow=50 USDC(immutable硬顶)");
A((await pub.readContract({ address: dep.coffer.address, abi: dep.coffer.abi, functionName: "staleGrace" })) === PROD_GRACE, "WarCoffer 生产实例 staleGrace=3天");
A((await pub.readContract({ address: dep.arena.address, abi: dep.arena.abi, functionName: "resolver" })) === RESOLVER.address, "PredictionArena.resolver=RESOLVER");
A(String(await pub.readContract({ address: dep.arena.address, abi: dep.arena.abi, functionName: "token" })).toLowerCase() === String(dep.murmurCirc.address).toLowerCase(), "PredictionArena.token=流通副本MURMUR");
A((await pub.readContract({ address: dep.lineage.address, abi: dep.lineage.abi, functionName: "committer" })) === RESOLVER.address, "ConnectomeLineage.committer=RESOLVER");

// ============================================================================
section("ACT 2 · MURMUR：生产实例零流出（ADMIN 无钥实证） + 流通副本发钞");
// ============================================================================
const privNames = ["mint", "pause", "blacklist", "owner", "upgrade", "setTreasury", "burnFrom"];
const abiNames = dep.murmurProd.abi.filter((e) => e.type === "function").map((f) => f.name.toLowerCase());
const bad = abiNames.filter((n) => privNames.some((p) => n.includes(p)));
A(bad.length === 0, "MurmurToken ABI 无任何特权函数（mint/pause/owner/upgrade…）", bad.join(",") || "clean");
await expectRevert(
  walletFor(OUTSIDER).writeContract({ address: dep.murmurProd.address, abi: ERC20, functionName: "transferFrom", args: [ADMIN, OUTSIDER.address, 1n] }),
  "路人无法动 ADMIN 余额（无签名无授权）", "allowance",
);
// 流通副本：A(=treasury) 发钞给 B —— 测试网上即真实签名（无 impersonation）
await walletFor(BETTOR_A).writeContract({ address: dep.murmurCirc.address, abi: ERC20, functionName: "transfer", args: [BETTOR_B.address, CIRC_SEED_B] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await bal(dep.murmurCirc.address, BETTOR_B.address)) === CIRC_SEED_B, "流通副本：BETTOR_A 真实签名发钞 20,000 MURMUR → B");

// ============================================================================
section("ACT 3 · 收据链 / 大脑清单 / 血统（零资金承诺账本）");
// ============================================================================
const rw = walletFor(RESOLVER);
const H0 = keccak256(stringToHex("murmur R2 receipt-genesis head"));
await rw.writeContract({ address: dep.receipt.address, abi: dep.receipt.abi, functionName: "seedGenesis", args: [H0] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const H1 = keccak256(stringToHex("murmur R2 receipt#42"));
await rw.writeContract({ address: dep.receipt.address, abi: dep.receipt.abi, functionName: "commit", args: [H1, H0, 42n, 24n, dep.receipt.txHash] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await pub.readContract({ address: dep.receipt.address, abi: dep.receipt.abi, functionName: "chainHead" })) === H1, "NeuralReceiptRegistry chainHead 前进至 H1");
await expectRevert(rw.writeContract({ address: dep.receipt.address, abi: dep.receipt.abi, functionName: "commit", args: [keccak256(stringToHex("bad")), keccak256(stringToHex("wrong-prev")), 43n, 1n, dep.receipt.txHash] }), "断链 commit 被拒（prevHead 不匹配）", "prev");
const MH = keccak256(stringToHex("murmur R2 brain-manifest"));
await rw.writeContract({ address: dep.manifest.address, abi: dep.manifest.abi, functionName: "commit", args: [MH, 1n, 24n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await pub.readContract({ address: dep.manifest.address, abi: dep.manifest.abi, functionName: "latestHash" })) === MH, "NeuralManifestRegistry latestHash 落链");
const G0 = keccak256(stringToHex("genome:genesis:R2")), G1 = keccak256(stringToHex("genome:mut:R2")), G2 = keccak256(stringToHex("genome:cross:R2"));
const lin = dep.lineage;
await rw.writeContract({ address: lin.address, abi: lin.abi, functionName: "commit", args: [G0, "0x" + "0".repeat(64), "0x" + "0".repeat(64), 0n, 0n, BETTOR_A.address] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await rw.writeContract({ address: lin.address, abi: lin.abi, functionName: "commit", args: [G1, G0, "0x" + "0".repeat(64), 1n, 1n, BETTOR_A.address] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await rw.writeContract({ address: lin.address, abi: lin.abi, functionName: "commit", args: [G2, G0, G1, 2n, 2n, BETTOR_B.address] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A(BigInt(await pub.readContract({ address: lin.address, abi: lin.abi, functionName: "childCount", args: [G0] })) === 2n, "血统祖先链可查：G0 有 2 子");
A((await pub.readContract({ address: lin.address, abi: lin.abi, functionName: "breederOf", args: [G0] })) === BETTOR_A.address, "G0 breeder=BETTOR_A（版税收款人从链上读出）");
await expectRevert(rw.writeContract({ address: lin.address, abi: lin.abi, functionName: "commit", args: [keccak256(stringToHex("x")), G0, "0x" + "0".repeat(64), 1n, 5n, BETTOR_A.address] }), "世代跳变被拒（BadGeneration）", "generation");

// ============================================================================
section("ACT 4 · 繁殖费/版税资金路径 —— x402 EIP-3009 结算 → TREASURY/breeder");
// ============================================================================
async function x402Settle(payer, payto, value, tag) {
  const ts = await nowTs();
  const { signature, from, to, value: v, validAfter, validBefore, nonce } =
    await signEip3009(payer, { asset: USD, to: payto, value, validBefore: ts + 3600 });
  const sig = signature.slice(2);
  const r = "0x" + sig.slice(0, 64), s = "0x" + sig.slice(64, 128), vBit = parseInt(sig.slice(128, 130), 16);
  const h = await rw.writeContract({ address: USD, abi: E3009, functionName: "transferWithAuthorization", args: [from, to, v, validAfter, validBefore, nonce, vBit, r, s] });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  ${tag}: ${roleOf(from)} → ${roleOf(to)} · ${fmtU(v)} USDC · EIP-3009 结算完成`);
}
const adminU0 = await bal(USD, ADMIN);
const aU0 = await bal(USD, BETTOR_A.address), bU0 = await bal(USD, BETTOR_B.address);
if (usdcMode === "mock") {
  await x402Settle(BETTOR_A, ADMIN, 10n ** 6n, "繁殖费(平台侧 EVOLUTION_TREASURY)");
  await x402Settle(BETTOR_B, await pub.readContract({ address: lin.address, abi: lin.abi, functionName: "breederOf", args: [G0] }), 5n * 10n ** 5n, "版税(创作者侧 breeder=G0)");
} else {
  await walletFor(BETTOR_A).writeContract({ address: USD, abi: ERC20, functionName: "approve", args: [RESOLVER.address, 10n ** 6n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
  await rw.writeContract({ address: USD, abi: ERC20, functionName: "transferFrom", args: [BETTOR_A.address, ADMIN, 10n ** 6n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
  await rw.writeContract({ address: USD, abi: ERC20, functionName: "transferFrom", args: [BETTOR_B.address, BETTOR_A.address, 5n * 10n ** 5n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
}
A((await bal(USD, ADMIN)) - adminU0 === 10n ** 6n, "繁殖费 1.000000 USDC 确切落 TREASURY(ADMIN)");
A((await bal(USD, BETTOR_A.address)) - aU0 === -(10n ** 6n) + 5n * 10n ** 5n, "版税 0.500000 USDC 确切落 breeder(G0)=BETTOR_A（净值：先付1.0费后收0.5）");
A((await bal(USD, lin.address)) === 0n && (await native(lin.address)) === 0n, "ConnectomeLineage 全程零资金（纯承诺账本）");

// ---- 原生 USDC precompile 写路径实测（R3 决策输入；非本彩排主线） ----
try {
  const natBal = await bal(ARC_USDC, DEPLOYER.address);
  console.log(`  原生 USDC precompile · DEPLOYER 余额=${natBal}`);
  if (natBal >= 2n * 10n ** 6n) {
    const aNat0 = await bal(ARC_USDC, BETTOR_A.address), admNat0 = await bal(ARC_USDC, ADMIN);
    await dw.writeContract({ address: ARC_USDC, abi: ERC20, functionName: "transfer", args: [BETTOR_A.address, 10n ** 6n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
    A((await bal(ARC_USDC, BETTOR_A.address)) - aNat0 === 10n ** 6n, "原生USDC写路径①：真实 transfer DEPLOYER→A 成功");
    const ts = await nowTs();
    const auth = await signEip3009(BETTOR_A, { asset: ARC_USDC, to: ADMIN, value: 3n * 10n ** 5n, validBefore: ts + 3600 });
    const sg = auth.signature.slice(2);
    await rw.writeContract({ address: ARC_USDC, abi: E3009, functionName: "transferWithAuthorization", args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, parseInt(sg.slice(128, 130), 16), "0x" + sg.slice(0, 64), "0x" + sg.slice(64, 128)] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
    A((await bal(ARC_USDC, ADMIN)) - admNat0 === 3n * 10n ** 5n, "原生USDC写路径②：EIP-3009 结算 0.3 USDC → ADMIN 成功");
    const natAuth = (await pub.getLogs({ address: ARC_USDC, fromBlock: preBlock, toBlock: await pub.getBlockNumber() })).filter((l) => (l.topics[0] || "").toLowerCase() === AUTHUSED_TOPIC.toLowerCase());
    jsonLog.nativeUsdcProbe = { writable: true, eip3009: true, authUsedEvents: natAuth.length };
    console.log(`  原生USDC AuthorizationUsed 事件数=${natAuth.length}（R3 直接指向 precompile 的可行性证据）`);
  } else {
    jsonLog.nativeUsdcProbe = { writable: null, note: "原生 USDC 余额不足，写路径实测留待 gas 到账后复跑" };
    console.log("  ⚠ 原生 USDC 余额不足，写路径实测跳过（不影响主线——主线用 MockUSDC）");
  }
} catch (e) {
  jsonLog.nativeUsdcProbe = { writable: false, error: String(e?.message || e).slice(0, 200) };
  console.log("  原生 USDC 写路径实测失败（记录，不阻断）:", String(e?.shortMessage || e?.message || e).slice(0, 140));
}

// ============================================================================
section("ACT 5-6 · 时间轴铺排：战争/竞技场全部开局（deadline 全部真实时间）");
// ============================================================================
const ts0 = await nowTs();
// 真实时间轴余量（R1 无此问题：anvil 可时间跳跃）：开局铺排 ~16 笔 tx，Arc 出块+RPC 往返 ≈3-5s/笔，
// deadline 阶梯必须覆盖全部开局 tx；结算段 waitUntilTs 会自然等到期，只多花墙钟时间、零风险
const WAR1_DL = BigInt(ts0 + 45), WAR_STALE_DL = BigInt(ts0 + 70), R1_DL = BigInt(ts0 + 90), R2_DL = BigInt(ts0 + 95), ASTALE_DL = BigInt(ts0 + 110);
// —— 战争（生产实例）——
const cf = dep.coffer;
await rw.writeContract({ address: USD, abi: ERC20, functionName: "approve", args: [cf.address, MAX_ESCROW] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const warConservation = async (label, coffer, openPot = 0n) => {
  const [v1, v2, purse, esc] = await Promise.all([
    pub.readContract({ address: coffer.address, abi: coffer.abi, functionName: "vault", args: [HOUSE_A] }),
    pub.readContract({ address: coffer.address, abi: coffer.abi, functionName: "vault", args: [HOUSE_B] }),
    pub.readContract({ address: coffer.address, abi: coffer.abi, functionName: "commonsPurse" }),
    pub.readContract({ address: coffer.address, abi: coffer.abi, functionName: "totalEscrow" }),
  ]);
  const usdcBal = await bal(USD, coffer.address);
  A(v1 + v2 + purse + openPot === esc, `守恒 ${label}`, `Σ金库+税袋+在战池=${fmtU(v1 + v2 + purse + openPot)} == escrow=${fmtU(esc)}`);
  A(usdcBal === esc, `托管实币==账面 ${label}`, `balance=${fmtU(usdcBal)}`);
  return { v1, v2, purse, esc };
};
for (const [house, amt] of [[HOUSE_A, 25n * 10n ** 6n], [HOUSE_B, 25n * 10n ** 6n]]) {
  await rw.writeContract({ address: cf.address, abi: cf.abi, functionName: "deposit", args: [house, amt] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
}
A((await bal(USD, cf.address)) === MAX_ESCROW, "WarCoffer 实收 50 USDC（==硬顶）", fmtU(await bal(USD, cf.address)));
await warConservation("·存入后", cf);
await expectRevert(rw.writeContract({ address: cf.address, abi: cf.abi, functionName: "deposit", args: [1003n, 10n ** 6n] }), "超硬顶 deposit 被拒（EscrowCap 50 USDC 不可突破）", "cap");
await rw.writeContract({ address: cf.address, abi: cf.abi, functionName: "declareWar", args: [1n, HOUSE_A, HOUSE_B, 5n * 10n ** 6n, 700n, 300n, WAR1_DL] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const wi = await pub.readContract({ address: cf.address, abi: cf.abi, functionName: "warInfo", args: [1n] });
A(wi[8] === 10n * 10n ** 6n, "declareWar 双方各 escrow 5 USDC（pot=10）", `pot=${fmtU(wi[8])}`);
A(wi[6] === 700n && wi[7] === 300n, "战力在 declare 时上链固化（resolve 时 resolver 无法干预）");
const ow = walletFor(OUTSIDER);
await expectRevert(ow.writeContract({ address: cf.address, abi: cf.abi, functionName: "declareWar", args: [99n, HOUSE_A, HOUSE_B, 1n, 1n, 1n, WAR1_DL] }), "非 resolver declareWar 被拒", "resolver");
await expectRevert(rw.writeContract({ address: cf.address, abi: cf.abi, functionName: "declareWar", args: [98n, HOUSE_A, HOUSE_A, 1n, 1n, 1n, WAR1_DL] }), "attacker==defender 被拒", "war");
// —— 战争 stale 演练实例（1+1 存入，stake 0.5/0.5，grace 90s）——
const cfs = dep.cofferStale;
await rw.writeContract({ address: USD, abi: ERC20, functionName: "approve", args: [cfs.address, 2n * 10n ** 6n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
for (const house of [HOUSE_A, HOUSE_B]) await rw.writeContract({ address: cfs.address, abi: cfs.abi, functionName: "deposit", args: [house, 10n ** 6n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const preStale = await warConservation("·stale实例存入后", cfs);
await rw.writeContract({ address: cfs.address, abi: cfs.abi, functionName: "declareWar", args: [1n, HOUSE_B, HOUSE_A, 5n * 10n ** 5n, 500n, 500n, WAR_STALE_DL] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
// —— 竞技场 Round#1 / Round#2 / stale 实例（流通 MURMUR）——
const ar = dep.arena, mw = walletFor(BETTOR_A), bw = walletFor(BETTOR_B);
const arenaM = (a = ar) => bal(dep.murmurCirc.address, a.address); // 托管=流通副本 MURMUR 余额（token=副本合约, who=arena）
await mw.writeContract({ address: dep.murmurCirc.address, abi: ERC20, functionName: "approve", args: [ar.address, 14_000n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await bw.writeContract({ address: dep.murmurCirc.address, abi: ERC20, functionName: "approve", args: [ar.address, 8_000n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await rw.writeContract({ address: ar.address, abi: ar.abi, functionName: "openRound", args: [1n, 500_000n, 8_000n, R1_DL] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "bet", args: [1n, 1n, 12_000n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await bw.writeContract({ address: ar.address, abi: ar.abi, functionName: "bet", args: [1n, 2n, 8_000n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const r1 = await pub.readContract({ address: ar.address, abi: ar.abi, functionName: "roundInfo", args: [1n] });
A(r1[9] === 12_000n * 10n ** 18n && r1[10] === 8_000n * 10n ** 18n, "Round#1 池账正确", `up=${fmtM(r1[9])} down=${fmtM(r1[10])}`);
A((await arenaM()) === 20_000n * 10n ** 18n, "竞技场托管=全部下注（20,000 MURMUR）", fmtM(await arenaM()));
await expectRevert(bw.writeContract({ address: ar.address, abi: ar.abi, functionName: "bet", args: [1n, 1n, 10n ** 18n] }), "同轮反向押注被拒（SideTaken）", "side");
await expectRevert(mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "bet", args: [1n, 1n, 0n] }), "零注被拒", "zero");
// Round#2（FLAT）
await rw.writeContract({ address: ar.address, abi: ar.abi, functionName: "openRound", args: [2n, 500_000n, 8_000n, R2_DL] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await expectRevert(rw.writeContract({ address: ar.address, abi: ar.abi, functionName: "resolve", args: [2n, 500_000n] }), "注期内 resolve 被拒（BettingClosed）", "closed");
await mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "bet", args: [2n, 1n, 1_000n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
// stale 演练实例
const ars = dep.arenaStale;
await mw.writeContract({ address: dep.murmurCirc.address, abi: ERC20, functionName: "approve", args: [ars.address, 500n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await rw.writeContract({ address: ars.address, abi: ars.abi, functionName: "openRound", args: [1n, 500_000n, 8_000n, ASTALE_DL] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await mw.writeContract({ address: ars.address, abi: ars.abi, functionName: "bet", args: [1n, 1n, 500n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
console.log("  全部开局完成 —— 进入真实时间轴结算（deadline 依次到期）");

// ============================================================================
section("ACT 5b · WarCoffer：resolve→levy→sweep（deadline 后）+ stale 退款");
// ============================================================================
await waitUntilTs(Number(WAR1_DL), "War#1 deadline");
const exp = deriveWinner(1n, HOUSE_A, HOUSE_B, 700n, 300n);
await rw.writeContract({ address: cf.address, abi: cf.abi, functionName: "resolveWar", args: [1n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const pv = await pub.readContract({ address: cf.address, abi: cf.abi, functionName: "previewWinner", args: [1n] });
A(pv[1] === exp.roll && Number(pv[0]) === exp.winner, "确定性胜者本地重算==合约裁定（trustless 可复算）", `roll=${exp.roll} winner=${exp.winner == 1 ? "ATTACKER" : "DEFENDER"}`);
const { v1: v1r, v2: v2r } = await warConservation("·resolve后", cf, 0n);
A((exp.winner === 1 ? v1r - v2r : v2r - v1r) === 10n * 10n ** 6n, "胜者金库恰好多 10 USDC（净赢一个 stake）", `A=${fmtU(v1r)} B=${fmtU(v2r)}`);
await rw.writeContract({ address: cf.address, abi: cf.abi, functionName: "levyTax", args: [HOUSE_A, 10n ** 6n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const purse1 = await pub.readContract({ address: cf.address, abi: cf.abi, functionName: "commonsPurse" });
A(purse1 === 10n ** 6n, "levyTax 1 USDC 入 commonsPurse", fmtU(purse1));
await warConservation("·levy后", cf, 0n);
await expectRevert(ow.writeContract({ address: cf.address, abi: cf.abi, functionName: "sweepTo", args: [HOUSE_A] }), "非 resolver sweepTo 被拒", "resolver");
await rw.writeContract({ address: cf.address, abi: cf.abi, functionName: "sweepTo", args: [HOUSE_A] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await pub.readContract({ address: cf.address, abi: cf.abi, functionName: "commonsPurse" })) === 0n, "sweep 后 purse 归零（税留在自主金库体系内）");
await warConservation("·sweep后", cf, 0n);
// stale 演练：deadline + grace 90s 后任何人可解锁
await waitUntilTs(Number(WAR_STALE_DL) + Number(MINI_GRACE) + 4, "War-stale 到期(grace 90s)");
await ow.writeContract({ address: cfs.address, abi: cfs.abi, functionName: "expireStaleWar", args: [1n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const postStale = await warConservation("·stale退款后", cfs, 0n);
A(postStale.v1 === preStale.v1 && postStale.v2 === preStale.v2, "stale 战双方全额退款=各自拿回本方 stake（无 resolver 也能解锁托管）", `A=${fmtU(postStale.v1)} B=${fmtU(postStale.v2)}`);
A((await bal(USD, cf.address)) === MAX_ESCROW, "生产实例全程托管实币 50 未变（只有存入、无外部流出）", fmtU(await bal(USD, cf.address)));

// ============================================================================
section("ACT 6b · PredictionArena：resolve→claim + FLAT 退款 + stale 退款");
// ============================================================================
await waitUntilTs(Number(R1_DL), "Round#1 deadline");
await rw.writeContract({ address: ar.address, abi: ar.abi, functionName: "resolve", args: [1n, 550_000n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const r1s = await pub.readContract({ address: ar.address, abi: ar.abi, functionName: "roundInfo", args: [1n] });
A(Number(r1s[2]) === 1, "Round#1 判定 UP（delta=+0.05 > band 0.008）", `outcome=${r1s[2]}`);
const pfA = await pub.readContract({ address: ar.address, abi: ar.abi, functionName: "payoutFor", args: [1n, BETTOR_A.address] });
A(pfA[1] === 20_000n * 10n ** 18n, "UP 赢家派彩=12k+全额败池=20,000（零抽水）", fmtM(pfA[1]));
const admCirc0 = await bal(dep.murmurCirc.address, ADMIN), resCirc0 = await bal(dep.murmurCirc.address, RESOLVER.address);
await mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "claim", args: [1n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await bw.writeContract({ address: ar.address, abi: ar.abi, functionName: "claim", args: [1n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await arenaM()) === 1_000n * 10n ** 18n, "Round#1 结清后托管=Round#2 在注 1,000（20000进→20000出+在注，派彩零泄漏）", fmtM(await arenaM()));
A((await bal(dep.murmurCirc.address, ADMIN)) === admCirc0 && (await bal(dep.murmurCirc.address, RESOLVER.address)) === resCirc0, "平价零和：resolver/ADMIN 未从竞技场拿走一分钱");
await waitUntilTs(Number(R2_DL), "Round#2 deadline");
const aM2 = await bal(dep.murmurCirc.address, BETTOR_A.address);
await rw.writeContract({ address: ar.address, abi: ar.abi, functionName: "resolve", args: [2n, 502_000n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "claim", args: [2n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await bal(dep.murmurCirc.address, BETTOR_A.address)) - aM2 === 1_000n * 10n ** 18n, "FLAT 轮全额退款 1,000 MURMUR", fmtM(1_000n * 10n ** 18n));
await waitUntilTs(Number(ASTALE_DL) + Number(MINI_GRACE) + 4, "Arena-stale 到期(grace 90s)");
await ow.writeContract({ address: ars.address, abi: ars.abi, functionName: "expireStale", args: [1n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const aM3 = await bal(dep.murmurCirc.address, BETTOR_A.address);
await mw.writeContract({ address: ars.address, abi: ars.abi, functionName: "claim", args: [1n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await bal(dep.murmurCirc.address, BETTOR_A.address)) - aM3 === 500n * 10n ** 18n, "stale 轮全额退款 500 MURMUR（任何人可解锁）");
A((await arenaM()) === 0n && (await arenaM(ars)) === 0n, "竞技场最终托管归零（生产+stale 实例，用户资金无沉淀）");
const aCircEnd = await bal(dep.murmurCirc.address, BETTOR_A.address), bCircEnd = await bal(dep.murmurCirc.address, BETTOR_B.address);
A(aCircEnd + bCircEnd === MURMUR_SUPPLY, "流通 MURMUR 总量守恒（A+B=10亿，托管零沉淀）", `A=${fmtM(aCircEnd)} B=${fmtM(bCircEnd)}`);

// ============================================================================
section("ACT 7 · 全链账本回放 + 主权断言（第四方扫描）");
// ============================================================================
const endBlock = await pub.getBlockNumber();
const tokenList = usdcMode === "mock" ? [[USD, "USDC(mock)"], [dep.murmurProd.address, "MURMUR(prod)"], [dep.murmurCirc.address, "MURMUR(circ)"]] : [[ARC_USDC, "USDC(native)"], [dep.murmurProd.address, "MURMUR(prod)"], [dep.murmurCirc.address, "MURMUR(circ)"]];
for (const [addr, name] of tokenList) {
  const ls = await pub.getLogs({ address: addr, topics: [TRANSFER_TOPIC], fromBlock: preBlock, toBlock: endBlock });
  collectTransfers(ls, name);
}
const authLogs = (await pub.getLogs({ address: USD, fromBlock: preBlock, toBlock: endBlock }))
  .filter((l) => (l.topics[0] || "").toLowerCase() === AUTHUSED_TOPIC.toLowerCase());
if (usdcMode === "mock") A(authLogs.length === 2, "EIP-3009 AuthorizationUsed 事件落链（自持协议结算痕迹）", `count=${authLogs.length}（客户端按 topic0 复核）`);

let violations = [];
const known = new Set([ADMIN.toLowerCase(), DEPLOYER.address.toLowerCase(), RESOLVER.address.toLowerCase(), BETTOR_A.address.toLowerCase(), BETTOR_B.address.toLowerCase(), OUTSIDER.address.toLowerCase(), USD.toLowerCase(), ZERO,
  ...Object.values(dep).map((d) => d.address.toLowerCase())]);
const rows = ledger.map((r) => ({ ...r, fromRole: roleOf(r.from), toRole: roleOf(r.to), usdc: r.token.startsWith("USDC") ? fmtU(r.value) : fmtM(r.value) }));
for (const r of rows) {
  if (!known.has(r.from.toLowerCase())) violations.push({ ...r, why: "unknown FROM" });
  if (!known.has(r.to.toLowerCase())) violations.push({ ...r, why: "unknown TO(第四方)" });
}
A(violations.length === 0, "全链账本：不存在任何第四方收付款地址", violations.length ? JSON.stringify(violations.slice(0, 3)) : `${rows.length} 笔转账全部白名单`);
const adminOut = rows.filter((r) => r.from.toLowerCase() === ADMIN.toLowerCase());
A(adminOut.length === 0, "ADMIN 全程零流出（测试网上根本没有 ADMIN 钥——无钥主权的最强证明）", `${adminOut.length} 笔流出`);
const cofferOuts = rows.filter((r) => [dep.coffer.address.toLowerCase(), dep.cofferStale.address.toLowerCase()].includes(r.from.toLowerCase()));
A(cofferOuts.length === 0, "WarCoffer（生产+stale）托管零流出（存入后无任何 USDC 离开战库）", `${cofferOuts.length} 笔流出`);
const arenaOuts = rows.filter((r) => [dep.arena.address.toLowerCase(), dep.arenaStale.address.toLowerCase()].includes(r.from.toLowerCase()));
A(arenaOuts.every((r) => [BETTOR_A.address.toLowerCase(), BETTOR_B.address.toLowerCase()].includes(r.to.toLowerCase())), "竞技场付款对象 100% 是下注者本人", `${arenaOuts.length} 笔派出`);
const adminIn = rows.filter((r) => r.to.toLowerCase() === ADMIN.toLowerCase());
A(adminIn.length >= 2, "TREASURY(ADMIN) 收款路径存在（铸币+繁殖费）", adminIn.map((r) => `${r.token}:${r.usdc}`).join(" · "));
A(!rows.some((r) => r.to.toLowerCase() === OUTSIDER.address.toLowerCase()), "路人零收款（负向验证）");
// mock 模式总量守恒：Σ参与者 + Σ托管 == 总铸币
if (usdcMode === "mock") {
  const sum = (await Promise.all([RESOLVER.address, BETTOR_A.address, BETTOR_B.address, ADMIN, dep.coffer.address, dep.cofferStale.address].map((w) => bal(USD, w)))).reduce((a, b) => a + b, 0n);
  A(sum === SEED_RESOLVER + SEED_A + SEED_B, "USDC(mock) 总量守恒：Σ参与者+Σ托管==总铸币 60.000000", `${fmtU(sum)}/${fmtU(SEED_RESOLVER + SEED_A + SEED_B)}`);
}
// 部署字节码主权扫描
const allowedPush = new Set([USD.toLowerCase(), RESOLVER.address.toLowerCase(), dep.murmurProd.address.toLowerCase(), dep.murmurCirc.address.toLowerCase()]);
const pushReport = {}; let pushBad = [];
for (const [k, v] of Object.entries(dep)) {
  const cts = await scanPush20(v.address);
  pushReport[k] = cts;
  for (const c of cts) {
    if (allowedPush.has(c.toLowerCase())) continue;
    const cc = await pub.getCode({ address: c });
    if (cc && cc !== "0x") pushBad.push({ contract: k, addr: c, note: "非白名单且链上存在代码（疑似外部地址嵌入）" });
  }
}
A(pushBad.length === 0, "全合约字节码 PUSH20 走查：零未知/零上游地址嵌入", pushBad.length ? JSON.stringify(pushBad) : `候选 ${Object.values(pushReport).flat().length} 个，全部 ∈ 白名单或无链上代码的随机数据`);

// ============================================================================
section("收尾 · 汇总");
// ============================================================================
const pass = results.filter((r) => r.ok).length, fail = results.filter((r) => !r.ok).length;
console.log(`\n■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■`);
console.log(`■ R2 彩排完成：断言 ${pass} 通过 / ${fail} 失败 · 转账流水 ${rows.length} 笔 · 块 ${preBlock} → ${endBlock} · USDC模式=${usdcMode}`);
console.log(`■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■`);
jsonLog.finishedAt = new Date().toISOString();
jsonLog.preBlock = Number(preBlock); jsonLog.endBlock = Number(endBlock);
jsonLog.usdcMode = usdcMode; jsonLog.gasPrice = String(gasPrice);
jsonLog.actors = { DEPLOYER: DEPLOYER.address, RESOLVER: RESOLVER.address, BETTOR_A: BETTOR_A.address, BETTOR_B: BETTOR_B.address, OUTSIDER: OUTSIDER.address, TREASURY_ADMIN: ADMIN };
jsonLog.asserts = results; jsonLog.ledger = rows;
jsonLog.flows = {
  adminReceipts: adminIn.map((r) => ({ token: r.token, value: r.usdc, from: r.fromRole })),
  cofferOutflows: cofferOuts.length,
  arenaPayouts: arenaOuts.map((r) => ({ to: r.toRole, value: r.usdc })),
  violations, pushScan: pushReport,
};
jsonLog.roles = Object.fromEntries([...ROLES.entries()].map(([a, r]) => [a, r]));
fs.writeFileSync(path.join(root, "scripts", "r2-run-log.json"), JSON.stringify(jsonLog, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(`运行日志: ${path.join(root, "scripts", "r2-run-log.json")}`);
process.exit(fail ? 1 : 0);
