// 快速探针：Arc USDC precompile 在 anvil fork 上的读写能力
import { createPublicClient, createWalletClient, http, parseAbi, pad, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

const RPC = "http://127.0.0.1:8545";
const USDC = "0x3600000000000000000000000000000000000000";
const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const RESOLVER = mnemonicToAccount("test test test test test test test test test test test junk", { accountIndex: 2_000_000 });
const chain = { id: 31337, name: "f", nativeCurrency: { name: "n", symbol: "N", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function paused() view returns (bool)", "function implementation() view returns (address)", "function owner() view returns (address)"]);

const rBal = await pub.readContract({ address: USDC, abi, functionName: "balanceOf", args: [RESOLVER.address] });
const aBal = await pub.readContract({ address: USDC, abi, functionName: "balanceOf", args: [A] });
console.log("RESOLVER USDC:", rBal.toString(), "| A USDC:", aBal.toString());

for (const fn of ["paused", "owner", "implementation"]) {
  try { console.log(fn, "=", await pub.readContract({ address: USDC, abi, functionName: fn })); }
  catch (e) { console.log(fn, "-> revert"); }
}

// 只读模拟 transfer（eth_call）：若这里都 revert，说明写入层在 fork 上不可用
try {
  const { result } = await pub.call({ account: RESOLVER.address, to: USDC, data: "0xa9059cbb" + A.slice(2).toLowerCase().padStart(64, "0") + pad(toHex(1000n), { size: 32 }).slice(2) });
  console.log("eth_call transfer OK:", result);
} catch (e) {
  console.log("eth_call transfer revert:", String(e?.message || e).slice(0, 200));
}
// 只读模拟 approve
try {
  const { result } = await pub.call({ account: A, to: USDC, data: "0x095ea7b3" + RESOLVER.address.slice(2).toLowerCase().padStart(64, "0") + pad(toHex(1000n), { size: 32 }).slice(2) });
  console.log("eth_call approve OK:", result);
} catch (e) {
  console.log("eth_call approve revert:", String(e?.message || e).slice(0, 200));
}
