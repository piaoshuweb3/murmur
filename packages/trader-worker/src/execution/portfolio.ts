// execution/portfolio.ts — real portfolio reading for the execution wallet (spec §3.3).
//
// The adapter's skeleton getPortfolio() returns safe static defaults; this module is the wired
// replacement that reads the DEDICATED execution wallet's actual balances on Solana + Base. It is
// deliberately NOT yet imported by the adapter: it becomes active in the same step the operator
// configures the execution secrets (fund isolation — this wallet is NOT the internal x402 economy's
// wallets, ever). Until then the file compiles standalone and documents the exact plan.
//
// Activation plan (from the 二次开发 doc, P0 "真实 Portfolio 读取"):
//   1. Set SOLANA_RPC_URL + SOLANA_PRIVATE_KEY (+ install @solana/web3.js + bs58) and/or
//      BASE_RPC_URL + EVM_PRIVATE_KEY as Worker secrets.
//   2. In adapter.getPortfolio(), replace the skeleton body with `return getRealPortfolio(this.env)`.
//   3. dailyVolumeUsd / lastTradeAt should then be sourced from the D1 execution_log for the UTC day
//      (query: SELECT SUM(amount_in) WHERE status='executed' AND created_at > utc-midnight) so a DO
//      restart can never reset the daily budget — the same persistence philosophy as the economy's
//      spendGuard.

import type { Env } from "../config.js";
import type { PortfolioSnapshot } from "./types.js";

// Installed with the Solana stack activation:
// import { Connection, PublicKey, Keypair } from "@solana/web3.js";
// import bs58 from "bs58";
// import { createPublicClient, http, formatUnits, type Address } from "viem";
// import { erc20Abi } from "viem";
// import { base } from "viem/chains";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Temporary USD marks for cross-chain folding — production must read a price oracle (P1). */
const FALLBACK_SOL_USD = 150;
const FALLBACK_ETH_USD = 2500;

export async function getRealPortfolio(env: Env): Promise<PortfolioSnapshot> {
  const [solana, basePort] = await Promise.all([getSolanaPortfolio(env), getBasePortfolio(env)]);
  // Simple merge (production: value every position through a price source, not just stables).
  const totalUsd = solana.totalUsd + basePort.totalUsd;
  const availableUsd = solana.availableUsd + basePort.availableUsd;
  return {
    totalUsd,
    availableUsd,
    positions: [...solana.positions, ...basePort.positions],
    dailyVolumeUsd: 0, // read from the D1 execution_log for the UTC day (see the plan above)
    lastTradeAt: {},   // ditto
  };
}

async function getSolanaPortfolio(_env: Env): Promise<PortfolioSnapshot> {
  // Activates with: SOLANA_RPC_URL + SOLANA_PRIVATE_KEY + @solana/web3.js installed.
  /*
  if (!env.SOLANA_RPC_URL || !env.SOLANA_PRIVATE_KEY) return emptyPort();
  const connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
  const keypair = Keypair.fromSecretKey(bs58.decode(env.SOLANA_PRIVATE_KEY));
  const owner = keypair.publicKey;

  // SOL balance (gas + wrapped quote asset).
  const solLamports = await connection.getBalance(owner);
  const solUsd = (solLamports / 1e9) * FALLBACK_SOL_USD;

  // USDC balance via the parsed token-account scan.
  let usdcAmount = 0;
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(USDC_SOL) });
    if (accounts.value.length > 0) {
      usdcAmount = accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
    }
  } catch {}

  return {
    totalUsd: solUsd + usdcAmount,
    availableUsd: usdcAmount,          // conservative: only stables count as deployable
    positions: usdcAmount > 0 ? [{ token: USDC_SOL, chain: "solana", amount: usdcAmount.toString(), valueUsd: usdcAmount }] : [],
    dailyVolumeUsd: 0,
    lastTradeAt: {},
  };
  */
  void _env;
  return emptyPort();
}

async function getBasePortfolio(_env: Env): Promise<PortfolioSnapshot> {
  // Activates with: BASE_RPC_URL + EVM_PRIVATE_KEY (viem already installed).
  /*
  if (!env.BASE_RPC_URL || !env.EVM_PRIVATE_KEY) return emptyPort();
  const { createPublicClient, http, formatUnits, type Address } = await import("viem");
  const { erc20Abi } = await import("viem");
  const { base } = await import("viem/chains");
  const { privateKeyToAccount } = await import("viem/accounts");

  const account = privateKeyToAccount(env.EVM_PRIVATE_KEY as `0x${string}`);
  const client = createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL) });

  // ETH balance (gas).
  const ethBalance = await client.getBalance({ address: account.address });
  const ethUsd = Number(formatUnits(ethBalance, 18)) * FALLBACK_ETH_USD;

  // USDC balance.
  let usdcRaw = 0n;
  try {
    usdcRaw = await client.readContract({
      address: USDC_BASE as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
  } catch {}
  const usdcAmount = Number(formatUnits(usdcRaw, 6));

  return {
    totalUsd: ethUsd + usdcAmount,
    availableUsd: usdcAmount,          // conservative: only stables count as deployable
    positions: usdcAmount > 0 ? [{ token: USDC_BASE, chain: "base", amount: usdcAmount.toString(), valueUsd: usdcAmount }] : [],
    dailyVolumeUsd: 0,
    lastTradeAt: {},
  };
  */
  void _env;
  return emptyPort();
}

function emptyPort(): PortfolioSnapshot {
  return { totalUsd: 0, availableUsd: 0, positions: [], dailyVolumeUsd: 0, lastTradeAt: {} };
}
