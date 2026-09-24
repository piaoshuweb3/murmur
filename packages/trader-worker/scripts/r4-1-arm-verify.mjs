#!/usr/bin/env node
// ============================================================================
// R4-1 武装核验（只读链上验证，2026-09-23）
// 断言：
//   1) PredictionArena.roundInfo(当前桶) 已由 facilitator 开轮（entryTemp/flatBand/deadline 落链）
//   2) facilitator USDC 余额 ≈ 4.970674 − openRound gas（差额即开轮 gas 实耗）
//   3) 近期区块扫描：facilitator → Arena 的 openRound 交易哈希（explorer 链接）
// 用法: node scripts/r4-1-arm-verify.mjs [roundId]
// ============================================================================
import { createPublicClient, http, formatUnits } from 'viem';

const RPC = process.env.RPC_URL ?? 'https://rpc.mainnet.arc.io';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 5042);
const FACILITATOR = '0x20c54D8Fa205af293181833b46494d97d54753f3';
const ARENA = '0x0243F95C2654C888a36B7B0DE1D200AaF7C16B60';
const USDC_PRECOMPILE = '0x3600000000000000000000000000000000000000';

const client = createPublicClient({ transport: http(RPC, { timeout: 20_000 }) });

const chainId = await client.getChainId();
if (chainId !== CHAIN_ID) throw new Error(`chainId ${chainId} != ${CHAIN_ID}`);
console.log(`chainId ${chainId} OK`);

// ---- roundInfo(uint256) 选择器（从合约 ABI 计算一次即可；这里用 eth_call + 手工 selector）----
import { keccak256, toFunctionSelector, encodeFunctionData, decodeFunctionResult } from 'viem';
// 直接走人肉 ABI：roundInfo(uint256) → (bool opened,bool resolved,uint8 outcome,int64 entryTempR6,int64 exitTempR6,int64 flatBandR6,uint64 betDeadline,uint64 openedAt,uint64 resolvedAt)
// 若选择器不匹配则以合约源码 ABI 为准 —— 这里用 contracts/build 产物导出的 ABI 更稳：
import { readFileSync } from 'node:fs';
const abiPath = new URL('../contracts/build/PredictionArena.json', import.meta.url).pathname;
const artifact = JSON.parse(readFileSync(abiPath, 'utf8'));
const abi = artifact.abi ?? artifact;
const roundId = BigInt(process.argv[2] ?? Math.floor(Date.now() / 1000 / 3600));

const info = await client.readContract({ address: ARENA, functionName: 'roundInfo', args: [roundId], abi });
const [opened, resolved, outcome, entryR6, exitR6, bandR6, deadline, openedAt, resolvedAt] = info;
const tempOf = (r6) => Number(r6) / 1e6;
console.log(`roundInfo(${roundId}):`);
console.log(`  opened=${opened} resolved=${resolved} outcome=${outcome}`);
console.log(`  entryTemp=${tempOf(entryR6)} exitTemp=${tempOf(exitR6)} flatBand=${tempOf(bandR6)}`);
console.log(`  betDeadline=${deadline} openedAt=${openedAt} resolvedAt=${resolvedAt}`);

let fails = 0;
const assert = (cond, label) => { console.log(`${cond ? '✓' : '✗ FAIL'} ${label}`); if (!cond) fails++; };
assert(opened === true, `round ${roundId} 已开轮（openRound 已上链）`);
assert(Number(deadline) > 0, 'betDeadline 已固化');
assert(tempOf(bandR6) > 0, 'flatBand 已固化');

// ---- facilitator 余额（原生 USDC precompile，decimals=6）----
const balRaw = await client.readContract({ address: USDC_PRECOMPILE, functionName: 'balanceOf', args: [FACILITATOR], abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] });
const bal = formatUnits(balRaw, 6);
console.log(`facilitator USDC 余额: ${bal}（R3 收官时 4.970674，差额 = 全部链上 gas 实耗）`);
assert(Number(bal) > 4.9 && Number(bal) <= 4.970674, '余额在预期区间（只减不增，gas 微耗）');

// ---- 近 60 块扫描 facilitator 的出账 tx（找 openRound 哈希）----
const head = await client.getBlockNumber();
let found = null;
for (let b = head; b > head - 90n && b > 0n && !found; b--) {
  const blk = await client.getBlock({ blockNumber: b, includeTransactions: true });
  for (const tx of blk.transactions ?? []) {
    if ((tx.from ?? '').toLowerCase() === FACILITATOR.toLowerCase() && (tx.to ?? '').toLowerCase() === ARENA.toLowerCase()) {
      const rec = await client.getTransactionReceipt({ hash: tx.hash });
      if (rec.status === 'success') { found = { hash: tx.hash, block: b, gas: formatUnits(rec.gasUsed * 24n, 18) }; break; }
    }
  }
}
if (found) {
  console.log(`openRound 交易: https://explorer.arc.io/tx/${found.hash} (block ${found.block})`);
  assert(true, 'facilitator→Arena 成功交易已找到');
} else {
  console.log('（近 90 块未见 facilitator→Arena 交易——若开轮发生在更早块可忽略）');
}

console.log(fails === 0 ? '\n== R4-1 链上核验 PASS ==' : `\n== ${fails} 项 FAIL ==`);
process.exit(fails === 0 ? 0 : 2);
