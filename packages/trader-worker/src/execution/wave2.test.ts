// Wave-2 tests — B1 (EVM real signing), B2 (real portfolio), B3 (D1 daily volume), B6 (circuit
// breaker), B7 (pre-broadcast simulation). All offline: fetch is stubbed into a router, D1 is a
// capture-first fake, viem runs for real against the stubbed JSON-RPC (the same integration style
// the P0-5 Solana tests use). The contracts enforced here:
//   · B1: the EVM signer refuses to sign unless EXECUTION_SIGNING_ENABLED is armed (P0-5 symmetry),
//     an approval runs BEFORE the swap, and "executed" is only claimed after the receipt lands.
//   · B2: shadow keeps the paper defaults; live reads fail CLOSED (zero configured wallet ⇒ zero
//     deployable capital); the ledger-vouched EVM list is verified on-chain before pricing.
//   · B3: the day boundary binds unix ms (INTEGER column) and shadow/executed unit split holds.
//   · B6: three consecutive live failures open the breaker; the window degrades to shadow; a
//     success resets the count.
//   · B7: a failing simulation never reaches the broadcast.

import test from "node:test";
import assert from "node:assert/strict";

import { ExecutionAdapter, __resetCircuitBreaker } from "./adapter.js";
import { queryDailyVolumeUsd } from "./log.js";
import { getRealPortfolio, resetPortfolioCaches } from "./portfolio.js";
import type { ExecutionIntent, ExecutionResult } from "./types.js";
import type { Env } from "../config.js";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

// ---------- fixtures ----------

const NOW = 1_800_000_000_000;
const EVM_KEY = ("0x" + "11".repeat(32)) as `0x${string}`;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MEME_BASE = "0xaaaa000000000000000000000000000000000001";
const SPENDER = "0xbbbb000000000000000000000000000000000002";
const BLOCK_HASH = "0x" + "ab".repeat(32);
const TX_HASH = "0x" + "cd".repeat(32);
const LOGS_BLOOM = "0x" + "00".repeat(256);
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function intent(over: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    id: "w2-intent-001",
    token: "W2Token1111111111111111111111111111111111",
    chain: "solana",
    side: "buy",
    strength: 0.8,
    confidence: 0.7,
    maxSlippageBps: 100,
    deadline: Math.floor(NOW / 1000) + 600,
    sourceFlyIds: [1],
    suggestedAmountUsd: 3,
    ...over,
  };
}

function env(over: Record<string, string> = {}): Env {
  return {
    MEME_ENABLED: "true",
    EXECUTION_ENABLED: "true",
    EXECUTION_REAL_SPEND: "false",
    EXECUTION_SHADOW: "true",
    MAX_DAILY_VOLUME_USDC: "50",
    MAX_PER_TRADE_USDC: "5",
    MAX_POSITION_PCT: "10",
    MIN_LIQUIDITY_USD: "10000",
    MAX_HOLDER_CONCENTRATION: "0.35",
    TRADE_COOLDOWN_SECONDS: "300",
    MIN_CONFIDENCE: "0.45",
    MAX_SLIPPAGE_BPS: "150",
    ...over,
  } as unknown as Env;
}

type Json = any;

/** Minimal JSON response for stubbed fetch calls. */
function jsonRes(payload: Json, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function bodyOf(init?: RequestInit): Promise<Json> {
  if (!init?.body) return {};
  try {
    return JSON.parse(String(init.body));
  } catch {
    return {};
  }
}

interface CallRec {
  url: string;
  method: string;
  body: Json;
}

/** Routing fetch stub with a full call log (the B1 ordering assertions read this). */
function stubFetch(handler: (url: string, body: Json) => Json | null): {
  restore: () => void;
  log: CallRec[];
} {
  const log: CallRec[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = await bodyOf(init);
    log.push({ url: String(url), method: body?.method ?? "?", body });
    const payload = handler(String(url), body);
    if (payload === null) return jsonRes({ error: "stubbed transport failure" }, 500);
    return jsonRes(payload);
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    log,
  };
}

// ---------- a minimal capture-first D1 fake for B3 ----------

function fakeD1(result: { v?: number | string } | null, capture?: { sql?: string; bind?: unknown[] }) {
  return {
    DB: {
      prepare(sql: string) {
        if (capture) capture.sql = sql;
        return {
          bind(...args: unknown[]) {
            if (capture) capture.bind = args;
            return {
              async first<T>(): Promise<T | null> {
                return (result as T) ?? null;
              },
            };
          },
          async first<T>(): Promise<T | null> {
            return (result as T) ?? null;
          },
          async run(): Promise<void> {},
          async all<T>(): Promise<{ results: T[] }> {
            return { results: [] };
          },
        };
      },
    },
  } as unknown as Env;
}

// ============================= B3: the D1 daily volume =============================

test("B3: queryDailyVolumeUsd binds a unix-ms day boundary (NOT an ISO string) and normalises units in SQL", async () => {
  const capture: { sql?: string; bind?: unknown[] } = {};
  const d1 = fakeD1({ v: "12.5" }, capture);
  const v = await queryDailyVolumeUsd(d1, NOW);
  assert.equal(v, 12.5, "string v is coerced through Number()");
  const bound = capture.bind?.[0];
  assert.equal(typeof bound, "number", "created_at is an INTEGER unix-ms column — bind getTime()");
  assert.ok((bound as number) <= NOW);
  const sql = capture.sql ?? "";
  assert.match(sql, /CAST\(amount_in AS REAL\)/, "amount_in is TEXT — it must be CAST");
  assert.match(sql, /status = 'executed'/, "executed rows are raw 6-dec USDC → /1e6");
  assert.match(sql, /1000000\.0/, "the executed-side unit normalisation is present");
  assert.match(sql, /side = 'buy'/, "only buys consume the daily budget");
});

test("B3: fail-soft — no binding, null row, or a throwing D1 all read as 0", async () => {
  assert.equal(await queryDailyVolumeUsd(env()), 0, "no DB binding");
  const d1Null = fakeD1(null);
  assert.equal(await queryDailyVolumeUsd(d1Null, NOW), 0);
  const d1Throw = {
    DB: {
      prepare() {
        throw new Error("d1 down");
      },
    },
  } as unknown as Env;
  assert.equal(await queryDailyVolumeUsd(d1Throw, NOW), 0);
});

// ============================= B2: the real portfolio =============================

test("B2: live Solana read — token accounts enumerated, stables only are deployable", async () => {
  resetPortfolioCaches();
  const kp = Keypair.generate();
  const { restore } = stubFetch((url, body) => {
    if (body.method === "getTokenAccountsByOwner") {
      return {
        result: {
          value: [
            { account: { data: { parsed: { info: { mint: USDC_SOL, tokenAmount: { uiAmountString: "50" } } } } } },
            { account: { data: { parsed: { info: { mint: "MemeMint111111111111111111111111111111111111", tokenAmount: { uiAmountString: "100" } } } } } },
          ],
        },
      };
    }
    if (url.includes("api.dexscreener.com/latest/dex/tokens/")) {
      return { pairs: [{ priceUsd: "0.5", liquidity: { usd: 250_000 } }] };
    }
    return null;
  });
  try {
    const snap = await getRealPortfolio(
      env({ SOLANA_RPC_URL: "https://rpc.example", SOLANA_PRIVATE_KEY: bs58.encode(kp.secretKey) }) as Env,
      {},
    );
    assert.equal(snap.totalUsd, 50 * 1 + 100 * 0.5);
    assert.equal(snap.availableUsd, 50, "only stables are deployable capital (risk rule 7)");
    assert.equal(snap.positions.length, 2);
    const meme = snap.positions.find((p) => p.token === "MemeMint111111111111111111111111111111111111");
    assert.equal(meme?.chain, "solana");
    assert.equal(meme?.amount, "100");
    assert.equal(meme?.valueUsd, 50);
    assert.equal(snap.dailyVolumeUsd, 0, "no D1 binding → volume rail reads 0");
  } finally {
    restore();
  }
});

test("B2: live EVM read — ledger-vouched tokens verified on-chain; USDC priced even when DexScreener is dead", async () => {
  resetPortfolioCaches();
  const { restore } = stubFetch((_url, body) => {
    if (body.method === "eth_call") {
      const to = String(body.params?.[0]?.to ?? "").toLowerCase();
      const data = String(body.params?.[0]?.data ?? "");
      if (data.startsWith("0x70a08231")) {
        // balanceOf: USDC → 5 USDC raw; the ledger meme token → 1_000_000_000 raw (9 dec)
        if (to === USDC_BASE.toLowerCase()) return { result: "0x" + (5_000_000).toString(16).padStart(64, "0") };
        if (to === MEME_BASE) return { result: "0x" + (1_000_000_000).toString(16).padStart(64, "0") };
        return { result: "0x" + "0".repeat(64) };
      }
      if (data.startsWith("0x313ce567")) return { result: "0x" + (9).toString(16).padStart(64, "0") }; // decimals
      return { result: "0x" };
    }
    return null; // dexscreener intentionally dead → price 0, USDC still $1 via the stable table
  });
  try {
    const snap = await getRealPortfolio(
      env({ BASE_RPC_URL: "https://base-rpc.example", EVM_PRIVATE_KEY: EVM_KEY }) as Env,
      {},
      [{ chain: "base", token: MEME_BASE }],
    );
    assert.equal(snap.availableUsd, 5, "USDC counts as deployable even with every price feed down");
    const usdc = snap.positions.find((p) => p.token === USDC_BASE);
    assert.equal(usdc?.valueUsd, 5);
    const meme = snap.positions.find((p) => p.token === MEME_BASE);
    assert.ok(meme, "the ledger-vouched token is verified and listed");
    assert.equal(meme?.chain, "base");
    assert.equal(meme?.amount, "1"); // 1e9 raw / 10^9 decimals
    assert.equal(meme?.valueUsd, 0, "price unknown ⇒ valued at 0, never guessed");
  } finally {
    restore();
  }
});

test("B2: fail-CLOSED — a live adapter with nothing configured has zero deployable capital", async () => {
  const a = new ExecutionAdapter(env({ EXECUTION_REAL_SPEND: "true", EXECUTION_SHADOW: "false" }));
  const snap = await a.getPortfolio();
  assert.equal(snap.availableUsd, 0);
  assert.equal(snap.totalUsd, 0);
  const r = await a.execute(intent({ token: "FailClosed111111111111111111111111111111111", id: "w2-fc-1" }));
  assert.equal(r.status, "rejected", "no wallet configured ⇒ the rails reject the buy");
  assert.match(r.reason ?? "", /insufficient available balance/);
});

test("B2: shadow mode keeps the paper defaults and never touches the network", async () => {
  const a = new ExecutionAdapter(env());
  const snap = await a.getPortfolio();
  assert.equal(snap.totalUsd, 100);
  assert.equal(snap.availableUsd, 80);
});

// ============================= B6: the circuit breaker =============================

function liveEnv(over: Record<string, string> = {}): Env {
  return env({
    EXECUTION_REAL_SPEND: "true",
    EXECUTION_SHADOW: "false",
    ...over,
  });
}

test("B6: three consecutive live failures open the breaker; the window degrades every intent to shadow", async () => {
  __resetCircuitBreaker();
  try {
    const a = new ExecutionAdapter(liveEnv());
    // SELL intents: the sell short-circuit (risk.ts 0b) passes evaluate unconditionally, so these
    // reach the LIVE path cleanly. "arc" is a known ExecChain with no router — a guaranteed
    // live-path failure with zero fetches.
    const sellArc = (id: string, token: string) =>
      intent({ chain: "arc" as const, side: "sell" as const, token, id, suggestedAmountUsd: 2, confidence: 1, strength: 1 });
    const f1 = await a.execute(sellArc("cb-f1", "CBToken11111111111111111111111111111111111"));
    const f2 = await a.execute(sellArc("cb-f2", "CBToken22222222222222222222222222222222222"));
    assert.equal(f1.status, "failed");
    assert.equal(f2.status, "failed");
    const f3 = await a.execute(sellArc("cb-f3", "CBToken33333333333333333333333333333333333"));
    assert.equal(f3.status, "failed", "the third failure itself is still a normal failed record");
    assert.match(f3.reason ?? "", /unsupported chain/);

    const d1 = await a.execute(sellArc("cb-f4", "CBToken44444444444444444444444444444444444444"));
    assert.equal(d1.status, "shadow", "the breaker now degrades the live path");
    assert.match(d1.reason ?? "", /circuit-breaker/);
    assert.match(d1.reason ?? "", /consecutive live failures/);
    assert.ok((d1 as ExecutionResult).txHash === undefined, "no tx hash — nothing was broadcast");
  } finally {
    __resetCircuitBreaker();
  }
});

test("B6: a clean broadcast resets the consecutive-failure count", async () => {
  __resetCircuitBreaker();
  try {
    const kp = Keypair.generate();
    const swapTx = Buffer.from(
      new VersionedTransaction(
        new TransactionMessage({
          payerKey: kp.publicKey,
          recentBlockhash: bs58.encode(Buffer.alloc(32, 7)),
          instructions: [
            SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 0 }),
          ],
        }).compileToV0Message(),
      ).serialize(),
    ).toString("base64");
    const onChainSig = bs58.encode(Buffer.alloc(64, 5));
    const { restore } = stubFetch((url, body) => {
      if (body.method === "getTokenAccountsByOwner") {
        // a funded wallet: 50 USDC → availableUsd 50 ≥ the 3-USDC buy
        return {
          result: {
            value: [
              { account: { data: { parsed: { info: { mint: USDC_SOL, tokenAmount: { uiAmountString: "50" } } } } } },
            ],
          },
        };
      }
      if (url.includes("jup.ag/swap/v1/quote")) return { outAmount: "1000000" };
      if (url.includes("jup.ag/swap/v1/swap")) return { swapTransaction: swapTx };
      if (body.method === "simulateTransaction") return { result: { value: { err: null } } };
      if (body.method === "sendTransaction") return { result: onChainSig };
      return null;
    });
    try {
      const a = new ExecutionAdapter(liveEnv({
        SOLANA_RPC_URL: "https://rpc.example",
        SOLANA_PRIVATE_KEY: bs58.encode(kp.secretKey),
        EXECUTION_SIGNING_ENABLED: "true",
      }));
      const arcSell = (id: string, token: string) =>
        intent({ chain: "arc" as const, side: "sell" as const, token, id, suggestedAmountUsd: 2, confidence: 1, strength: 1 });
      const f1 = await a.execute(arcSell("cbr-f1", "CBReset1111111111111111111111111111111111"));
      const f2 = await a.execute(arcSell("cbr-f2", "CBReset2222222222222222222222222222222222"));
      assert.equal(f1.status, "failed");
      assert.equal(f2.status, "failed");
      const s1 = await a.execute(intent({ token: "CBReset3333333333333333333333333333333333", id: "cbr-s1" }));
      assert.equal(s1.status, "executed", "the stubbed live Solana flow succeeds");
      assert.equal(s1.txHash, onChainSig);
      const f3 = await a.execute(arcSell("cbr-f3", "CBReset4444444444444444444444444444444444"));
      const f4 = await a.execute(arcSell("cbr-f4", "CBReset5555555555555555555555555555555555"));
      assert.equal(f3.status, "failed");
      assert.equal(f4.status, "failed", "count restarted at 0 after the success ⇒ still no breaker");
    } finally {
      restore();
    }
  } finally {
    __resetCircuitBreaker();
  }
});

// ============================= B1 + B7: the EVM signer =============================

const BLOCK_FIXTURE = {
  number: "0x100",
  hash: BLOCK_HASH,
  parentHash: "0x" + "11".repeat(32),
  nonce: "0x0000000000000000",
  sha3Uncles: "0x" + "00".repeat(32),
  logsBloom: LOGS_BLOOM,
  transactionsRoot: "0x" + "22".repeat(32),
  stateRoot: "0x" + "33".repeat(32),
  receiptsRoot: "0x" + "44".repeat(32),
  miner: "0x0000000000000000000000000000000000000000",
  difficulty: "0x0",
  totalDifficulty: "0x0",
  extraData: "0x",
  size: "0x1000",
  gasLimit: "0x1e8480",
  gasUsed: "0x0",
  timestamp: "0x64",
  transactions: [],
  uncles: [],
  mixHash: "0x" + "55".repeat(32),
  baseFeePerGas: "0x1",
};

const RECEIPT_FIXTURE = {
  transactionHash: TX_HASH,
  transactionIndex: "0x1",
  blockHash: BLOCK_HASH,
  blockNumber: "0x100",
  from: "0x0000000000000000000000000000000000000001",
  to: "0x0000000000000000000000000000000000000002",
  cumulativeGasUsed: "0x5208",
  gasUsed: "0x5208",
  contractAddress: null,
  logs: [],
  logsBloom: LOGS_BLOOM,
  status: "0x1",
  type: "0x2",
  effectiveGasPrice: "0x77359400",
};

const QUOTE_TX = {
  to: "0xcccc000000000000000000000000000000000003",
  data: "0xdeadbeef" + "aa".repeat(16),
  value: "0",
  gas: "0x186a0",
};

function zeroXQuote() {
  return {
    buyAmount: "1000000",
    transaction: QUOTE_TX,
    issues: { allowance: { spender: SPENDER } },
  };
}

/** The full EVM JSON-RPC stub: a funded wallet, allowance read → 0, sim call, receipts land. */
function evmRpcStub(log: CallRec[], opts: { simRevert?: boolean } = {}) {
  return (url: string, body: Json): Json | null => {
    if (url.includes("api.0x.org/swap/allowance-holder/quote")) return zeroXQuote();
    if (body.method === "eth_chainId") return { result: "0x2105" };
    if (body.method === "eth_getBlockByNumber") return { result: BLOCK_FIXTURE };
    if (body.method === "eth_gasPrice") return { result: "0x77359400" };
    if (body.method === "eth_maxPriorityFeePerGas") return { result: "0x3b9aca00" };
    if (body.method === "eth_estimateGas") return { result: "0x186a0" };
    if (body.method === "eth_getTransactionCount") return { result: "0x2" };
    if (body.method === "eth_call") {
      const to = String(body.params?.[0]?.to ?? "").toLowerCase();
      const data = String(body.params?.[0]?.data ?? "");
      if (data.startsWith("0x70a08231")) {
        // balanceOf: the wallet holds 50 USDC — deployable capital AND a big enough total that the
        // 3-USDC buy stays under the 10% position ceiling (3/50 = 6%)
        if (to === USDC_BASE.toLowerCase()) return { result: "0x" + (50_000_000).toString(16).padStart(64, "0") };
        return { result: "0x" + "0".repeat(64) };
      }
      if (data.startsWith("0x313ce567")) return { result: "0x" + (9).toString(16).padStart(64, "0") };
      if (data.startsWith("0xdd62ed3e")) return { result: "0x" + "0".repeat(64) }; // allowance = 0
      if (opts.simRevert) return { error: { code: 3, message: "execution reverted: slippage" } };
      return { result: "0x" };
    }
    if (body.method === "eth_sendRawTransaction") return { result: TX_HASH };
    if (body.method === "eth_getTransactionReceipt") return { result: RECEIPT_FIXTURE };
    return null;
  };
}

test("B1: an UNARMED EVM live swap is refused BEFORE any signature or broadcast", async () => {
  __resetCircuitBreaker();
  try {
    const { restore, log } = stubFetch(evmRpcStub([]));
    try {
      const a = new ExecutionAdapter(liveEnv({
        BASE_RPC_URL: "https://base-rpc.example",
        EVM_PRIVATE_KEY: EVM_KEY,
        ZEROX_API_KEY: "k",
        // EXECUTION_SIGNING_ENABLED deliberately absent
      }));
      const r = await a.execute(intent({
        chain: "base", token: MEME_BASE, id: "evm-unarmed-1", suggestedAmountUsd: 3,
      }));
      assert.equal(r.status, "failed");
      assert.match(r.reason ?? "", /EXECUTION_SIGNING_ENABLED!=true/);
      assert.match(r.reason ?? "", /EVM/);
      assert.equal(
        log.filter((c) => c.method === "eth_sendRawTransaction").length, 0,
        "nothing may be broadcast while the signer is unarmed",
      );
      assert.ok(log.some((c) => c.url.includes("api.0x.org")), "the router was armed — the quote was real");
    } finally {
      restore();
    }
  } finally {
    __resetCircuitBreaker();
  }
});

test("B1: an ARMED EVM swap walks allowance → approve → receipt → simulate → swap → receipt, THEN claims executed", async () => {
  __resetCircuitBreaker();
  try {
    const { restore, log } = stubFetch(evmRpcStub([]));
    try {
      const a = new ExecutionAdapter(liveEnv({
        BASE_RPC_URL: "https://base-rpc.example",
        EVM_PRIVATE_KEY: EVM_KEY,
        ZEROX_API_KEY: "k",
        EXECUTION_SIGNING_ENABLED: "true",
      }));
      const r = await a.execute(intent({
        chain: "base", token: MEME_BASE, id: "evm-armed-1", suggestedAmountUsd: 3,
      }));
      assert.equal(r.status, "executed");
      assert.equal(r.txHash, TX_HASH);
      assert.equal(r.amountOut, "1000000");
      assert.equal(r.gasUsed, 0x5208, "gasUsed comes from the RECEIPT, not the quote");

      const sig = log.filter((c) => c.method === "eth_sendRawTransaction");
      assert.equal(sig.length, 2, "exactly two broadcasts: the approve + the swap");
      // All indices are computed against the FULL call log (mixing filtered indices with full-log
      // indices would compare positions from different coordinate systems).
      const full = log;
      const allowanceIdx = full.findIndex(
        (c) => c.method === "eth_call" && String(c.body.params?.[0]?.data).startsWith("0xdd62ed3e"),
      );
      const simIdx = full.findIndex(
        (c) => c.method === "eth_call" && String(c.body.params?.[0]?.data).startsWith("0xdeadbeef"),
      );
      assert.ok(allowanceIdx >= 0, "the allowance was READ first");
      assert.ok(simIdx >= 0, "the B7 dress-rehearsal eth_call ran");
      const approveBroadcastIdx = full.findIndex((c) => c.method === "eth_sendRawTransaction");
      const swapBroadcastIdx = full.map((c) => c.method).lastIndexOf("eth_sendRawTransaction");
      assert.ok(allowanceIdx < approveBroadcastIdx, "approve is broadcast only after the allowance read");
      assert.ok(approveBroadcastIdx < simIdx, "the approval tx lands BEFORE the swap is even simulated");
      assert.ok(simIdx < swapBroadcastIdx, "the simulation gates the swap broadcast");
      const receipts = full.filter((c) => c.method === "eth_getTransactionReceipt");
      assert.ok(receipts.length >= 2, "both broadcasts were waited on");
    } finally {
      restore();
    }
  } finally {
    __resetCircuitBreaker();
  }
});

test("B7: a reverting simulation fails the intent BEFORE any broadcast (no gas burned)", async () => {
  __resetCircuitBreaker();
  try {
    const { restore, log } = stubFetch(evmRpcStub([], { simRevert: true }));
    try {
      const a = new ExecutionAdapter(liveEnv({
        BASE_RPC_URL: "https://base-rpc.example",
        EVM_PRIVATE_KEY: EVM_KEY,
        ZEROX_API_KEY: "k",
        EXECUTION_SIGNING_ENABLED: "true",
      }));
      // A token DISTINCT from the ARMED test's — lastTradeAt is module-level, and the previous
      // test's successful buy would otherwise put this one in cooldown (rejected ≠ the contract).
      const r = await a.execute(intent({
        chain: "base", token: "0xaaaa000000000000000000000000000000000002", id: "evm-simrevert-1", suggestedAmountUsd: 3,
      }));
      assert.equal(r.status, "failed");
      assert.match(r.reason ?? "", /revert|slippage|call/i);
      // In the 0x allowance-holder flow the APPROVE legitimately precedes the simulation (the
      // AllowanceHolder contract pulls the sell token during the swap — with zero allowance the
      // simulation would revert falsely). So exactly ONE broadcast (the reusable max-approve) may
      // appear, and NOTHING may be broadcast after the reverting simulation.
      const simIdx = log.findIndex(
        (c) => c.method === "eth_call" && String(c.body.params?.[0]?.data).startsWith("0xdeadbeef"),
      );
      const afterSim = log.slice(simIdx + 1).filter((c) => c.method === "eth_sendRawTransaction");
      assert.equal(afterSim.length, 0, "a revert in simulation must never reach the swap broadcast");
      assert.ok(
        log.filter((c) => c.method === "eth_sendRawTransaction").length <= 1,
        "only the approve precedes the simulation — never the swap",
      );
    } finally {
      restore();
    }
  } finally {
    __resetCircuitBreaker();
  }
});
