// ============================================================================
// R1 — 本地 fork 全链路资金彩排（零真钱零风险）
// Run:  node scripts/r1-rehearsal.mjs
// 需要: anvil --fork-url https://rpc.mainnet.arc.io --port 8545 --chain-id 31337
// 产出: scripts/r1-run-log.json + 控制台断言流水（资金流向审计报告的原始证据）
// 红线: 所有资金接收方 ∈ {TREASURY(ADMIN), RESOLVER, 胜者金库(WarCoffer 内部), 下注者}
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { parseAbi, keccak256, stringToHex, toHex } from "viem";
import {
  pub, walletFor, chain, CHAIN_ID, RPC,
  DEPLOYER, RESOLVER, BETTOR_A, BETTOR_B, OUTSIDER, ADMIN, USDC as ARC_USDC,
  A, expectRevert, section, results,
  setBalance, impersonate, stopImpersonate, increaseTime, nowTs,
  deploy, TRANSFER_TOPIC, AUTHUSED_TOPIC, collectTransfers, ledger,
  fmtU, fmtM, ROLES, role, roleOf, signEip3009, deriveWinner, scanPush20, fundViaSlot,
} from "./r1-lib.mjs";

const root = path.resolve(import.meta.dirname, "..");
const art = (n) => path.join(root, "contracts", "build", n + ".json");

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
const E3009 = parseAbi([
  "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "event AuthorizationUsed(address indexed from, address indexed to, uint256 value)",
]);

const bal = (token, who) => pub.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [who] });
const native = (who) => pub.getBalance({ address: who });
const jsonLog = { startedAt: new Date().toISOString(), chainId: CHAIN_ID, rpc: RPC, fork: {}, deployments: {}, asserts: [], ledger: [], flows: {}, sovereignty: {} };

// ---------- 剧本常量（生产对齐） ----------
const MURMUR_SUPPLY = 1_000_000_000n * 10n ** 18n;         // 10 亿枚，一次性铸给 ADMIN
const MAX_ESCROW = 50n * 10n ** 6n;                          // 战库托管硬顶 50 USDC
const STALE_GRACE = 259200n;                                 // 3 天
const HOUSE_A = 1001n, HOUSE_B = 1002n;

// 角色注册（主权白名单）
role(ADMIN, "TREASURY=ADMIN(无钥,只收钱)");
role(RESOLVER.address, "RESOLVER(facilitator,mnemonic派生idx2000000)");
role(BETTOR_A.address, "BETTOR_A");
role(BETTOR_B.address, "BETTOR_B");
role(OUTSIDER.address, "OUTSIDER(路人)");
role(ARC_USDC, "Arc-USDC(precompile·fork只读)");
role("0x0000000000000000000000000000000000000000", "零地址(仅铸币)");

// ============================================================================
section("ACT 0 · 预检（fork 环境与 Arc USDC precompile 现状）");
// ============================================================================
const forkBlock = await pub.getBlockNumber();
const forkTs = (await pub.getBlock()).timestamp;
jsonLog.fork = { forkBlock: Number(forkBlock), forkTs: Number(forkTs), chainId: (await pub.getChainId()) };
console.log(`  fork @ block ${forkBlock} · chainId ${jsonLog.fork.chainId} · ts ${forkTs}`);

const [usdcName, usdcSym, usdcDec] = await Promise.all([
  pub.readContract({ address: ARC_USDC, abi: ERC20, functionName: "name" }),
  pub.readContract({ address: ARC_USDC, abi: ERC20, functionName: "symbol" }),
  pub.readContract({ address: ARC_USDC, abi: ERC20, functionName: "decimals" }),
]);
A(usdcSym === "USDC" && BigInt(usdcDec) === 6n, "Arc USDC precompile 可读（name/symbol/decimals）", `${usdcName}/${usdcSym}/${usdcDec}`);
console.log("  ⚠ 实测结论：Arc USDC precompile 在 anvil fork 上写入被节点原生层阻断（eth_call transfer 即 revert）");
console.log("    → 资金路径彩排切换自写 MockUSDC（EIP-3009 全兼容，与手册 R2 测试网方案一致），详见审计报告");

// fork 预备 gas 种子
const gasSeed = 10n ** 19n;
await setBalance(RESOLVER.address, gasSeed);

// ============================================================================
section("ACT 1 · 彩排资产 + 六合约部署（生产参数，依赖顺序）");
// ============================================================================
const dep = {};
const dw = walletFor(DEPLOYER);
dep.usdc = await deploy(dw, art("MockUSDC"), [], "MockUSDC(彩排资产·EIP-3009全兼容)");
const USD = dep.usdc.address;
role(USD, "MockUSDC(彩排资产·绝不上主网)");
// 注资：mint 水龙头（零真钱）：RESOLVER 500（战争托管方）、A/B 各 2（繁殖费/版税付款人）
for (const [to, amt, tag] of [[RESOLVER.address, 500n * 10n ** 6n, "RESOLVER=500"], [BETTOR_A.address, 2n * 10n ** 6n, "A=2"], [BETTOR_B.address, 2n * 10n ** 6n, "B=2"]]) {
  const h = await dw.writeContract({ address: USD, abi: dep.usdc.abi, functionName: "mint", args: [to, amt] });
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  mint ${tag} USDC(mock)`);
}
A((await bal(USD, RESOLVER.address)) === 500n * 10n ** 6n, "RESOLVER USDC(mock) 余额=500");

dep.murmur = await deploy(dw, art("MurmurToken"), [ADMIN, MURMUR_SUPPLY], "MurmurToken");
role(dep.murmur.address, "MurmurToken(自发行)");
dep.receipt = await deploy(dw, art("NeuralReceiptRegistry"), [RESOLVER.address], "NeuralReceiptRegistry");
role(dep.receipt.address, "NeuralReceiptRegistry(零资金)");
dep.manifest = await deploy(dw, art("NeuralManifestRegistry"), [RESOLVER.address], "NeuralManifestRegistry");
role(dep.manifest.address, "NeuralManifestRegistry(零资金)");
dep.lineage = await deploy(dw, art("ConnectomeLineage"), [RESOLVER.address], "ConnectomeLineage");
role(dep.lineage.address, "ConnectomeLineage(零资金)");
dep.coffer = await deploy(dw, art("WarCoffer"), [USD, RESOLVER.address, MAX_ESCROW, STALE_GRACE], "WarCoffer");
role(dep.coffer.address, "WarCoffer(战争托管)");
dep.arena = await deploy(dw, art("PredictionArena"), [dep.murmur.address, RESOLVER.address, STALE_GRACE], "PredictionArena");
role(dep.arena.address, "PredictionArena(竞技场托管)");
jsonLog.deployments = Object.fromEntries(Object.entries(dep).map(([k, v]) => [k, { address: v.address, txHash: v.txHash, gasUsed: String(v.gasUsed) }]));

// 部署即自验（R3 同款检查）
A((await pub.readContract({ address: dep.murmur.address, abi: dep.murmur.abi, functionName: "totalSupply" })) === MURMUR_SUPPLY, "MurmurToken totalSupply=10亿");
A((await pub.readContract({ address: dep.coffer.address, abi: dep.coffer.abi, functionName: "resolver" })) === RESOLVER.address, "WarCoffer.resolver=RESOLVER");
A((await pub.readContract({ address: dep.coffer.address, abi: dep.coffer.abi, functionName: "maxEscrow" })) === MAX_ESCROW, "WarCoffer.maxEscrow=50 USDC(硬顶)");
A((await pub.readContract({ address: dep.arena.address, abi: dep.arena.abi, functionName: "resolver" })) === RESOLVER.address, "PredictionArena.resolver=RESOLVER");
const arenaToken = await pub.readContract({ address: dep.arena.address, abi: dep.arena.abi, functionName: "token" });
A(String(arenaToken).toLowerCase() === String(dep.murmur.address).toLowerCase(), "PredictionArena.token=MurmurToken", `${arenaToken}`);
A((await pub.readContract({ address: dep.lineage.address, abi: dep.lineage.abi, functionName: "committer" })) === RESOLVER.address, "ConnectomeLineage.committer=RESOLVER");

// ============================================================================
section("ACT 2 · MurmurToken：一次性铸币 + 唯一特权=构造 + ADMIN 发钞");
// ============================================================================
const admM0 = await bal(dep.murmur.address, ADMIN);
A(admM0 === MURMUR_SUPPLY, "ADMIN(=TREASURY) 余额=全部供应", fmtM(admM0));
// ABI 特权面扫描：不得存在 mint/pause/blacklist/owner/upgrade 类函数
const privNames = ["mint", "pause", "blacklist", "owner", "upgrade", "setTreasury", "burnFrom"];
const abiNames = dep.murmur.abi.filter((e) => e.type === "function").map((f) => f.name.toLowerCase());
const bad = abiNames.filter((n) => privNames.some((p) => n.includes(p)));
A(bad.length === 0, "MurmurToken ABI 无任何特权函数（mint/pause/owner/upgrade…）", bad.join(",") || "clean");

// 负向：路人试图动 ADMIN 的钱（allowance=0）→ 必须 revert
await expectRevert(
  walletFor(OUTSIDER).writeContract({ address: dep.murmur.address, abi: ERC20, functionName: "transferFrom", args: [ADMIN, OUTSIDER.address, 1n] }),
  "路人无法动 ADMIN 余额（无签名无授权）", "allowance",
);

// ADMIN 发钞（fork 上用 impersonation 模拟签名——主网等价=必须 ADMIN 本人私钥）
const SEED_A = 90_000n * 10n ** 18n, SEED_B = 20_000n * 10n ** 18n;
await impersonate(ADMIN);
await setBalance(ADMIN, gasSeed); // impersonation 不含 gas——fork 预备
const adminW = walletFor(ADMIN);
for (const [who, amt, tag] of [[BETTOR_A.address, SEED_A, "A"], [BETTOR_B.address, SEED_B, "B"]]) {
  const h = await adminW.writeContract({ address: dep.murmur.address, abi: ERC20, functionName: "transfer", args: [who, amt] });
  await pub.waitForTransactionReceipt({ hash: h });
}
await stopImpersonate(ADMIN);
A((await bal(dep.murmur.address, BETTOR_A.address)) === SEED_A, "BETTOR_A 收到 MURMUR 发钞", fmtM(SEED_A));
A((await bal(dep.murmur.address, BETTOR_B.address)) === SEED_B, "BETTOR_B 收到 MURMUR 发钞", fmtM(SEED_B));

// ============================================================================
section("ACT 3 · 收据链 / 大脑清单 / 血统（零资金承诺账本）");
// ============================================================================
const rw = walletFor(RESOLVER);
// 收据链：seedGenesis → commit → head 前进
const H0 = keccak256(stringToHex("murmur R1 receipt-genesis head"));
await rw.writeContract({ address: dep.receipt.address, abi: dep.receipt.abi, functionName: "seedGenesis", args: [H0] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const H1 = keccak256(stringToHex("murmur R1 receipt#42"));
await rw.writeContract({ address: dep.receipt.address, abi: dep.receipt.abi, functionName: "commit", args: [H1, H0, 42n, 24n, dep.receipt.txHash] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await pub.readContract({ address: dep.receipt.address, abi: dep.receipt.abi, functionName: "chainHead" })) === H1, "NeuralReceiptRegistry chainHead 前进至 H1");
await expectRevert(rw.writeContract({ address: dep.receipt.address, abi: dep.receipt.abi, functionName: "commit", args: [keccak256(stringToHex("bad")), keccak256(stringToHex("wrong-prev")), 43n, 1n, dep.receipt.txHash] }), "断链 commit 被拒（prevHead 不匹配）", "prev");
// 大脑清单
const MH = keccak256(stringToHex("murmur R1 brain-manifest"));
await rw.writeContract({ address: dep.manifest.address, abi: dep.manifest.abi, functionName: "commit", args: [MH, 1n, 24n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await pub.readContract({ address: dep.manifest.address, abi: dep.manifest.abi, functionName: "latestHash" })) === MH, "NeuralManifestRegistry latestHash 落链");
// 血统：genesis → mutate → cross
const G0 = keccak256(stringToHex("genome:genesis:R1")), G1 = keccak256(stringToHex("genome:mut:R1")), G2 = keccak256(stringToHex("genome:cross:R1"));
const lin = dep.lineage;
await rw.writeContract({ address: lin.address, abi: lin.abi, functionName: "commit", args: [G0, "0x" + "0".repeat(64), "0x" + "0".repeat(64), 0n, 0n, BETTOR_A.address] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await rw.writeContract({ address: lin.address, abi: lin.abi, functionName: "commit", args: [G1, G0, "0x" + "0".repeat(64), 1n, 1n, BETTOR_A.address] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await rw.writeContract({ address: lin.address, abi: lin.abi, functionName: "commit", args: [G2, G0, G1, 2n, 2n, BETTOR_B.address] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A(BigInt(await pub.readContract({ address: lin.address, abi: lin.abi, functionName: "childCount", args: [G0] })) === 2n, "血统祖先链可查：G0 有 2 子");
A((await pub.readContract({ address: lin.address, abi: lin.abi, functionName: "breederOf", args: [G0] })) === BETTOR_A.address, "G0 breeder=BETTOR_A（版税收款人可从链上读出）");
A((await pub.readContract({ address: lin.address, abi: lin.abi, functionName: "commitCount" })) === 3n, "血统 commitCount=3");
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
try {
  await x402Settle(BETTOR_A, ADMIN, 10n ** 6n, "繁殖费(平台侧 EVOLUTION_TREASURY)");   // 1 USDC → ADMIN
  await x402Settle(BETTOR_B, await pub.readContract({ address: lin.address, abi: lin.abi, functionName: "breederOf", args: [G0] }), 5n * 10n ** 5n, "版税(创作者侧 breeder=G0)"); // 0.5 USDC → A
  A((await bal(USD, ADMIN)) - adminU0 === 10n ** 6n, "繁殖费 1.000000 USDC 确切落 TREASURY(ADMIN)");
  A((await bal(USD, BETTOR_A.address)) - aU0 === -(10n ** 6n) + 5n * 10n ** 5n, "版税 0.500000 USDC 确切落 breeder(G0)=BETTOR_A（净值：先付1.0费后收0.5）");
} catch (e) {
  console.log("  EIP-3009 直签结算不可用，降级 approve+transferFrom 复演同路径:", String(e?.message || e).slice(0, 120));
  await walletFor(BETTOR_A).writeContract({ address: USD, abi: ERC20, functionName: "approve", args: [RESOLVER.address, 10n ** 6n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
  await rw.writeContract({ address: USD, abi: ERC20, functionName: "transferFrom", args: [BETTOR_A.address, ADMIN, 10n ** 6n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
  A((await bal(USD, ADMIN)) - adminU0 === 10n ** 6n, "繁殖费 1.000000 USDC 确切落 TREASURY(ADMIN)（fallback 路径）");
}
// 血统合约全程零资金
A((await bal(USD, lin.address)) === 0n && (await native(lin.address)) === 0n, "ConnectomeLineage 全程零资金（纯承诺账本）");

// ============================================================================
section("ACT 5 · WarCoffer 全路径：deposit→declare→resolve→levy→sweep→stale 退款");
// ============================================================================
const cf = dep.coffer, cw = rw;
// 授权 + 双金库存入 25+25
await cw.writeContract({ address: USD, abi: ERC20, functionName: "approve", args: [cf.address, MAX_ESCROW] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const warConservation = async (label, openPot = 0n) => {
  const [v1, v2, purse, esc] = await Promise.all([
    pub.readContract({ address: cf.address, abi: cf.abi, functionName: "vault", args: [HOUSE_A] }),
    pub.readContract({ address: cf.address, abi: cf.abi, functionName: "vault", args: [HOUSE_B] }),
    pub.readContract({ address: cf.address, abi: cf.abi, functionName: "commonsPurse" }),
    pub.readContract({ address: cf.address, abi: cf.abi, functionName: "totalEscrow" }),
  ]);
  const usdcBal = await bal(USD, cf.address);
  A(v1 + v2 + purse + openPot === esc, `守恒 ${label}`, `Σ金库+税袋+在战池=${fmtU(v1 + v2 + purse + openPot)} == escrow=${fmtU(esc)}`);
  A(usdcBal === esc, `托管实币==账面 ${label}`, `balance=${fmtU(usdcBal)}`);
  return { v1, v2, purse, esc };
};
for (const [house, amt] of [[HOUSE_A, 25n * 10n ** 6n], [HOUSE_B, 25n * 10n ** 6n]]) {
  const h = await cw.writeContract({ address: cf.address, abi: cf.abi, functionName: "deposit", args: [house, amt] });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  deposit house#${house} ${fmtU(amt)} USDC · tx ${h.slice(0, 18)}…`);
}
A((await bal(USD, cf.address)) === MAX_ESCROW, "WarCoffer 实收 50 USDC（==硬顶）", fmtU(await bal(USD, cf.address)));
await warConservation("·存入后");
await expectRevert(cw.writeContract({ address: cf.address, abi: cf.abi, functionName: "deposit", args: [1003n, 10n ** 6n] }), "超硬顶 deposit 被拒（EscrowCap 50 USDC 不可突破）", "cap");
// declare war
let ts = await nowTs();
const DL1 = BigInt(ts + 60);
await cw.writeContract({ address: cf.address, abi: cf.abi, functionName: "declareWar", args: [1n, HOUSE_A, HOUSE_B, 5n * 10n ** 6n, 700n, 300n, DL1] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const wi = await pub.readContract({ address: cf.address, abi: cf.abi, functionName: "warInfo", args: [1n] });
A(wi[8] === 10n * 10n ** 6n, "declareWar 双方各 escrow 5 USDC（pot=10）", `pot=${fmtU(wi[8])}`);
A(wi[6] === 700n && wi[7] === 300n, "战力在 declare 时上链固化（resolve 时 resolver 无法干预）");
// 负向权限
const ow = walletFor(OUTSIDER);
await expectRevert(ow.writeContract({ address: cf.address, abi: cf.abi, functionName: "declareWar", args: [99n, HOUSE_A, HOUSE_B, 1n, 1n, 1n, DL1] }), "非 resolver declareWar 被拒", "resolver");
await expectRevert(cw.writeContract({ address: cf.address, abi: cf.abi, functionName: "declareWar", args: [98n, HOUSE_A, HOUSE_A, 1n, 1n, 1n, DL1] }), "attacker==defender 被拒", "war");
// resolve（先本地重算确定性胜者）
const exp = deriveWinner(1n, HOUSE_A, HOUSE_B, 700n, 300n);
await increaseTime(61);
const h1 = await cw.writeContract({ address: cf.address, abi: cf.abi, functionName: "resolveWar", args: [1n] });
await pub.waitForTransactionReceipt({ hash: h1 });
const pv = await pub.readContract({ address: cf.address, abi: cf.abi, functionName: "previewWinner", args: [1n] });
A(pv[1] === exp.roll && Number(pv[0]) === exp.winner, "确定性胜者本地重算==合约裁定（trustless 可复算）", `roll=${exp.roll} winner=${exp.winner == 1 ? "ATTACKER" : "DEFENDER"}`);
const { v1: v1r, v2: v2r } = await warConservation("·resolve后", 0n);
A((exp.winner === 1 ? v1r - v2r : v2r - v1r) === 10n * 10n ** 6n, "胜者金库恰好多 10 USDC（净赢一个 stake）", `A=${fmtU(v1r)} B=${fmtU(v2r)}`);
// 税：levy 1 USDC → commonsPurse → sweep 回金库（合约内转移，不触任何外部地址）
await cw.writeContract({ address: cf.address, abi: cf.abi, functionName: "levyTax", args: [HOUSE_A, 10n ** 6n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const purse1 = await pub.readContract({ address: cf.address, abi: cf.abi, functionName: "commonsPurse" });
A(purse1 === 10n ** 6n, "levyTax 1 USDC 入 commonsPurse", fmtU(purse1));
await warConservation("·levy后");
await expectRevert(ow.writeContract({ address: cf.address, abi: cf.abi, functionName: "sweepTo", args: [HOUSE_A] }), "非 resolver sweepTo 被拒", "resolver");
await cw.writeContract({ address: cf.address, abi: cf.abi, functionName: "sweepTo", args: [HOUSE_A] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await pub.readContract({ address: cf.address, abi: cf.abi, functionName: "commonsPurse" })) === 0n, "sweep 后 purse 归零（税留在自主金库体系内）");
await warConservation("·sweep后");
// stale 退款（任何人可触发）—— 退款目标=各自拿回本方 stake，回到战前水位
const preWar2 = await warConservation("·war2战前", 0n);
ts = await nowTs();
await cw.writeContract({ address: cf.address, abi: cf.abi, functionName: "declareWar", args: [2n, HOUSE_B, HOUSE_A, 5n * 10n ** 6n, 500n, 500n, BigInt(ts + 10)] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await increaseTime(10 + Number(STALE_GRACE) + 5);
await ow.writeContract({ address: cf.address, abi: cf.abi, functionName: "expireStaleWar", args: [2n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const { v1: v1s, v2: v2s } = await warConservation("·stale退款后");
A(v1s === preWar2.v1 && v2s === preWar2.v2, "stale 战双方全额退款=各自拿回本方 stake（回到战前水位，无 resolver 也能解锁托管）", `A=${fmtU(v1s)}(前${fmtU(preWar2.v1)}) B=${fmtU(v2s)}(前${fmtU(preWar2.v2)})`);
A((await bal(USD, cf.address)) === MAX_ESCROW, "全程 WarCoffer USDC 实币 50 未变（只有存入、无外部流出）", fmtU(await bal(USD, cf.address)));

// ============================================================================
section("ACT 6 · PredictionArena 全路径：open→bet→resolve→claim + FLAT + stale 退款");
// ============================================================================
const ar = dep.arena, mw = walletFor(BETTOR_A), bw = walletFor(BETTOR_B);
const arenaM = () => bal(dep.murmur.address, ar.address);
await mw.writeContract({ address: dep.murmur.address, abi: ERC20, functionName: "approve", args: [ar.address, 14_000n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await bw.writeContract({ address: dep.murmur.address, abi: ERC20, functionName: "approve", args: [ar.address, 8_000n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
// Round 1：UP vs DOWN，UP 赢
ts = await nowTs();
await rw.writeContract({ address: ar.address, abi: ar.abi, functionName: "openRound", args: [1n, 500_000n, 8_000n, BigInt(ts + 60)] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "bet", args: [1n, 1n, 12_000n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await bw.writeContract({ address: ar.address, abi: ar.abi, functionName: "bet", args: [1n, 2n, 8_000n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const r1 = await pub.readContract({ address: ar.address, abi: ar.abi, functionName: "roundInfo", args: [1n] });
A(r1[9] === 12_000n * 10n ** 18n && r1[10] === 8_000n * 10n ** 18n, "Round#1 池账正确", `up=${fmtM(r1[9])} down=${fmtM(r1[10])}`);
A(await arenaM() === 20_000n * 10n ** 18n, "竞技场托管=全部下注（20,000 MURMUR）", fmtM(await arenaM()));
await expectRevert(bw.writeContract({ address: ar.address, abi: ar.abi, functionName: "bet", args: [1n, 1n, 10n ** 18n] }), "同轮反向押注被拒（SideTaken）", "side");
await expectRevert(mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "bet", args: [1n, 1n, 0n] }), "零注被拒", "zero");
await increaseTime(61);
await rw.writeContract({ address: ar.address, abi: ar.abi, functionName: "resolve", args: [1n, 550_000n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const r1s = await pub.readContract({ address: ar.address, abi: ar.abi, functionName: "roundInfo", args: [1n] });
A(Number(r1s[2]) === 1, "Round#1 判定 UP（delta=+0.05 > band 0.008）", `outcome=${r1s[2]}`);
const pfA = await pub.readContract({ address: ar.address, abi: ar.abi, functionName: "payoutFor", args: [1n, BETTOR_A.address] });
A(pfA[1] === 20_000n * 10n ** 18n, "UP 赢家派彩=12k+全额败池=20,000（零抽水）", fmtM(pfA[1]));
const admMurb0 = await bal(dep.murmur.address, ADMIN), resMurb0 = await bal(dep.murmur.address, RESOLVER.address);
await mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "claim", args: [1n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await bw.writeContract({ address: ar.address, abi: ar.abi, functionName: "claim", args: [1n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A(await arenaM() === 0n, "Round#1 结清后竞技场托管归零", fmtM(await arenaM()));
A((await bal(dep.murmur.address, ADMIN)) === admMurb0 && (await bal(dep.murmur.address, RESOLVER.address)) === resMurb0, "平价零和：resolver/ADMIN 未从竞技场拿走一分钱");
// Round 2：FLAT 全额退款
ts = await nowTs();
await rw.writeContract({ address: ar.address, abi: ar.abi, functionName: "openRound", args: [2n, 500_000n, 8_000n, BigInt(ts + 60)] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await expectRevert(rw.writeContract({ address: ar.address, abi: ar.abi, functionName: "resolve", args: [2n, 500_000n] }), "注期内 resolve 被拒（BettingClosed）", "closed");
await mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "bet", args: [2n, 1n, 1_000n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await increaseTime(61);
await rw.writeContract({ address: ar.address, abi: ar.abi, functionName: "resolve", args: [2n, 502_000n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const aM2 = await bal(dep.murmur.address, BETTOR_A.address);
await mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "claim", args: [2n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await bal(dep.murmur.address, BETTOR_A.address)) - aM2 === 1_000n * 10n ** 18n, "FLAT 轮全额退款 1,000 MURMUR", fmtM(1_000n * 10n ** 18n));
// Round 3：stale 退款（路人触发）
ts = await nowTs();
await rw.writeContract({ address: ar.address, abi: ar.abi, functionName: "openRound", args: [3n, 500_000n, 8_000n, BigInt(ts + 60)] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "bet", args: [3n, 1n, 500n * 10n ** 18n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await increaseTime(60 + Number(STALE_GRACE) + 5);
await ow.writeContract({ address: ar.address, abi: ar.abi, functionName: "expireStale", args: [3n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const aM3 = await bal(dep.murmur.address, BETTOR_A.address);
await mw.writeContract({ address: ar.address, abi: ar.abi, functionName: "claim", args: [3n] }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
A((await bal(dep.murmur.address, BETTOR_A.address)) - aM3 === 500n * 10n ** 18n, "stale 轮全额退款 500 MURMUR（任何人可解锁）");
A(await arenaM() === 0n, "竞技场最终托管归零（用户资金无沉淀）", fmtM(await arenaM()));

// ============================================================================
section("ACT 7 · 全链账本回放 + 主权断言（第四方扫描）");
// ============================================================================
const endBlock = await pub.getBlockNumber();
const allLogs = [];
for (const [addr, name] of [[USD, "USDC(mock)"], [dep.murmur.address, "MURMUR"]]) {
  const ls = await pub.getLogs({ address: addr, topics: [TRANSFER_TOPIC], fromBlock: forkBlock, toBlock: endBlock });
  collectTransfers(ls, name);
  allLogs.push(...ls);
}
// ⚠ anvil 1.8.3 fork 模式会忽略 getLogs 的 topics 过滤（实测）——拉全量后客户端过滤，保证证据诚实
const authLogs = (await pub.getLogs({ address: USD, fromBlock: forkBlock, toBlock: endBlock }))
  .filter((l) => (l.topics[0] || "").toLowerCase() === AUTHUSED_TOPIC.toLowerCase());
A(authLogs.length === 2, "EIP-3009 AuthorizationUsed 事件落链（自持协议结算痕迹）", `count=${authLogs.length}（客户端按 topic0 复核）`);

let violations = [];
const KNOWN_FROM = new Set([ADMIN.toLowerCase(), RESOLVER.address.toLowerCase(), BETTOR_A.address.toLowerCase(), BETTOR_B.address.toLowerCase(), OUTSIDER.address.toLowerCase(), dep.coffer.address.toLowerCase(), dep.arena.address.toLowerCase(), "0x0000000000000000000000000000000000000000", USD.toLowerCase()]);
const KNOWN_TO = new Set([...KNOWN_FROM, dep.receipt.address.toLowerCase(), dep.manifest.address.toLowerCase(), dep.lineage.address.toLowerCase(), dep.murmur.address.toLowerCase()]);
const rows = ledger.map((r) => ({ ...r, fromRole: roleOf(r.from), toRole: roleOf(r.to), usdc: r.token.startsWith("USDC") ? fmtU(r.value) : fmtM(r.value) }));
for (const r of rows) {
  if (!KNOWN_FROM.has(r.from.toLowerCase())) violations.push({ ...r, why: "unknown FROM" });
  if (!KNOWN_TO.has(r.to.toLowerCase())) violations.push({ ...r, why: "unknown TO(第四方)" });
}
A(violations.length === 0, "全链账本：不存在任何第四方收付款地址", violations.length ? JSON.stringify(violations.slice(0, 3)) : `${rows.length} 笔转账全部白名单`);
const cofferOut = rows.filter((r) => r.from.toLowerCase() === dep.coffer.address.toLowerCase());
A(cofferOut.length === 0, "WarCoffer 托管零流出（存入后无任何 USDC 离开战库）", `${cofferOut.length} 笔流出`);
const arenaOut = rows.filter((r) => r.from.toLowerCase() === dep.arena.address.toLowerCase());
A(arenaOut.every((r) => [BETTOR_A.address.toLowerCase(), BETTOR_B.address.toLowerCase()].includes(r.to.toLowerCase())), "竞技场付款对象 100% 是下注者本人", `${arenaOut.length} 笔派出`);
const adminIn = rows.filter((r) => r.to.toLowerCase() === ADMIN.toLowerCase());
A(adminIn.length >= 2, "TREASURY(ADMIN) 收款路径存在（铸币+繁殖费）", adminIn.map((r) => `${r.token}:${r.usdc}`).join(" · "));
A(!rows.some((r) => r.to.toLowerCase() === OUTSIDER.address.toLowerCase()), "路人零收款（负向验证）");

// 部署字节码主权扫描：PUSH20 常量只能是我们自己的地址
const allowedPush = new Set([USD.toLowerCase(), RESOLVER.address.toLowerCase(), dep.murmur.address.toLowerCase()]);
const pushReport = {};
let pushBad = [];
for (const [k, v] of Object.entries(dep)) {
  const cts = await scanPush20(v.address);
  pushReport[k] = cts;
  for (const c of cts) {
    if (allowedPush.has(c.toLowerCase())) continue;
    const cc = await pub.getCode({ address: c }); // 非白名单候选：真嵌地址必有链上代码，随机数据没有
    if (cc && cc !== "0x") pushBad.push({ contract: k, addr: c, note: "非白名单且链上存在代码（疑似外部地址嵌入）" });
  }
}
A(pushBad.length === 0, "七合约字节码 PUSH20 走查：零未知/零上游地址嵌入", pushBad.length ? JSON.stringify(pushBad) : `候选 ${Object.values(pushReport).flat().length} 个，全部 ∈ {USDC(mock), RESOLVER, MURMUR} 或无链上代码的随机数据`);

// ============================================================================
section("收尾 · 汇总");
// ============================================================================
const pass = results.filter((r) => r.ok).length, fail = results.filter((r) => !r.ok).length;
console.log(`\n■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■`);
console.log(`■ R1 彩排完成：断言 ${pass} 通过 / ${fail} 失败 · 转账流水 ${rows.length} 笔 · fork 块 ${forkBlock} → ${endBlock}`);
console.log(`■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■`);
jsonLog.finishedAt = new Date().toISOString();
jsonLog.fork.forkBlock = Number(forkBlock); jsonLog.fork.endBlock = Number(endBlock);
jsonLog.asserts = results;
jsonLog.ledger = rows;
jsonLog.flows = {
  adminReceipts: adminIn.map((r) => ({ token: r.token, value: r.usdc, from: r.fromRole })),
  cofferOutflows: cofferOut.length,
  arenaPayouts: arenaOut.map((r) => ({ to: r.toRole, value: r.usdc })),
  violations,
  pushScan: pushReport,
};
jsonLog.roles = Object.fromEntries([...ROLES.entries()].map(([a, r]) => [a, r]));
fs.writeFileSync(path.join(root, "scripts", "r1-run-log.json"), JSON.stringify(jsonLog, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(`运行日志: ${path.join(root, "scripts", "r1-run-log.json")}`);
process.exit(fail ? 1 : 0);
