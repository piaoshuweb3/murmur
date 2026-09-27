// Wave-3 tests — B4: the Jupiter Ultra routing switch. All offline: fetch is stubbed into a router
// (the wave2 pattern), the signer runs for real (the P0-5 style). The contracts enforced here:
//   · OFF (the shipped default) routes a live Solana buy through the v1 lite-api path
//     (swap/v1/quote → swap/v1/swap) and NEVER touches the Ultra endpoints.
//   · ON routes the SAME intent through /ultra/v1/order → sign → /ultra/v1/execute and the
//     result carries Ultra's signature — the path the doc pre-built at adapter.ts (order→sign→execute).
//   · ON without an armed signer refuses BEFORE any Ultra request is made (P0-5 symmetry — an
//     unarmed operator must not burn an /order call).
//   · the test hook restores the default (false) so module state never leaks between files.

import test from "node:test";
import assert from "node:assert/strict";

import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

import { ExecutionAdapter, __resetCircuitBreaker, __setUltraRoute } from "./adapter.js";
import type { ExecutionIntent } from "./types.js";
import type { Env } from "../config.js";

// ---------- fixtures (the wave2/p0 shapes) ----------

const NOW = 1_800_000_000_000;
type Json = any;

function intent(over: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    id: "w3-intent-001",
    token: "W3Token1111111111111111111111111111111111",
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
    EXECUTION_REAL_SPEND: "true",
    EXECUTION_SHADOW: "false",
    EXECUTION_SIGNING_ENABLED: "true",
    SOLANA_RPC_URL: "https://rpc.example",
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

function jsonRes(payload: Json, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
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
  body: Json;
}

/** Routing fetch stub with a call log (which Jupiter surface was hit). */
function stubFetch(handler: (url: string, body: Json) => Json | null): {
  restore: () => void;
  log: CallRec[];
} {
  const log: CallRec[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = await bodyOf(init);
    log.push({ url: String(url), body });
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

/** A real keypair in both secret shapes + a REAL signable versioned tx whose payer matches it. */
function makeSecret(): { kp: Keypair; b58: string } {
  const kp = Keypair.generate();
  return { kp, b58: bs58.encode(kp.secretKey) };
}

function makeSwapTransactionB64(kp: Keypair): string {
  const ix = SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 0 });
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: bs58.encode(Buffer.alloc(32, 7)),
    instructions: [ix],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

/** A funded Solana wallet fixture: 50 USDC (the stablecoin the risk rails read as deployable). */
function fundedUsdcAccount() {
  return {
    result: {
      value: [
        {
          account: {
            data: {
              parsed: {
                info: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: { uiAmountString: "50" } },
              },
            },
          },
        },
      ],
    },
  };
}

// ============================= B4: the Ultra routing switch =============================

test("B4: OFF (the default) keeps the v1 lite-api route and never touches the Ultra endpoints", async () => {
  __resetCircuitBreaker();
  __setUltraRoute(false); // the shipped default, asserted EXPLICITLY
  const { kp, b58 } = makeSecret();
  const swapTx = makeSwapTransactionB64(kp);
  const onChainSig = bs58.encode(Buffer.alloc(64, 5));
  const { restore, log } = stubFetch((url, body) => {
    if (body.method === "getTokenAccountsByOwner") return fundedUsdcAccount(); // B2 fail-CLOSED needs a funded wallet
    if (url.includes("jup.ag/swap/v1/quote")) return { outAmount: "1000000" };
    if (url.includes("jup.ag/swap/v1/swap")) return { swapTransaction: swapTx };
    if (body.method === "simulateTransaction") return { result: { value: { err: null } } }; // B7 pre-check
    if (body.method === "sendTransaction") return { result: onChainSig };
    return null;
  });
  try {
    const adapter = new ExecutionAdapter(env({ SOLANA_PRIVATE_KEY: b58 }));
    const result = await adapter.execute(intent({ side: "buy", suggestedAmountUsd: 3, token: "W3OffToken111111111111111111111111111111" }));
    if (result.status !== "executed") console.error("[dbg-OFF]", JSON.stringify(result));
    assert.equal(result.status, "executed");
    const urls = log.map((c) => c.url);
    assert.ok(urls.some((u) => u.includes("jup.ag/swap/v1/quote")), "the v1 quote is fetched");
    assert.ok(urls.every((u) => !u.includes("ultra/v1/")), "no Ultra endpoint is touched while OFF");
  } finally {
    restore();
    __setUltraRoute(false);
  }
});

test("B4: ON routes the same intent through /ultra/v1/order → sign → /ultra/v1/execute", async () => {
  __resetCircuitBreaker();
  __setUltraRoute(true);
  const { kp, b58 } = makeSecret();
  const orderTx = makeSwapTransactionB64(kp); // what Ultra's /order hands back (a real signable tx)
  const ultraSig = bs58.encode(Buffer.alloc(64, 6));
  const { restore, log } = stubFetch((url, body) => {
    if (body.method === "getTokenAccountsByOwner") return fundedUsdcAccount(); // B2 fail-CLOSED needs a funded wallet
    if (url.includes("ultra/v1/order")) {
      return { transaction: orderTx, requestId: "req-w3-001", outAmount: "990000" };
    }
    if (url.includes("ultra/v1/execute")) return { status: "Success", signature: ultraSig };
    return null; // any v1/RPC call here is a ROUTING BUG — fail the transport loudly
  });
  try {
    const adapter = new ExecutionAdapter(env({ SOLANA_PRIVATE_KEY: b58 }));
    const result = await adapter.execute(intent({ side: "buy", suggestedAmountUsd: 3, token: "W3UltraToken111111111111111111111111111111" }));
    assert.equal(result.status, "executed");
    assert.equal(result.txHash, ultraSig, "Ultra's hosted-broadcast signature lands in the audit log");
    const urls = log.map((c) => c.url);
    assert.ok(urls.some((u) => u.includes("ultra/v1/order")), "the Ultra order is fetched");
    assert.ok(urls.some((u) => u.includes("ultra/v1/execute")), "the signed order is executed");
    assert.ok(urls.every((u) => !u.includes("swap/v1/")), "the v1 path is fully bypassed while ON");
    // the execute body must carry OUR signature of Ultra's transaction (the real signing step ran)
    const execCall = log.find((c) => c.url.includes("ultra/v1/execute"));
    assert.ok(execCall?.body?.signedTransaction, "the execute call carries a signedTransaction");
    assert.equal(execCall.body.requestId, "req-w3-001");
  } finally {
    restore();
    __setUltraRoute(false);
  }
});

test("B4: ON without an armed signer refuses BEFORE any Ultra request (P0-5 symmetry)", async () => {
  __resetCircuitBreaker();
  __setUltraRoute(true);
  const { b58 } = makeSecret(); // a VALID key so the portfolio read succeeds — only the signer flag is off
  const { restore, log } = stubFetch((_url, body) =>
    body.method === "getTokenAccountsByOwner" ? fundedUsdcAccount() : null, // a funded wallet so the RAILS pass; any other call is a failure
  );
  try {
    const adapter = new ExecutionAdapter(
      env({ EXECUTION_SIGNING_ENABLED: "false", SOLANA_PRIVATE_KEY: b58 }), // signer disarmed, wallet funded
    );
    // the arm check's throw is CONVERTED by execute()'s audit wrapper into a "failed" result
    // (the B6 contract: live failures land in the audit log, they never escape as exceptions) —
    // assert on the resolved shape, not on a rejection.
    const result = await adapter.execute(intent({ side: "buy", suggestedAmountUsd: 3, token: "W3ArmToken111111111111111111111111111111" }));
    assert.equal(result.status, "failed", "the intent fails");
    assert.match(result.reason || "", /EXECUTION_SIGNING_ENABLED/, "the reason names the unarmed signer");
    assert.ok(
      log.every((c) => !c.url.includes("ultra/v1/")),
      "zero Ultra calls — an unarmed operator burns no /order request (the only fetch is the portfolio read)",
    );
  } finally {
    restore();
    __setUltraRoute(false);
  }
});
