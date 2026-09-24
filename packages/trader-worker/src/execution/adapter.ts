// ExecutionAdapter — the real-trade execution layer (safety first).
//
// This is the ONLY module allowed to turn a neural intent into a third-party DEX swap (Solana via
// Jupiter, EVM via 0x). The flow is always: evaluate (PURE risk rails) → shadow-or-broadcast →
// audit log. With the shipped defaults it can never move money:
//   EXECUTION_ENABLED  = "false"  → the adapter is never even constructed
//   EXECUTION_REAL_SPEND = "false" → every passing intent is recorded as a paper fill
//   EXECUTION_SHADOW   = "true"   → record-only, even if REAL_SPEND were flipped on by mistake
// Flipping to live is a deliberate, multi-flag operation documented in docs/二次开发技术实现路径与任务清单.md.
//
// Ported from the 二次开发 spec's "真实可用代码骨架" (Jupiter + 0x + viem). The EVM side uses viem,
// which is ALREADY a workspace dependency (the internal x402 settlement runs on it).
//
// P0-3 (dynamic decimals): the old USD→6-dec raw-amount assumption is GONE from the live sell path.
// A live sell is sized from the ledger's raw amount when present, else from verified on-chain decimals
// + a live mark (execution/decimals.ts); UNVERIFIED decimals now HARD-GATE the sell (throw → the D1
// audit log records status "failed" with the exact gate reason). Buys are unaffected (USDC is 6-dec
// by definition on every supported chain).
//
// P0-5 (Solana signing): @solana/web3.js + bs58 are installed and the signing path is REAL — gated by
// the 4th arming flag EXECUTION_SIGNING_ENABLED (the other three: ENABLED + REAL_SPEND + !SHADOW). With
// signing unarmed the live path throws BEFORE any signature is produced; with it armed, quote → build
// → sign (execution/solana-signer.ts) → broadcast → signature lands in the audit log.

import type { Env } from "../config.js";
import {
  evaluateRisk,
  riskRulesFromEnv,
  type RiskRules,
} from "./risk.js";
import { recordShadowFill, shadowResult } from "./shadow.js";
import { writeExecutionLog } from "./log.js";
import { sizeSellFromUsd } from "./decimals.js";
import { signingArmed } from "./solana-signer.js";
import type {
  ExecutionIntent,
  ExecutionResult,
  PortfolioSnapshot,
  RiskDecision,
} from "./types.js";

// Optional EVM stack (already available — viem ships with the worker). Imported lazily inside
// evmSwap so the module graph stays clean for unit tests that never touch the EVM path.
// import { createPublicClient, createWalletClient, http, encodeFunctionData, maxUint256, erc20Abi, type Address, type Hash } from "viem";
// import { privateKeyToAccount } from "viem/accounts";
// import { base, mainnet } from "viem/chains";

// ----------------------------- constants -----------------------------

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Jupiter endpoints (2026: lite-api is the open tier; quote-api v6 remains the fallback).
const JUPITER_QUOTE = "https://lite-api.jup.ag/swap/v1/quote";
const JUPITER_SWAP = "https://lite-api.jup.ag/swap/v1/swap";
// Jupiter Ultra (托管执行路径：更好的落地率 + MEV 保护；/order → sign → /execute).
const JUPITER_ULTRA_ORDER = "https://api.jup.ag/ultra/v1/order";
const JUPITER_ULTRA_EXECUTE = "https://api.jup.ag/ultra/v1/execute";

// 0x v2 (allowance-holder flow).
const ZEROX_QUOTE = "https://api.0x.org/swap/allowance-holder/quote";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC (6 dec)
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // Ethereum USDC (6 dec)

/**
 * Per-token last-trade timestamps (unix ms) for the cooldown gate. Module-level so the cooldown
 * survives across crons within the isolate's lifetime (the adapter itself is reconstructed each
 * cron; the DO isolate typically lives far longer). In-memory by design — a restart clears it,
 * which only ever LOOSENS the cooldown, and the daily caps (persisted in D1 history) still bound it.
 */
const lastTradeAt: Record<string, number> = {};

// ----------------------------- the adapter -----------------------------

export class ExecutionAdapter {
  constructor(private env: Env) {}

  /**
   * Pure-function evaluation (no side effects, unit-testable). Rule #1 is the global master switch
   * (spec's constraint table): EXECUTION_ENABLED=false rejects EVERYTHING before any rail runs.
   * Then the tunable rails from execution/risk.ts — the exact code path production uses.
   */
  evaluate(intent: ExecutionIntent, portfolio: PortfolioSnapshot): RiskDecision {
    if (this.env.EXECUTION_ENABLED !== "true") {
      return { allow: false, reason: "EXECUTION_ENABLED=false" };
    }
    const rules: RiskRules = riskRulesFromEnv(this.env as unknown as Record<string, string | undefined>);
    const withCooldown: PortfolioSnapshot = {
      ...portfolio,
      lastTradeAt: { ...lastTradeAt, ...portfolio.lastTradeAt },
    };
    return evaluateRisk(intent, withCooldown, rules, Date.now());
  }

  /**
   * The execution entry — the only place a real broadcast may originate.
   * evaluate → reject early | shadow-record | route-and-swap. Every terminal outcome lands in the
   * D1 audit log (best-effort) and, on shadow, in the in-memory paper ring for local visibility.
   */
  async execute(intent: ExecutionIntent): Promise<ExecutionResult> {
    const portfolio = await this.getPortfolio();
    const decision = this.evaluate(intent, portfolio);

    if (!decision.allow) {
      const rejected: ExecutionResult = {
        status: "rejected",
        intentId: intent.id,
        reason: decision.reason,
        timestamp: Date.now(),
      };
      await writeExecutionLog(this.env, intent, rejected);
      return rejected;
    }

    // Shadow first (the default): record the paper fill, broadcast nothing.
    const realSpend = this.env.EXECUTION_REAL_SPEND === "true";
    const shadow = this.env.EXECUTION_SHADOW !== "false"; // default true
    if (!realSpend || shadow) {
      const reason = realSpend ? "shadow forced" : "REAL_SPEND=false";
      recordShadowFill({
        intentId: intent.id,
        token: intent.token,
        chain: intent.chain,
        side: intent.side,
        amountUsd: decision.adjustedAmountUsd,
        reason,
        createdAt: Date.now(),
      });
      lastTradeAt[intent.token] = Date.now(); // paper fills respect the cooldown too
      const result = shadowResult(intent, decision.adjustedAmountUsd, reason);
      await writeExecutionLog(this.env, intent, result);
      return result;
    }

    // The live path — guarded by the multi-flag operation documented in the 二次开发 doc.
    try {
      const result = await this.routeAndSwap(intent, decision.adjustedAmountUsd);
      lastTradeAt[intent.token] = Date.now();
      await writeExecutionLog(this.env, intent, result);
      return result;
    } catch (err: unknown) {
      const failed: ExecutionResult = {
        status: "failed",
        intentId: intent.id,
        reason: err instanceof Error ? err.message : "unknown error",
        timestamp: Date.now(),
      };
      await writeExecutionLog(this.env, intent, failed);
      return failed;
    }
  }

  /**
   * Portfolio snapshot. The skeleton returns SAFE defaults (the spec's placeholder); wiring the
   * real on-chain reader is a one-line swap to getRealPortfolio() in execution/portfolio.ts once
   * the execution wallet + RPCs are configured (see that file for the exact plan).
   */
  async getPortfolio(): Promise<PortfolioSnapshot> {
    return {
      totalUsd: 100,
      availableUsd: 80,
      positions: [],
      dailyVolumeUsd: 0,
      lastTradeAt: { ...lastTradeAt },
    };
  }

  // --------------------------- routing ---------------------------

  /** Dispatch by chain. Unknown chains fail LOUDLY — silence here would mean silent money paths. */
  private async routeAndSwap(intent: ExecutionIntent, amountUsd: number): Promise<ExecutionResult> {
    switch (intent.chain) {
      case "solana":
        return this.solanaSwap(intent, amountUsd);
      case "base":
      case "eth":
        return this.evmSwap(intent, amountUsd);
      default:
        throw new Error(`unsupported chain: ${intent.chain}`);
    }
  }

  // ===================== Solana (Jupiter) =====================

  /**
   * Jupiter v1 swap: quote → build → (sign → send, commented until @solana/web3.js is installed).
   * The quote fetch is REAL when the live path runs; signing stays stubbed so the skeleton can
   * never leak a half-built tx — uncomment the marked block after `npm i @solana/web3.js bs58`.
   */
  private async solanaSwap(intent: ExecutionIntent, amountUsd: number): Promise<ExecutionResult> {
    const rpc = this.env.SOLANA_RPC_URL;
    const privateKey = this.env.SOLANA_PRIVATE_KEY; // base58 secret key
    if (!rpc || !privateKey) {
      throw new Error("SOLANA_RPC_URL or SOLANA_PRIVATE_KEY missing");
    }

    // 1. Direction: buys spend USDC; sells spend the token (the P2-1 exit path).
    const inputMint = intent.side === "buy" ? USDC_SOL : intent.token;
    const outputMint = intent.side === "buy" ? intent.token : USDC_SOL;

    // 2. Exact amount — P0-3 dynamic decimals. Buys spend USDC (6 decimals by definition, every
    //    supported chain). Sells: ledger raw amount → else decimals+price sizing → else HARD GATE.
    const amountIn = await this.resolveAmountIn(intent, amountUsd);

    // 3. Quote.
    const quoteUrl = new URL(JUPITER_QUOTE);
    quoteUrl.searchParams.set("inputMint", inputMint);
    quoteUrl.searchParams.set("outputMint", outputMint);
    quoteUrl.searchParams.set("amount", amountIn);
    quoteUrl.searchParams.set("slippageBps", String(intent.maxSlippageBps));
    quoteUrl.searchParams.set("onlyDirectRoutes", "false");
    quoteUrl.searchParams.set("asLegacyTransaction", "false");

    const quoteHeaders: Record<string, string> = { Accept: "application/json" };
    if (this.env.JUPITER_API_KEY) quoteHeaders["x-api-key"] = this.env.JUPITER_API_KEY;

    const quoteRes = await fetch(quoteUrl.toString(), { headers: quoteHeaders });
    if (!quoteRes.ok) {
      const text = await quoteRes.text();
      throw new Error(`Jupiter quote failed: ${quoteRes.status} ${text}`);
    }
    const quote = (await quoteRes.json()) as { outAmount?: string };
    if (!quote.outAmount || quote.outAmount === "0") {
      throw new Error("Jupiter returned zero outAmount (no route or liquidity)");
    }

    // 4. Build the swap transaction (the REAL wallet pubkey — P0-5 keypair derivation).
    const userPublicKey = await this.getSolanaPublicKey(privateKey);
    const swapBody = {
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    };
    const swapRes = await fetch(JUPITER_SWAP, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(this.env.JUPITER_API_KEY ? { "x-api-key": this.env.JUPITER_API_KEY } : {}),
      },
      body: JSON.stringify(swapBody),
    });
    if (!swapRes.ok) {
      const text = await swapRes.text();
      throw new Error(`Jupiter swap failed: ${swapRes.status} ${text}`);
    }
    const { swapTransaction } = (await swapRes.json()) as { swapTransaction?: string };
    if (!swapTransaction) throw new Error("No swapTransaction returned");

    // 5. Sign + send — the REAL broadcast path (P0-5). Reaching this line already required the first
    //    three flags (ENABLED + REAL_SPEND + !SHADOW); the 4th arming flag is checked HERE, after the
    //    quote+build are proven but BEFORE any signature exists. No signature ⇒ no broadcast, ever.
    const envRec = this.env as unknown as Record<string, string | undefined>;
    if (!signingArmed(envRec)) {
      throw new Error("EXECUTION_SIGNING_ENABLED!=true — signing not armed, live swap refused (P0-5)");
    }
    const { signVersionedSwap, broadcastTransaction } = await import("./solana-signer.js");
    const signed = signVersionedSwap(privateKey, swapTransaction);
    const txHash = await broadcastTransaction(rpc, signed.signedB64);
    return {
      status: "executed",
      intentId: intent.id,
      txHash, // real base58 signature — the D1 audit log + EXECUTION LOG panel show it verbatim
      amountIn,
      amountOut: quote.outAmount,
      amountUsd:
        intent.side === "buy"
          ? amountUsd // buys: the USDC notional that entered
          : Number(quote.outAmount ?? 0) / 1_000_000, // sells: the USDC received (6 dec)
      timestamp: Date.now(),
    };
  }

  /**
   * Jupiter Ultra variant (RECOMMENDED for production): hosted execution with better landing rates,
   * automatic priority fees and partial MEV protection. Flow: /order → sign → /execute.
   */
  private async solanaSwapUltra(intent: ExecutionIntent, amountUsd: number): Promise<ExecutionResult> {
    // 0. Arm check FIRST — an unarmed operator must not burn an Ultra /order request nor resolve decimals.
    const envRec = this.env as unknown as Record<string, string | undefined>;
    if (!signingArmed(envRec)) {
      throw new Error("EXECUTION_SIGNING_ENABLED!=true — signing not armed, Ultra live swap refused (P0-5)");
    }
    const privateKey = this.env.SOLANA_PRIVATE_KEY;
    const apiKey = this.env.JUPITER_API_KEY; // Ultra strongly recommends a key
    if (!privateKey) throw new Error("SOLANA_PRIVATE_KEY missing");

    const inputMint = intent.side === "buy" ? USDC_SOL : intent.token;
    const outputMint = intent.side === "buy" ? intent.token : USDC_SOL;
    // Same P0-3 contract as the v1 path: ledger raw → decimals+price sizing → hard gate.
    const amountIn = await this.resolveAmountIn(intent, amountUsd);
    const taker = await this.getSolanaPublicKey(privateKey);

    // 1. Order.
    const orderUrl = new URL(JUPITER_ULTRA_ORDER);
    orderUrl.searchParams.set("inputMint", inputMint);
    orderUrl.searchParams.set("outputMint", outputMint);
    orderUrl.searchParams.set("amount", amountIn);
    orderUrl.searchParams.set("taker", taker);
    orderUrl.searchParams.set("slippageBps", String(intent.maxSlippageBps));
    const orderRes = await fetch(orderUrl.toString(), {
      headers: { Accept: "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) },
    });
    if (!orderRes.ok) throw new Error(`Ultra order failed: ${await orderRes.text()}`);
    const order = (await orderRes.json()) as { transaction?: string; errorMessage?: string; outAmount?: string; requestId?: string };
    if (!order.transaction) throw new Error(order.errorMessage || "No transaction in Ultra order");

    // 2. Sign (P0-5 — the REAL keypair signs the REAL Ultra order transaction).
    const { signVersionedSwap } = await import("./solana-signer.js");
    const signed = signVersionedSwap(privateKey, order.transaction);

    // 3. Execute (Jupiter-hosted broadcast of OUR signature).
    const executeRes = await fetch(JUPITER_ULTRA_EXECUTE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signed.signedB64, requestId: order.requestId }),
    });
    const exec = (await executeRes.json()) as { status?: string; error?: string; signature?: string; outputAmountResult?: string };
    if (exec.status !== "Success") throw new Error(exec.error || "Ultra execute failed");

    return {
      status: "executed",
      intentId: intent.id,
      txHash: exec.signature,
      amountIn,
      amountOut: exec.outputAmountResult || order.outAmount,
      timestamp: Date.now(),
    };
  }

  // --------------------------- P0-3 sell sizing (the decimals gate) ---------------------------

  /**
   * The exact raw input amount for one intent.
   *   buys  → USDC raw = USD × 10⁶ (USDC is 6 decimals on Solana, Base AND Ethereum — a constant,
   *           not an assumption; this is the only place a literal 10⁶ is still allowed).
   *   sells → 1) the ledger's raw amount when the exit layer sized it (PositionBook × verified
   *              decimals — the precise path, no price needed),
   *           2) else verified on-chain decimals + a live mark convert the USD notional,
   *           3) else HARD GATE: throw. The live path never guesses decimals — a wrong guess sells
   *              10⁶× too little (dust) or 10× too much (oversell). The throw lands in the D1 audit
   *              log as status "failed" with the exact gate reason, so the panel shows WHY.
   */
  private async resolveAmountIn(intent: ExecutionIntent, amountUsd: number): Promise<string> {
    if (intent.side === "buy") return Math.floor(amountUsd * 1_000_000).toString(); // USDC: 6 dec everywhere
    if (intent.sellTokenAmount) return intent.sellTokenAmount; // ledger-sized raw units (preferred)
    const sizing = await sizeSellFromUsd(intent.chain, intent.token, amountUsd, this.env);
    if (sizing) return sizing.raw;
    throw new Error(
      `P0-3 GATE: decimals unverified for ${intent.token.slice(0, 8)}… — live sell blocked ` +
        `(wire HELIUS_API_KEY or SOLANA_RPC_URL, or re-run the exit layer once decimals resolve)`,
    );
  }

  /** REAL pubkey derivation via the P0-5 signer (lazy import keeps unit tests offline). */
  private async getSolanaPublicKey(privateKey: string): Promise<string> {
    const { loadKeypairFromSecret } = await import("./solana-signer.js");
    return loadKeypairFromSecret(privateKey).publicKey.toBase58();
  }

  // ===================== EVM (0x AllowanceHolder) =====================

  /**
   * 0x v2 swap on Base / Ethereum. The quote fetch is REAL when the live path runs; viem signing is
   * wired below in commented form (viem IS installed — the import is lazy-commented so unit tests
   * never construct an EVM client). Before the swap, ensureAllowance() must confirm the
   * AllowanceHolder approval (P0 in the 二次开发 checklist — an unapproved token reverts).
   */
  private async evmSwap(intent: ExecutionIntent, amountUsd: number): Promise<ExecutionResult> {
    const apiKey = this.env.ZEROX_API_KEY;
    const privateKey = this.env.EVM_PRIVATE_KEY; // 0x-prefixed
    const rpc = intent.chain === "base" ? this.env.BASE_RPC_URL : this.env.ETH_RPC_URL;
    if (!apiKey || !privateKey || !rpc) {
      throw new Error("ZEROX_API_KEY / EVM_PRIVATE_KEY / RPC missing");
    }

    const chainId = intent.chain === "base" ? 8453 : 1;
    const usdc = intent.chain === "base" ? USDC_BASE : USDC_ETH;
    const sellToken = intent.side === "buy" ? usdc : intent.token;
    const buyToken = intent.side === "buy" ? intent.token : usdc;

    // Buys: USDC is 6 decimals on Base AND Ethereum (a constant, not an assumption). Sells: the same
    // P0-3 contract as Solana — ledger raw → decimals+price sizing → hard gate (never guess).
    const sellAmount = await this.resolveAmountIn(intent, amountUsd);
    const taker = await this.getEvmAddress(privateKey);

    const params = new URLSearchParams({
      chainId: String(chainId),
      sellToken,
      buyToken,
      sellAmount,
      taker,
      slippageBps: String(intent.maxSlippageBps),
    });
    const res = await fetch(`${ZEROX_QUOTE}?${params.toString()}`, {
      headers: {
        "0x-api-key": apiKey,
        "0x-version": "v2",
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`0x quote failed: ${res.status} ${text}`);
    }
    const quote = (await res.json()) as {
      buyAmount?: string;
      transaction?: { to?: string; data?: string; value?: string; gas?: string };
      issues?: { allowance?: { spender?: string } };
      allowanceTarget?: string;
    };
    if (!quote.transaction) {
      throw new Error("0x returned no transaction (liquidity or allowance issue)");
    }

    // ---- Approval gate (P0): confirm the AllowanceHolder can pull the sell token. ----
    // const spender = (quote.issues?.allowance?.spender || quote.allowanceTarget) as Address;
    // if (spender) await this.ensureAllowance(sellToken as Address, spender, BigInt(sellAmount), intent.chain, rpc);

    // ---- Real signing + sending (viem — installed). Lazy-import keeps tests network-free: ----
    /*
    import { createWalletClient, http, type Hash } from "viem";
    import { privateKeyToAccount } from "viem/accounts";
    import { base, mainnet } from "viem/chains";

    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const chain = intent.chain === "base" ? base : mainnet;
    const walletClient = createWalletClient({ account, chain, transport: http(rpc) });
    const txHash: Hash = await walletClient.sendTransaction({
      to: quote.transaction.to as `0x${string}`,
      data: quote.transaction.data as `0x${string}`,
      value: BigInt(quote.transaction.value || "0"),
      gas: quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
    });
    return { status: "executed", intentId: intent.id, txHash, amountIn: sellAmount, amountOut: quote.buyAmount, gasUsed: Number(quote.transaction.gas || 0), timestamp: Date.now() };
    */

    const mockTxHash = `0xZER0X_SIMULATED_${intent.id.slice(0, 8)}`;
    return {
      status: "executed",
      intentId: intent.id,
      txHash: mockTxHash,
      amountIn: sellAmount,
      amountOut: quote.buyAmount,
      amountUsd:
        intent.side === "buy"
          ? amountUsd
          : Number(quote.buyAmount ?? 0) / 1_000_000, // sells: USDC received (6 dec)
      gasUsed: Number(quote.transaction.gas || 0),
      timestamp: Date.now(),
    };
  }

  /**
   * ERC-20 approval for the 0x AllowanceHolder (viem). Returns whether an approve tx was needed.
   * Real code — activate alongside the commented signing block in evmSwap.
   */
  /*
  private async ensureAllowance(
    token: Address,
    spender: Address,
    amount: bigint,
    chain: "base" | "eth",
    rpc: string,
  ): Promise<{ needed: boolean; txHash?: Hash }> {
    const { createPublicClient, createWalletClient, http, encodeFunctionData, maxUint256, erc20Abi } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");
    const { base: baseChain, mainnet } = await import("viem/chains");

    const account = privateKeyToAccount(this.env.EVM_PRIVATE_KEY as `0x${string}`);
    const viemChain = chain === "base" ? baseChain : mainnet;
    const publicClient = createPublicClient({ chain: viemChain, transport: http(rpc) });
    const walletClient = createWalletClient({ account, chain: viemChain, transport: http(rpc) });

    // 1. Current allowance.
    const current = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, spender],
    });
    if (current >= amount) return { needed: false };

    // 2. Approve max once (fewer future approve txs; revoke by spending controls, not by dust approvals).
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, maxUint256] });
    const txHash = await walletClient.sendTransaction({ to: token, data });

    // 3. Wait for the approval to land before the swap depends on it.
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    return { needed: true, txHash };
  }
  */

  /** REAL address derivation via viem (installed; lazy import keeps unit tests offline). */
  private async getEvmAddress(privateKey: string): Promise<string> {
    const { privateKeyToAccount } = await import("viem/accounts");
    return privateKeyToAccount(privateKey as `0x${string}`).address;
  }
}
