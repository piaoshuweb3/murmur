// scripts/devnet-sign-test.ts — P0-5 acceptance: "devnet 试签成功".
//
// Proves the WHOLE Solana signing path against Solana DEVNET without ever touching mainnet funds:
//
//   1. Load a keypair: from SOLANA_PRIVATE_KEY (the real execution secret, base58 or JSON array) or
//      an ephemeral one when unset — the test never needs a funded wallet.
//   2. Fetch a REAL devnet blockhash and build a REAL VersionedTransaction (0-SOL self-transfer).
//   3. Sign it with execution/solana-signer.ts (the EXACT code the live adapter calls).
//   4. Verify determinism: re-sign with raw @solana/web3.js — the bytes must be identical.
//   5. RPC simulates the signed tx with sigVerify:true — devnet CRYPTOGRAPHICALLY checks our
//      signature. An invalid signature yields a sigverify error; a valid one yields (at worst) a
//      funds error — which still proves the signature landed correctly.
//   6. Best-effort: airdrop → send → confirm, so a lucky run (airdrop not rate-limited) also proves
//      LANDING, not just signing.
//
// Run:  npx tsx scripts/devnet-sign-test.ts
//       SOLANA_PRIVATE_KEY=<base58> npx tsx scripts/devnet-sign-test.ts   # test YOUR real key shape
// Exit code 0 = PASS.

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { loadKeypairFromSecret, signVersionedSwap, broadcastTransaction } from "../src/execution/solana-signer.js";

const DEVNET = "https://api.devnet.solana.com";
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const fail = (msg: string) => {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
};

async function main(): Promise<void> {
  console.log("== P0-5 devnet sign test ==");

  // ---- 1. keypair ----
  const secret = process.env.SOLANA_PRIVATE_KEY?.trim();
  const kp = secret ? loadKeypairFromSecret(secret) : Keypair.generate();
  console.log(
    secret
      ? `  wallet: from SOLANA_PRIVATE_KEY (${kp.publicKey.toBase58()})`
      : `  wallet: ephemeral (${kp.publicKey.toBase58()}) — set SOLANA_PRIVATE_KEY to test your real key`,
  );

  const connection = new Connection(DEVNET, "confirmed");

  // ---- 2. REAL devnet blockhash + REAL VersionedTransaction ----
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  ok(`devnet blockhash ${blockhash.slice(0, 12)}… (valid to height ${lastValidBlockHeight})`);
  const ix = SystemProgram.transfer({
    fromPubkey: kp.publicKey,
    toPubkey: kp.publicKey,
    lamports: 0n as unknown as number, // web3.js v1.98 accepts bigint lamports; 0 = zero-value tx
  });
  const message = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const txB64 = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

  // ---- 3. sign via the PRODUCTION signer module ----
  const signed = signVersionedSwap(secret ?? bs58.encode(kp.secretKey), txB64);
  ok(`signed by ${signed.publicKey} — signature ${signed.signature.slice(0, 16)}…`);

  // ---- 4. determinism vs raw web3.js ----
  const direct = VersionedTransaction.deserialize(Buffer.from(txB64, "base64"));
  direct.sign([kp]);
  if (Buffer.from(direct.serialize()).toString("base64") === signed.signedB64) {
    ok("determinism: signer output is byte-identical to raw @solana/web3.js signing");
  } else {
    fail("determinism: signer output DIFFERS from raw web3.js signing");
  }

  // ---- 5. devnet sigVerify simulation (cryptographic proof, no funds needed) ----
  try {
    const sim = await connection.simulateTransaction(
      VersionedTransaction.deserialize(Buffer.from(signed.signedB64, "base64")),
      { sigVerify: true, replaceRecentBlockhash: false },
    );
    if (sim.value.err) {
      const errStr = JSON.stringify(sim.value.err);
      if (/signature/i.test(errStr)) {
        fail(`devnet REJECTED the signature: ${errStr}`);
      } else {
        ok(`signature VERIFIED by devnet (simulation stops later on funds/account — expected: ${errStr})`);
      }
    } else {
      ok("devnet simulated the signed tx END-TO-END with sigVerify — zero errors");
    }
    for (const l of sim.value.logs ?? []) console.log(`      ${l}`);
  } catch (e) {
    fail(`devnet simulateTransaction failed: ${(e as Error).message}`);
  }

  // ---- 6. best-effort airdrop + broadcast + confirm ----
  try {
    const balance = await connection.getBalance(kp.publicKey);
    if (balance < LAMPORTS_PER_SOL / 100) {
      console.log("  …airdrop 0.05 SOL (best-effort; devnet faucets are rate-limited)");
      const airdropSig = await connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL / 20);
      await connection.confirmTransaction({ signature: airdropSig, blockhash, lastValidBlockHeight }, "confirmed");
    }
    const sig = await broadcastTransaction(DEVNET, signed.signedB64, { skipPreflight: false, maxRetries: 3 });
    const status = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (status.value.err) {
      fail(`broadcast landed but the tx errored on-chain: ${JSON.stringify(status.value.err)}`);
    } else {
      ok(`BROADCAST + CONFIRMED on devnet: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    }
  } catch (e) {
    console.log(`  …broadcast skipped (${(e as Error).message.split("\n")[0]}) — signing itself is ALREADY proven by step 5`);
  }

  console.log(process.exitCode === 1 ? "== P0-5 devnet sign test: FAIL ==" : "== P0-5 devnet sign test: PASS ==");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
