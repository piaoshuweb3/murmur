// R2 前置：faucet 领取到账核验（rpc.testnet.arc.io, chainId 5042002, 原生 gas=USDC 18 decimals）
import { createPublicClient, http, formatEther, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const RPC = 'https://rpc.testnet.arc.io';
const CHAIN_ID = 5042002;
const TX = '0xf24afd4674ffff8ad79df141b93e073499f66ec524dc491b2c60113a6001611b';

const env = readFileSync('/home/z/my-project/murmur-work/packages/trader-worker/.env.local', 'utf8');
const pk = env.match(/R2_DEPLOYER_PK=(0x[0-9a-fA-F]+)/)[1];
const acct = privateKeyToAccount(pk);

const client = createPublicClient({ transport: http(RPC, { timeout: 30_000 }) });

const chainId = await client.getChainId();
console.log('[1] chainId:', chainId, chainId === CHAIN_ID ? '✓' : '✗ MISMATCH');

console.log('[2] DEPLOYER(本地钥派生):', acct.address);

const bal = await client.getBalance({ address: acct.address });
console.log('[3] DEPLOYER 余额:', formatEther(bal), 'USDC(native)');
const block = await client.getBlockNumber();
console.log('[4] 当前区块:', block, '(链在推进 → 活链)');

// 领取交易本身：回执 + transfer 事件回放
try {
  const receipt = await client.getTransactionReceipt({ hash: TX });
  console.log('[5] 领取 tx 状态:', receipt.status, 'block:', receipt.blockNumber, 'from:', receipt.from, 'to:', receipt.to);
  const logs = await client.getLogs({
    address: receipt.to,
    event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
    fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber,
  });
  for (const l of logs) {
    console.log('    Transfer:', l.args.from, '→', l.args.to, formatEther(l.args.value), 'USDC');
  }
  const gasPrice = await client.getGasPrice();
  console.log('[6] gasPrice:', gasPrice, 'wei =', Number(gasPrice) / 1e9, 'gwei');
} catch (e) {
  console.log('[5] tx 回执读取失败（可能非标准 ERC20/系统入账）:', e.message.slice(0, 200));
}

const need = 3.0; // 全剧本 ≈2.73 USDC + 安全垫
const ok = Number(formatEther(bal)) >= need;
console.log('');
console.log(ok ? `✅ READY：余额 ≥ ${need} USDC，可以开跑 R2 彩排` : `❌ NEED_MORE_GAS：余额 < ${need} USDC`);
process.exit(ok ? 0 : 2);
