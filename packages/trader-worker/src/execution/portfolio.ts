// execution/portfolio.ts — REAL portfolio reading for the dedicated execution wallet (B2, Wave-2).
//
// The adapter's shadow-mode getPortfolio() returns safe paper defaults (totalUsd=100). In LIVE mode
// (EXECUTION_REAL_SPEND=true) the risk rails need the wallet's actual money, so the adapter swaps to
// getRealPortfolio() below. Every read is fail-soft: an RPC/price outage degrades to a SMALLER
// portfolio (0 balance reads as no deployable capital), never to an inflated one — a wrong read that
// LOOSENS a risk rail would be the worst possible failure mode for a money path.
//
// Where the truth comes from:
//   · Solana  — getTokenAccountsByOwner over the SPL Token program (all token accounts of the
//               execution wallet), valued through DexScreener's priceUsd.
//   · EVM     — chain-native enumeration of "all ERC-20s a wallet holds" does not exist, so the
//               token list comes from the POSITION LEDGER (the PositionBook snapshots state.ts
//               persists into DO storage every cron; the adapter syncs it via syncHeldTokens()).
//               On-chain balanceOf then VERIFIES each holding and prices it — ledger for WHAT we
//               hold, chain for HOW MUCH, exactly the P0 intent ("read from on-chain / DO storage").
//   · USDC    — queried directly per chain (constant addresses): it is the deployable capital the
//               availableUsd rail (risk rule 7) spends from, and must not depend on the ledger.
//   · dailyVolumeUsd — D1 aggregation (execution/log.ts queryDailyVolumeUsd, B3): the budget rail
//               survives DO restarts.
//
// Zero new vars (the var pool is a hard budget): wallet addresses are DERIVED from the signing
// secrets the live path already requires (SOLANA_PRIVATE_KEY via the P0-5 keypair, EVM_PRIVATE_KEY
// via viem) — the execution wallet that signs IS the execution wallet we read.

import type { Env } from "../config.js";
import type { ExecChain, PortfolioSnapshot } from "./types.js";
import { queryDailyVolumeUsd } from "./log.js";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Stablecoins read at $1.00 when DexScreener cannot price them (fail-soft DOWN, never up). */
const KNOWN_STABLES = new Set([USDC_SOL, USDC_BASE, USDC_ETH]);

// --------------------------- DexScreener pricing (shared helper) ---------------------------

const priceCache = new Map<string, { price: number; at: number }>();
const PRICE_TTL_MS = 60_000; // prices only feed marks; a minute of staleness is harmless

/** Best-effort USD price for one token address (Solana mint or EVM contract). 0 = unknown. */
export async function dexscreenerPriceUsd(token: string): Promise<number> {
  if (KNOWN_STABLES.has(token)) return 1;
  const hit = priceCache.get(token);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.price;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`dexscreener ${res.status}`);
    const body = (await res.json()) as {
      pairs?: Array<{ priceUsd?: string; liquidity?: { usd?: number } }>;
    };
    // Deepest-liquidity pair wins (the meme channels' same selection discipline).
    let best: { price: number; liq: number } = { price: 0, liq: -1 };
    for (const p of body.pairs ?? []) {
      const price = Number(p.priceUsd ?? 0);
      const liq = Number(p.liquidity?.usd ?? 0);
      if (Number.isFinite(price) && price > 0 && liq > best.liq) best = { price, liq };
    }
    const price = best.price;
    priceCache.set(token, { price, at: Date.now() });
    return price;
  } catch {
    priceCache.set(token, { price: 0, at: Date.now() });
    return 0;
  }
}

/** Test hook: clear the price cache between tests. */
export function resetPortfolioCaches(): void {
  priceCache.clear();
  erc20DecimalsCache.clear();
}

// --------------------------- EVM read helpers ---------------------------

const erc20DecimalsCache = new Map<string, number>();

/** decimals() via eth_call (selector 0x313ce567), cached per token — same wire shape as decimals.ts. */
async function erc20Decimals(rpc: string, token: string): Promise<number | null> {
  const hit = erc20DecimalsCache.get(token);
  if (hit != null) return hit;
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: token, data: "0x313ce567" }, "latest"],
      }),
    });
    const body: any = await res.json();
    const hex: string = body?.result ?? "";
    if (typeof hex !== "string" || !hex.startsWith("0x") || hex === "0x") return null;
    const d = Number(BigInt(hex));
    if (!Number.isFinite(d) || d < 0 || d > 36) return null;
    erc20DecimalsCache.set(token, d);
    return d;
  } catch {
    return null;
  }
}

/** balanceOf(wallet) via eth_call (selector 0x70a08231). Raw bigint; 0n on any failure. */
async function erc20BalanceOfRaw(rpc: string, token: string, wallet: string): Promise<bigint> {
  try {
    const data = `0x70a08231${wallet.replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: token, data }, "latest"],
      }),
    });
    const body: any = await res.json();
    const hex: string = body?.result ?? "0x0";
    if (typeof hex !== "string" || !hex.startsWith("0x")) return 0n;
    return BigInt(hex);
  } catch {
    return 0n;
  }
}

// --------------------------- the real portfolio ---------------------------

/** One held token the ledger vouches for (synced from the PositionBook each cron). */
export interface HeldToken {
  chain: ExecChain;
  token: string;
}

export async function getRealPortfolio(
  env: Env,
  lastTradeAt: Record<string, number>,
  heldTokens: HeldToken[] = [],
): Promise<PortfolioSnapshot> {
  const envRec = env as unknown as Record<string, string | undefined>;

  const positions: PortfolioSnapshot["positions"] = [];
  let totalUsd = 0;
  let stableUsd = 0; // deployable capital: USDC on the chains the execution layer trades

  // ---- Solana: enumerate the wallet's SPL token accounts, verify + value each. ----
  const solRpc = envRec.SOLANA_RPC_URL;
  const solPriv = envRec.SOLANA_PRIVATE_KEY;
  if (solRpc && solPriv) {
    try {
      const { loadKeypairFromSecret } = await import("./solana-signer.js");
      const owner = loadKeypairFromSecret(solPriv).publicKey.toBase58();
      const res = await fetch(solRpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
          params: [owner, { programId: SPL_TOKEN_PROGRAM }, { encoding: "jsonParsed" }],
        }),
      });
      const body: any = await res.json();
      for (const acc of body?.result?.value ?? []) {
        const info = acc?.account?.data?.parsed?.info;
        const mint: string | undefined = info?.mint;
        const ui = Number(info?.tokenAmount?.uiAmountString ?? 0);
        if (!mint || !(ui > 0)) continue;
        const price = await dexscreenerPriceUsd(mint);
        const usd = ui * price;
        totalUsd += usd;
        if (KNOWN_STABLES.has(mint)) stableUsd += usd;
        positions.push({ token: mint, chain: "solana", amount: String(ui), valueUsd: usd });
      }
    } catch {
      // fail-soft: an unreadable Solana side reads as 0 — the rails tighten, never loosen.
    }
  }

  // ---- EVM (base / eth): ledger-vouched tokens verified on-chain + direct USDC balances. ----
  const evmPriv = envRec.EVM_PRIVATE_KEY;
  for (const [chain, rpcKey, usdc] of [
    ["base", "BASE_RPC_URL", USDC_BASE],
    ["eth", "ETH_RPC_URL", USDC_ETH],
  ] as const) {
    const rpc = envRec[rpcKey];
    if (!rpc || !evmPriv) continue;
    try {
      const { privateKeyToAccount } = await import("viem/accounts");
      const wallet = privateKeyToAccount(evmPriv as `0x${string}`).address;

      // Deployable capital first — USDC must price even when every other read fails.
      const usdcRaw = await erc20BalanceOfRaw(rpc, usdc, wallet);
      if (usdcRaw > 0n) {
        const usd = Number(usdcRaw) / 1e6;
        totalUsd += usd;
        stableUsd += usd;
        positions.push({ token: usdc, chain, amount: (Number(usdcRaw) / 1e6).toString(), valueUsd: usd });
      }

      for (const held of heldTokens) {
        if (held.chain !== chain || held.token === usdc) continue;
        const raw = await erc20BalanceOfRaw(rpc, held.token, wallet);
        if (raw <= 0n) continue; // ledger says held, chain says otherwise — trust the chain
        const decimals = (await erc20Decimals(rpc, held.token)) ?? 18;
        const qty = Number(raw) / 10 ** decimals;
        const price = await dexscreenerPriceUsd(held.token);
        const usd = qty * price;
        totalUsd += usd;
        positions.push({ token: held.token, chain, amount: String(qty), valueUsd: usd });
      }
    } catch {
      // fail-soft, same direction as above.
    }
  }

  return {
    totalUsd,
    availableUsd: stableUsd, // conservative: only stables are deployable (risk rule 7's semantics)
    positions,
    dailyVolumeUsd: await queryDailyVolumeUsd(env),
    lastTradeAt,
  };
}
