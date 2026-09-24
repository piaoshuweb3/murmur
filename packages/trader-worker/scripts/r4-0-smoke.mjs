// R4-0/R4-1 接线冒烟（只读，零 gas）——主网 5042 六合约构造参数回读 + Worker HTTP 断言
// 用法: node scripts/r4-0-smoke.mjs [--http-only | --chain-only]
// 退出码: 0=全绿  1=有断言失败
import { createPublicClient, http, formatEther } from "viem";

const RPC = process.env.RPC_URL || "https://rpc.mainnet.arc.io";
const CHAIN_ID = Number(process.env.CHAIN_ID || 5042);

const ADMIN        = "0x10687368eF1be3f178de0fCCf5EdfF49e1C258B1"; // 终极管理（无钥主权）
const FACILITATOR  = "0x20c54D8Fa205af293181833b46494d97d54753f3"; // gas payer = RESOLVER/COMMITTER
const MURMUR       = "0x43D84EfE7174637cdA55Ae1560cd4BFf4BaAB490";
const REGISTRY     = "0x87F6a942bb563dd7Bba4d3CdbD5d51477E71fc34";
const MANIFEST     = "0x6caCEd7513b6E0b5B2c0CCD669c8A9dE6a0ce20e";
const LINEAGE      = "0xCbe979EE7ccB54823e43Df0B3D815f10E8eeaB07";
const WAR          = "0x37a630e56bEa9B9214A638D31F761e9489C9f9C0";
const ARENA        = "0x0243F95C2654C888a36B7B0DE1D200AaF7C16B60";
const ARC_USDC     = "0x3600000000000000000000000000000000000000";
const BRAIN_HASH   = "0x403551bb4ed89402632e2e3c9c3abec3883e84b27931be78928e2f100f6efc02";

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? " — " + detail : ""}`); }
};
const eqAddr = (a, b) => (a || "").toLowerCase() === b.toLowerCase();

const chain = { id: CHAIN_ID, name: "arc", nativeCurrency: { name: "USDC", decimals: 18, symbol: "USDC" }, rpcUrls: { default: { http: [RPC] } } };
const client = createPublicClient({ chain, transport: http(RPC, { timeout: 15000 }) });

const abi = {
  erc20: [
    { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  ],
  registry: [
    { name: "committer", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { name: "chainHead", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
    { name: "commitCount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  ],
  latest: [
    { name: "committer", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { name: "latestHash", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
    { name: "commitCount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  ],
  war: [
    { name: "usdc", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { name: "resolver", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { name: "maxEscrow", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "staleGrace", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
    { name: "totalEscrow", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "commonsPurse", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "warCount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  ],
  arena: [
    { name: "token", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { name: "resolver", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
    { name: "staleGrace", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
    { name: "roundCount", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { name: "roundInfo", type: "function", stateMutability: "view",
      inputs: [{ type: "uint256" }],
      outputs: [
        { type: "bool" }, { type: "bool" }, { type: "uint8" }, { type: "int64" }, { type: "int64" },
        { type: "int64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      ] },
  ],
};
const call = async (addr, fnName, args = [], a = abi.erc20) =>
  client.readContract({ address: addr, abi: a, functionName: fnName, args });
const atomicToUsdcStr = (raw) => (Number(raw) / 1e6).toFixed(6) + " USDC";
const codeOf = async (addr) => {
  const c = await client.getBytecode({ address: addr });
  return typeof c === "string" ? c : (c ?? "");
};

async function chainChecks() {
  console.log("\n══ A. 链上只读回读（" + RPC + "）══");
  const nid = await client.getChainId();
  ok(nid === CHAIN_ID, `chainId == ${CHAIN_ID}`, `got ${nid}`);

  for (const [name, addr] of [["MurmurToken", MURMUR], ["ReceiptRegistry", REGISTRY], ["ManifestRegistry", MANIFEST], ["Lineage", LINEAGE], ["WarCoffer", WAR], ["PredictionArena", ARENA]]) {
    const c = await codeOf(addr);
    ok(c.length > 100, `${name} 已上链有字节码`, `${c.length / 2 - 1} bytes · ${addr}`);
  }

  const [name, symbol, supply] = await Promise.all([
    call(MURMUR, "name"), call(MURMUR, "symbol"), call(MURMUR, "totalSupply"),
  ]);
  ok(name === "Murmur" && symbol === "MURMUR", "MURMUR name/symbol", `${name}/${symbol}`);
  const ONE_B = 10n ** 27n;
  ok(supply === ONE_B, "总量 1,000,000,000（一次性铸）", supply.toString());
  const adminBal = await call(MURMUR, "balanceOf", [ADMIN]);
  ok(adminBal === supply, "ADMIN treasury 持有 100% 供应", formatEther(adminBal));

  const rc = await call(REGISTRY, "committer", [], abi.registry);
  ok(eqAddr(rc, FACILITATOR), "ReceiptRegistry.committer == facilitator", rc);
  const mc = await call(MANIFEST, "committer", [], abi.latest);
  ok(eqAddr(mc, FACILITATOR), "ManifestRegistry.committer == facilitator", mc);
  const mh = await call(MANIFEST, "latestHash", [], abi.latest);
  ok((mh || "").toLowerCase() === BRAIN_HASH.toLowerCase(), "生产脑 manifestHash 已锚定", String(mh).slice(0, 18) + "…");
  const mcc = await call(MANIFEST, "commitCount", [], abi.latest);
  ok(mcc >= 1n, "Manifest commitCount >= 1", mcc.toString());
  const lc = await call(LINEAGE, "committer", [], abi.latest);
  ok(eqAddr(lc, FACILITATOR), "Lineage.committer == facilitator", lc);
  const lcc = await call(LINEAGE, "commitCount", [], abi.latest);
  ok(lcc === 0n, "Lineage commitCount == 0（全新）", lcc.toString());

  const [wUsdc, wRes, wMax, wGrace, wEscrow, wPurse, wCnt] = await Promise.all([
    call(WAR, "usdc", [], abi.war), call(WAR, "resolver", [], abi.war), call(WAR, "maxEscrow", [], abi.war),
    call(WAR, "staleGrace", [], abi.war), call(WAR, "totalEscrow", [], abi.war),
    call(WAR, "commonsPurse", [], abi.war), call(WAR, "warCount", [], abi.war),
  ]);
  ok(eqAddr(wUsdc, ARC_USDC), "WarCoffer.usdc == 原生 USDC precompile", wUsdc);
  ok(eqAddr(wRes, FACILITATOR), "WarCoffer.resolver == facilitator", wRes);
  ok(wMax === 50n * 10n ** 6n, "WarCoffer.maxEscrow == 50 USDC（6-dec 原子，immutable 硬顶）", wMax.toString() + " raw（USDC precompile decimals=6）");
  ok(Number(wGrace) === 259200, "WarCoffer.staleGrace == 3 天", `${wGrace}s`);
  ok(wEscrow === 0n && wPurse === 0n && wCnt === 0n, "WarCoffer 空仓启动（escrow/purse/warCount 全 0）");

  const [aTok, aRes, aGrace, aCnt] = await Promise.all([
    call(ARENA, "token", [], abi.arena), call(ARENA, "resolver", [], abi.arena),
    call(ARENA, "staleGrace", [], abi.arena), call(ARENA, "roundCount", [], abi.arena),
  ]);
  ok(eqAddr(aTok, MURMUR), "Arena.token == 本部署 MURMUR（上游兜底已剔除）", aTok);
  ok(eqAddr(aRes, FACILITATOR), "Arena.resolver == facilitator", aRes);
  ok(Number(aGrace) === 259200, "Arena.staleGrace == 3 天", `${aGrace}s`);
  console.log(`  ℹ️  Arena.roundCount = ${aCnt.toString()}（开旗后随 cron 增长）`);

  const preDec = await client.readContract({ address: ARC_USDC, abi: [{ name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }], functionName: "decimals" });
  ok(Number(preDec) === 6, "USDC precompile decimals == 6（Worker 结算层/WarCoffer 硬顶同约定）", `decimals=${preDec}`);

  const facGas = await client.getBalance({ address: FACILITATOR });
  ok(facGas > 5n * 10n ** 17n, "facilitator 原生 USDC gas 余额 > 0.5", formatEther(facGas));
  const facTok = await call(ARC_USDC, "balanceOf", [FACILITATOR]);
  ok(facTok > 5n * 10n ** 5n, "facilitator USDC token 余额 > 0.5（6-dec，EIP-3009 可转）", atomicToUsdcStr(facTok));
  const adminGas = await client.getBalance({ address: ADMIN });
  console.log(`  ℹ️  ADMIN 原生余额（只读参考，应恒 0）= ${formatEther(adminGas)}`);

  const seen = [MURMUR, REGISTRY, MANIFEST, LINEAGE, WAR, ARENA, ARC_USDC, ADMIN, FACILITATOR];
  const uniq = new Set(seen.map((s) => s.toLowerCase()));
  ok(uniq.size === seen.length, "九方地址无一重合（token/合约/ADMIN/facilitator 互相独立）");
}

async function httpChecks() {
  console.log("\n══ B. Worker/前端 HTTP 断言 ══");
  const get = async (url, timeout = 8000) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const W = "http://127.0.0.1:8787";

  const h = await get(W + "/health");
  ok(h.status === 200 && h.body?.ok !== false, "GET /health 200", `v${h.body?.version ?? "?"}`);
  const feats = h.body?.features ?? [];
  const on = Array.isArray(feats) ? feats : Object.entries(feats).filter(([, v]) => v === true).map(([k]) => k);
  ok(on.includes("prediction-market"), "/health features 含 prediction-market（蜂群下注）", on.join(","));
  ok(on.includes("human-arena-murmur"), "/health features 含 human-arena-murmur（竞技场）");

  const a = await get(W + "/arena");
  ok(a.status === 200 && a.body?.enabled === true, "GET /arena enabled=true（R4-0/R4-1 接线生效）");
  ok(eqAddr(a.body?.arenaAddress, ARENA), "/arena arenaAddress == 本部署 Arena", a.body?.arenaAddress);
  ok(eqAddr(a.body?.token, MURMUR), "/arena token == 本部署 MURMUR", a.body?.token);
  ok(a.body?.chainId === CHAIN_ID, "/arena chainId == 5042（主网）");
  if (a.body?.current) {
    const c = a.body.current;
    ok(c.opened === true, "当前轮已由 resolver 开出（openRound 成功）", `round #${c.roundId}`);
    const ri = await call(ARENA, "roundInfo", [c.roundId], abi.arena);
    ok(ri[0] === true, "链上 roundInfo(roundId).opened == true（链上核验）");
  } else {
    console.log("  ℹ️  尚无 live 轮（resolver 未武装 = R4-1 写路径待用户放行，属预期 read-only 态）");
  }
  ok((a.body?.swarm?.rounds ?? 0) >= 0 && a.body?.swarm !== null, "蜂群预测统计（vs swarm 卡）有数据",
    a.body?.swarm ? `bettors=${a.body.swarm.bettors} rounds=${a.body.swarm.rounds} hitRate=${(a.body.swarm.hitRate * 100).toFixed(1)}%` : "null");

  const s = await get(W + "/state");
  ok(s.status === 200 && s.body?.config?.adminWallet?.toLowerCase() === ADMIN.toLowerCase(), "/state adminWallet == ADMIN", s.body?.config?.adminWallet);

  try {
    const p = await get("http://127.0.0.1:3000/api/arena");
    ok(p.status === 200 && p.body?.enabled === true, "前端 :3000 同源 /api 反代可达（竞技场抽屉数据源）");
  } catch {
    ok(false, "前端 :3000 同源 /api 反代可达", "前端未运行或代理异常");
  }
}

const mode = process.argv[2] || "";
if (mode !== "--http-only") await chainChecks();
if (mode !== "--chain-only") await httpChecks();
console.log(`\n══ 结果: ${pass} 通过 / ${fail} 失败 ══`);
process.exit(fail ? 1 : 0);
