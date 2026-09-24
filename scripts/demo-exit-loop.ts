// demo-exit-loop.ts — P0-1 + P2-1 integration walkthrough on the REAL code paths.
//
// This is a demo/verification script (NOT part of the worker): it drives
//   real meme signal (spike) → buildExternalIntents → ExecutionAdapter.execute (SHADOW)
//   → PositionBook.openFromFill → LIVE DexScreener marks → evaluateExit → sell intent
//   → ExecutionAdapter.execute (SHADOW) → PositionBook.closeFromFill → realised P&L
// with REAL_SPEND=false everywhere (paper fills only), proving the §7 P2-1 acceptance
// "shadow 下完整买卖闭环" end-to-end. The marks limb is genuinely LIVE (keyless DexScreener).
//
// Run: npx tsx scripts/demo-exit-loop.ts

import { buildExternalIntents } from "../packages/trader-worker/src/execution/intents.js";
import { ExecutionAdapter } from "../packages/trader-worker/src/execution/adapter.js";
import { PositionBook } from "../packages/trader-worker/src/execution/positions.js";
import { evaluateExit, buildExitIntents, exitRulesFromEnv, fetchTokenMarks } from "../packages/trader-worker/src/execution/exits.js";
import type { MemeSnapshot } from "../packages/trader-worker/src/meme/types.js";

// A real Solana mint so the marks limb exercises the live DexScreener feed (WIF).
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

const env: Record<string, string> = {
  MEME_ENABLED: "true",
  EXECUTION_ENABLED: "true",
  EXECUTION_REAL_SPEND: "false", // KILL SWITCH: paper only, by design
  EXECUTION_SHADOW: "true",
  MAX_DAILY_VOLUME_USDC: "50",
  MAX_PER_TRADE_USDC: "5",
  MIN_CONFIDENCE: "0.45",
  MAX_SLIPPAGE_BPS: "150",
  TRADE_COOLDOWN_SECONDS: "0",
  // exit rails: shrink the TP so the demo's real mark trips an exit deterministically
  EXIT_TAKE_PROFIT_PCT: "0.001",
  EXIT_STOP_LOSS_PCT: "0.2",
  EXIT_TRAILING_STOP_PCT: "0.15",
  EXIT_MAX_HOLD_MIN: "360",
  EXIT_MAX_PER_TICK: "3",
};

const flyReadings = [
  { id: 1, arousal: 0.9, state: "EXPLORE" as const },
  { id: 2, arousal: 0.85, state: "AGITATE" as const },
  { id: 3, arousal: 0.8, state: "EXPLORE" as const },
];

// A meme snapshot as the Helius/DexScreener providers would produce it on a real spike
// (score is risk-discounted by the detectors; here we take the post-detector result).
const meme: MemeSnapshot = {
  overallHeat: 0.8,
  regime: "PUMP",
  topSignals: [{
    token: WIF,
    chain: "solana",
    score: 0.72,
    reasons: ["volumeSpike 78%", "price velocity"],
    liquidityUsd: 8_500_000,
    holderConcentration: 0.18,
    priceUsd: undefined, // the entry price is filled by the live mark below
  }],
  raw: { launchHeat: 0.6, volumeSpike: 0.78, smartMoneyFlow: 0.5, socialMomentum: 0.4, liquidityHealth: 1 },
};

const say = (s: string) => console.log(`\n▶ ${s}`);

async function main() {
  say("STEP 1 — swarm read-out votes on the meme channel's top signal");
  const intents = buildExternalIntents(flyReadings, meme, env as never);
  if (intents.length === 0) throw new Error("no intents built — check the funnel");
  const buy = intents[0];
  console.log(`  buy intent: ${buy.token.slice(0, 8)}… conf=${buy.confidence.toFixed(2)} size≤$${buy.suggestedAmountUsd?.toFixed(2)} slippage=${buy.maxSlippageBps}bps`);

  say("STEP 2 — ExecutionAdapter: risk rails evaluate, then SHADOW (paper) fill");
  const adapter = new ExecutionAdapter(env as never);
  const buyResult = await adapter.execute(buy);
  console.log(`  result: status=${buyResult.status} reason=${buyResult.reason} amountUsd=${buyResult.amountUsd}`);

  say("STEP 3 — PositionBook opens the paper position (cost basis = entry price × fill)");
  const book = new PositionBook();
  book.openFromFill(buy, buyResult);
  console.log("  position:", JSON.stringify(book.serialize()[0], null, 1));

  say("STEP 4 — LIVE marks feed (keyless DexScreener) prices the book");
  const marks = await fetchTokenMarks([{ token: WIF, chain: "solana" }]);
  const mark = marks.get(WIF);
  console.log(`  live mark for WIF: priceUsd=${mark?.priceUsd} liquidityUsd=${mark?.liquidityUsd ? Math.round(mark.liquidityUsd) : "?"}`);

  say("STEP 5 — exit rules evaluate the marked position (TP shrunk to ~0 for the demo)");
  const rules = exitRulesFromEnv(env);
  // Give the position an entry price so the price-based rules can fire: use the LIVE mark as entry.
  const pos = book.get("solana", WIF);
  if (pos && mark?.priceUsd) {
    pos.entryPriceUsd = mark.priceUsd;
    pos.tokenAmount = pos.entryUsd / mark.priceUsd;
    pos.peakPriceUsd = mark.priceUsd * 1.2; // pretend it ran up 20% since entry
    pos.lastMarkUsd = mark.priceUsd;
  }
  const exitDecision = evaluateExit(book.get("solana", WIF)!, rules, Date.now(), mark ?? {});
  console.log(`  exit decision: ${exitDecision.exit ? exitDecision.reason : "hold"}`);

  say("STEP 6 — build the sell intent, execute through the SAME adapter path (shadow)");
  const sellIntents = buildExitIntents(book, marks, { ...rules, takeProfitPct: exitDecision.exit ? rules.takeProfitPct : 0.001 }, Date.now());
  if (sellIntents.length === 0) throw new Error("no sell intent minted");
  const sell = sellIntents[0];
  console.log(`  sell intent: ${sell.token.slice(0, 8)}… note="${sell.note}" fullSize=$${sell.suggestedAmountUsd?.toFixed(2)}`);
  const sellResult = await adapter.execute(sell);
  console.log(`  result: status=${sellResult.status} reason=${sellResult.reason}`);

  say("STEP 7 — PositionBook closes the position and reports realised P&L");
  const pnl = book.closeFromFill(sell, sellResult);
  console.log(`  realised P&L: ${pnl == null ? "unknown" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USD (paper)`}`);
  console.log(`  open positions remaining: ${book.size}`);

  say("DONE — the buy → position → mark → exit → close loop is closed (REAL_SPEND=false throughout)");
}

main().catch((e) => { console.error("demo failed:", e); process.exit(1); });
