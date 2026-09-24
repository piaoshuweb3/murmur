// P0-3 (dynamic decimals) + P0-5 (Solana signing) tests — entirely offline.
//
// Contracts enforced here:
//   · decimals resolution: Helius → generic RPC → curated table → NULL (never a guess)
//   · the P0-3 HARD GATE: a live sell with unverified decimals FAILS with the exact gate reason
//   · exits carry exact raw sell amounts when decimals are verified (ledger × 10^dec)
//   · the P0-5 signing path: key loading (base58 + JSON array), deterministic VersionedTransaction
//     signing, the 4th arming flag (EXECUTION_SIGNING_ENABLED) blocking BEFORE any signature
//   · an armed live buy walks quote → build → sign → broadcast end-to-end against a stubbed RPC

import test from "node:test";
import assert from "node:assert/strict";

import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

import { ExecutionAdapter } from "./adapter.js";
import { buildExitIntents, DEFAULT_EXIT_RULES } from "./exits.js";
import { PositionBook } from "./positions.js";
import { getTokenDecimals, toRawAmount, resetDecimalsCache } from "./decimals.js";
import { loadKeypairFromSecret, signVersionedSwap, signingArmed } from "./solana-signer.js";
import type { Env } from "../config.js";
import type { ExecutionIntent, ExecutionResult } from "./types.js";

// ---------- fixtures ----------

const NOW = 1_800_000_000_000;
type EnvRec = Record<string, string | undefined>;
type Json = Record<string, unknown>;

/** Minimal JSON response for stubbed fetch calls. */
function jsonRes(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Read the (JSON) body of a stubbed RequestInit. */
async function bodyOf(init: RequestInit | undefined): Promise<Json> {
  try {
    return JSON.parse(String(init?.body ?? "{}")) as Json;
  } catch {
    return {};
  }
}

/** A random valid 64-byte secret in both export shapes + its keypair. */
function makeSecret(): { kp: Keypair; b58: string; jsonArray: string } {
  const kp = Keypair.generate();
  return {
    kp,
    b58: bs58.encode(kp.secretKey),
    jsonArray: JSON.stringify(Array.from(kp.secretKey)),
  };
}

/** A REAL (offline-serialisable) VersionedTransaction: self-transfer of 0 lamports, dummy blockhash.
 *  Takes the keypair so the payer MATCHES whoever will sign — web3.js refuses a signer that is not
 *  a required signer of the message ("Cannot sign with non signer key"). */
function makeSwapTransactionB64(kp: Keypair): string {
  const ix = SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 0 });
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: bs58.encode(Buffer.alloc(32, 7)),
    instructions: [ix],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
}

function env(over: EnvRec = {}): Env {
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

function intent(over: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    id: "test-intent-p0",
    token: bs58.encode(Buffer.alloc(32, 9)), // a valid but UNKNOWN mint (never in the curated table)
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

/** Swap global fetch for a routing stub; returns a restore fn. Handlers may return null = 500. */
function stubFetch(
  handler: (url: string, body: Json) => Json | null,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = await bodyOf(init);
    const payload = handler(String(url), body);
    if (payload === null) return jsonRes({ error: "stubbed transport failure" }, 500);
    return jsonRes(payload);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ============================= P0-3: decimals resolution =============================

test("P0-3: Helius getTokenSupply is the primary decimals source (and caches)", async () => {
  resetDecimalsCache();
  let calls = 0;
  const restore = stubFetch((_url, body) => {
    if (body.method === "getTokenSupply") {
      calls++;
      return { result: { value: { decimals: 7, amount: "10000000", uiAmount: 10 } } };
    }
    return null;
  });
  try {
    const e = env({ HELIUS_API_KEY: "k" });
    const first = await getTokenDecimals("solana", "Mint111111111111111111111111111111111111111", e);
    assert.equal(first?.decimals, 7);
    assert.equal(first?.source, "helius");
    await getTokenDecimals("solana", "Mint111111111111111111111111111111111111111", e);
    assert.equal(calls, 1, "second lookup must come from the immutable-mint cache");
  } finally {
    restore();
  }
});

test("P0-3: falls back to the generic RPC when no Helius key is wired", async () => {
  resetDecimalsCache();
  const restore = stubFetch((_url, body) =>
    body.method === "getTokenSupply" ? { result: { value: { decimals: 9 } } } : null,
  );
  try {
    const info = await getTokenDecimals("solana", "Mint222222222222222222222222222222222222222", env({ SOLANA_RPC_URL: "https://rpc.example" }));
    assert.equal(info?.decimals, 9);
    assert.equal(info?.source, "rpc");
  } finally {
    restore();
  }
});

test("P0-3: curated known-mints table is the last resort; unknown mints resolve to null", async () => {
  resetDecimalsCache();
  const restore = stubFetch(() => null); // every transport dead
  try {
    const usdc = await getTokenDecimals("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", env({}));
    assert.equal(usdc?.decimals, 6);
    assert.equal(usdc?.source, "known");
    const unknown = await getTokenDecimals("solana", "Mint333333333333333333333333333333333333333", env({}));
    assert.equal(unknown, null, "unverified decimals MUST be null — the gate's whole point");
  } finally {
    restore();
  }
});

test("P0-3: EVM decimals via eth_call, with the curated table as the keyless fallback", async () => {
  resetDecimalsCache();
  const restore = stubFetch((_url, body) =>
    body.method === "eth_call" ? { result: "0x12" } : null, // 0x12 = 18
  );
  try {
    const viaRpc = await getTokenDecimals("base", "0xabc0000000000000000000000000000000000001", env({ BASE_RPC_URL: "https://base-rpc.example" }));
    assert.equal(viaRpc?.decimals, 18);
    assert.equal(viaRpc?.source, "evm-rpc");
  } finally {
    restore();
  }
  resetDecimalsCache();
  const known = await getTokenDecimals("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", env({}));
  assert.equal(known?.decimals, 6);
  assert.equal(known?.source, "known");
});

test("P0-3: toRawAmount converts human units exactly (and rejects garbage)", () => {
  assert.equal(toRawAmount(2.5, 9), "2500000000");
  assert.equal(toRawAmount(1.23456, 5), "123456");
  assert.equal(toRawAmount(0, 6), "0");
  assert.equal(toRawAmount(-1, 6), "0");
  assert.equal(toRawAmount(Number.NaN, 9), "0");
});

// ============================= P0-3: exact sell sizing at the source =============================

test("P0-3: exit intents carry the EXACT raw amount when decimals are verified", () => {
  const MINT = "Mint444444444444444444444444444444444444444";
  const book = new PositionBook();
  book.openFromFill(
    { ...intent({ token: MINT, side: "buy", suggestedAmountUsd: 10, entryPriceUsd: 0.5 }) },
    { status: "shadow", intentId: "b1", amountUsd: 10, timestamp: NOW } as ExecutionResult,
  );
  assert.equal(book.get("solana", MINT)?.tokenAmount, 20); // 10 USD / 0.5 USD

  const rules = { ...DEFAULT_EXIT_RULES, maxHoldMs: 1_000 }; // force the TIME exit
  const exits = buildExitIntents(book, new Map(), rules, NOW + 10_000, new Map([[MINT, 9]]));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].sellTokenAmount, "20000000000", "20 tokens × 10^9, exact");
  assert.match(exits[0].note ?? "", /raw=20000000000 \(dec=9\)/);
});

test("P0-3: unverified decimals ⇒ intent WITHOUT raw amount (the adapter gate decides)", () => {
  const MINT = "Mint555555555555555555555555555555555555555";
  const book = new PositionBook();
  book.openFromFill(
    { ...intent({ token: MINT, side: "buy", suggestedAmountUsd: 10, entryPriceUsd: 0.5 }) },
    { status: "shadow", intentId: "b2", amountUsd: 10, timestamp: NOW } as ExecutionResult,
  );
  const rules = { ...DEFAULT_EXIT_RULES, maxHoldMs: 1_000 };
  const exits = buildExitIntents(book, new Map(), rules, NOW + 10_000);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].sellTokenAmount, undefined);
  assert.match(exits[0].note ?? "", /decimals unverified/);
});

// ============================= P0-3: the LIVE hard gate =============================

test("P0-3 GATE: a live sell with unverified decimals FAILS with the gate reason", async () => {
  resetDecimalsCache();
  const { b58 } = makeSecret();
  const restore = stubFetch((_url, body) =>
    body.method === "getTokenSupply" ? { result: { value: null } } : null,
  );
  try {
    const adapter = new ExecutionAdapter(env({
      EXECUTION_REAL_SPEND: "true",
      EXECUTION_SHADOW: "false",
      SOLANA_RPC_URL: "https://rpc.example",
      SOLANA_PRIVATE_KEY: b58,
    }));
    const result = await adapter.execute(intent({
      token: bs58.encode(Buffer.alloc(32, 11)),
      side: "sell",
      suggestedAmountUsd: 2,
      confidence: 1,
      strength: 1,
    }));
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /P0-3 GATE/);
    assert.match(result.reason ?? "", /decimals unverified/);
  } finally {
    restore();
  }
});

// ============================= P0-5: keypair + signing =============================

test("P0-5: key loading accepts base58 AND JSON byte arrays; rejects seeds and garbage", () => {
  const { kp, b58, jsonArray } = makeSecret();
  const fromB58 = loadKeypairFromSecret(b58);
  const fromJson = loadKeypairFromSecret(jsonArray);
  assert.ok(fromB58.publicKey.equals(kp.publicKey));
  assert.ok(fromJson.publicKey.equals(kp.publicKey));

  assert.throws(() => loadKeypairFromSecret(""), /empty/);
  assert.throws(() => loadKeypairFromSecret("not-base58!!!"), /neither valid base58/);
  assert.throws(() => loadKeypairFromSecret(bs58.encode(Buffer.alloc(32, 1))), /64 bytes/); // seed-only
  assert.throws(() => loadKeypairFromSecret(JSON.stringify(Array.from(kp.secretKey).slice(0, 63))), /64 bytes/);
});

test("P0-5: signVersionedSwap is deterministic and matches web3.js's own signing", () => {
  const { kp, b58 } = makeSecret();
  const txB64 = makeSwapTransactionB64(kp);
  const signed = signVersionedSwap(b58, txB64);

  const direct = VersionedTransaction.deserialize(Buffer.from(txB64, "base64"));
  direct.sign([kp]);
  const directB64 = Buffer.from(direct.serialize()).toString("base64");

  assert.equal(signed.signedB64, directB64, "ed25519 is deterministic — identical bytes");
  assert.equal(signed.signature, bs58.encode(direct.signatures[0]));
  assert.ok(signed.publicKey.length >= 32);
});

test("P0-5: signingArmed requires the explicit EXECUTION_SIGNING_ENABLED flag", () => {
  assert.equal(signingArmed({}), false);
  assert.equal(signingArmed({ EXECUTION_SIGNING_ENABLED: "false" }), false);
  assert.equal(signingArmed({ EXECUTION_SIGNING_ENABLED: "true" }), true);
});

// ============================= P0-5: the live path, end to end (stubbed) =============================

test("P0-5: an UNARMED live buy walks quote+build fully, then refuses BEFORE any signature", async () => {
  resetDecimalsCache();
  const { kp, b58 } = makeSecret();
  const swapTx = makeSwapTransactionB64(kp);
  const restore = stubFetch((url, body) => {
    if (url.includes("jup.ag/swap/v1/quote")) return { outAmount: "1000000" };
    if (url.includes("jup.ag/swap/v1/swap")) return { swapTransaction: swapTx };
    if (body.method === "sendTransaction") return { result: bs58.encode(Buffer.alloc(64, 3)) };
    return null;
  });
  try {
    const adapter = new ExecutionAdapter(env({
      EXECUTION_REAL_SPEND: "true",
      EXECUTION_SHADOW: "false",
      SOLANA_RPC_URL: "https://rpc.example",
      SOLANA_PRIVATE_KEY: b58,
    }));
    const result = await adapter.execute(intent({ side: "buy", suggestedAmountUsd: 3 }));
    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /EXECUTION_SIGNING_ENABLED!=true/);
    assert.match(result.reason ?? "", /P0-5/);
  } finally {
    restore();
  }
});

test("P0-5: an ARMED live buy walks quote → build → sign → broadcast end-to-end", async () => {
  resetDecimalsCache();
  const { kp, b58 } = makeSecret();
  const swapTx = makeSwapTransactionB64(kp);
  const onChainSig = bs58.encode(Buffer.alloc(64, 5));
  const restore = stubFetch((url, body) => {
    if (url.includes("jup.ag/swap/v1/quote")) return { outAmount: "1000000" };
    if (url.includes("jup.ag/swap/v1/swap")) return { swapTransaction: swapTx };
    if (body.method === "sendTransaction") return { result: onChainSig };
    return null;
  });
  try {
    const adapter = new ExecutionAdapter(env({
      EXECUTION_REAL_SPEND: "true",
      EXECUTION_SHADOW: "false",
      EXECUTION_SIGNING_ENABLED: "true",
      SOLANA_RPC_URL: "https://rpc.example",
      SOLANA_PRIVATE_KEY: b58,
    }));
    const result = await adapter.execute(intent({ side: "buy", suggestedAmountUsd: 3 }));
    assert.equal(result.status, "executed");
    assert.equal(result.txHash, onChainSig, "the REAL broadcast signature lands in the audit log");
    assert.equal(result.amountIn, "3000000", "USDC stays 6 decimals — a constant, not an assumption");
  } finally {
    restore();
  }
});
