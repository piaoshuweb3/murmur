// execution/solana-signer.ts — the Solana signing path (P0-5: Keypair + VersionedTransaction).
//
// This module is the ONLY place a Solana transaction is ever signed. It exists so the adapter's live
// path can go from "Jupiter returned a base64 VersionedTransaction" to "signed + broadcast" without
// half-measures, and so the signing capability itself is a DELIBERATE, separately-armed operation:
//
//   · The adapter refuses to broadcast unless EXECUTION_SIGNING_ENABLED === "true" (the 4th flag of
//     the multi-flag live operation: ENABLED + REAL_SPEND + !SHADOW + SIGNING_ENABLED).
//   · The signer is inert by construction: it never fetches, never builds intents, never decides —
//     sign what you are given, broadcast where you are told.
//   · Secrets are accepted in BOTH wallet-export shapes: base58 (64-byte secret key, Phantom/Solflare
//     "private key" field) or a JSON byte array (the solana-keygen / solana-cli export format).
//
// Accepted live-path flow (adapter.solanaSwap):
//   quote → build → signVersionedSwap() → broadcastTransaction() → signature lands in the D1 audit log.
// Shadow/devnet flows never call this module from the adapter — the devnet self-test script does,
// which is exactly how P0-5's acceptance ("devnet 试签成功") is proven without touching mainnet funds.

import {
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import type { FetchImpl } from "./decimals.js";

// Workers-native base64 ↔ bytes (NO Node Buffer: this repo compiles against @cloudflare/workers-types,
// and atob/btoa exist in BOTH Workers and Node ≥16 — zero polyfill needed).
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000; // String.fromCharCode has an argument-count ceiling — convert in chunks
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export type SigningEnv = Record<string, string | undefined>;

/** The 4th arming flag — without it the adapter throws BEFORE any signature is produced. */
export function signingArmed(env: SigningEnv): boolean {
  return env.EXECUTION_SIGNING_ENABLED === "true";
}

/**
 * Load the DEDICATED execution wallet. Accepts:
 *   · base58 64-byte secret key   (Phantom / Solflare export, bs58)
 *   · JSON byte array             (solana-keygen pubkey/`cat id.json` style, 64 bytes)
 * A 32-byte value (seed-only) is REJECTED: the adapter needs the full keypair to sign.
 */
export function loadKeypairFromSecret(secret: string): Keypair {
  const s = (secret ?? "").trim();
  if (!s) throw new Error("SOLANA_PRIVATE_KEY is empty");
  if (s.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(s);
    } catch {
      throw new Error("SOLANA_PRIVATE_KEY looks like a JSON array but does not parse");
    }
    if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error(`SOLANA_PRIVATE_KEY JSON array must be 64 bytes 0..255 (got ${
        Array.isArray(arr) ? arr.length : "non-array"
      })`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr as number[]));
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(s);
  } catch {
    throw new Error("SOLANA_PRIVATE_KEY is neither valid base58 nor a JSON byte array");
  }
  if (decoded.length !== 64) {
    throw new Error(`SOLANA_PRIVATE_KEY must decode to 64 bytes (got ${decoded.length}); seed-only 32-byte keys are not accepted`);
  }
  return Keypair.fromSecretKey(decoded);
}

export interface SignedSwap {
  signedB64: string;    // ready for sendRawTransaction / Jupiter Ultra /execute
  signature: string;    // base58 tx signature (= the txHash explorers show)
  publicKey: string;    // the signer's base58 pubkey (audit trail)
}

/**
 * Sign ONE base64 VersionedTransaction (the shape Jupiter v1 /swap and Ultra /order return).
 * Pure and local: no network, no broadcast — the caller owns what happens next.
 */
export function signVersionedSwap(secret: string, swapTransactionB64: string): SignedSwap {
  const keypair = loadKeypairFromSecret(secret);
  if (!swapTransactionB64) throw new Error("no swapTransaction to sign");
  const tx = VersionedTransaction.deserialize(fromBase64(swapTransactionB64));
  tx.sign([keypair]);
  const signedB64 = toBase64(tx.serialize());
  const signature = bs58.encode(tx.signatures[0]);
  return { signedB64, signature, publicKey: keypair.publicKey.toBase58() };
}

export interface BroadcastOptions {
  skipPreflight?: boolean; // default false — preflight failures are cheaper than landed failures
  maxRetries?: number;     // default 3 (RPC-level rebroadcast of the SAME signed tx, no re-signing)
  commitment?: string;     // default "confirmed" (preflightCommitment)
}

/**
 * Broadcast a signed VersionedTransaction (base64) via a RAW sendTransaction JSON-RPC call and return
 * the signature. The tx is ALREADY signed — this call cannot alter amounts, routes or destinations.
 *
 * WHY raw JSON-RPC instead of web3.js Connection.sendRawTransaction: web3.js binds its fetch client
 * at MODULE-LOAD time (node-fetch fallback / globalThis.fetch snapshot), so a request-scoped or
 * test-scoped fetch stub can never intercept it — broadcasts would escape every seam. The raw call
 * keeps the same wire contract (encoding "base64", skipPreflight, maxRetries, preflightCommitment)
 * while staying fully injectable. Signing itself (Keypair/VersionedTransaction) remains web3.js —
 * those paths are pure-local and need no network.
 */
export async function broadcastTransaction(
  rpc: string,
  signedB64: string,
  opts: BroadcastOptions = {},
  fetchImpl: FetchImpl = (...args) => fetch(...(args as Parameters<typeof fetch>)),
): Promise<string> {
  const res = await fetchImpl(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [
        signedB64,
        {
          encoding: "base64",
          skipPreflight: opts.skipPreflight ?? false,
          maxRetries: opts.maxRetries ?? 3,
          preflightCommitment: opts.commitment ?? "confirmed",
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`sendTransaction failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error) throw new Error(`sendTransaction RPC error: ${body.error.message ?? "unknown"}`);
  if (typeof body.result !== "string" || body.result.length < 32) {
    throw new Error("sendTransaction returned no signature");
  }
  return body.result;
}
