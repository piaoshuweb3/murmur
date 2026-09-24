// execution/types.ts — the contract types for the external execution layer (the 二次开发 spec).
//
// This layer is the ONLY place allowed to turn neural intent into real third-party DEX trades. It
// sits strictly DOWNSTREAM of the neural population and the internal x402 economy (a one-directional
// read-out that never feeds back), and behind hard feature flags: with the shipped defaults it can
// never move money (EXECUTION_ENABLED=false; even enabled, REAL_SPEND=false + SHADOW=true record
// paper trades only).

export type ExecChain = "solana" | "base" | "eth" | "arc";
export type ExecSide = "buy" | "sell";
export type ExecutionStatus = "executed" | "shadow" | "rejected" | "failed";

/**
 * One external trade intent, minted by execution/intents.ts from the swarm's neural read-out
 * (top-arousal EXPLORE/AGITATE flies voting on the meme channel's top signals) — or by the exit
 * layer (execution/exits.ts) when an open position hits its stop/exit rules.
 */
export interface ExecutionIntent {
  id: string;                 // unique intent id ("ext-<ts>-<token6>" buys / "ext-<ts>-exit-<token6>" sells)
  token: string;              // token contract / mint address
  chain: ExecChain;
  side: ExecSide;             // buy = entries (intents.ts) · sell = exits (exits.ts)
  strength: number;           // 0..1 — mean arousal of the voting flies (1 for machine exits)
  confidence: number;         // 0..1 — signal score × arousal blend (the risk gate); exits send 1
  maxSlippageBps: number;     // e.g. 150 = 1.5% (exits default wider — 300 — meme books are thin)
  deadline: number;           // unix seconds after which the intent is void
  sourceFlyIds: number[];     // which flies voted for this intent ([] for machine-generated exits)
  suggestedAmountUsd?: number;// optional size suggestion from the intent builder
  // Pool-quality metadata carried from the producing MemeSignal (optional; the risk gates use them
  // when present — an intent without metadata just skips those two gates).
  liquidityUsd?: number;
  holderConcentration?: number;
  // --- v2 extensions (sell/exit path) ---
  entryPriceUsd?: number;     // buys: the signal's mark price at mint time (the PositionBook's cost basis)
  sellTokenAmount?: string;   // sells: RAW token units to sell (from the position ledger; without it
                              // the adapter falls back to the USD→6-decimals assumption = P0-3's gate)
  note?: string;              // machine-generated provenance, e.g. "exit: stop-loss -23.4%"
}

/** The terminal record of one intent's journey through evaluate → execute. */
export interface ExecutionResult {
  status: ExecutionStatus;
  intentId: string;
  txHash?: string;
  amountIn?: string;
  amountOut?: string;
  amountUsd?: number;         // human-readable USD notional (buys: spent · sells: proceeds) — the
                              // PositionBook's bookkeeping input, set by the adapter + shadow path
  reason?: string;            // reject/failure reason (also set on shadow for transparency)
  gasUsed?: number;
  timestamp: number;          // unix ms
}

/** What the adapter believes about the execution wallet's money (real read is portfolio.ts). */
export interface PortfolioSnapshot {
  totalUsd: number;
  availableUsd: number;
  positions: Array<{
    token: string;
    chain: string;
    amount: string;
    valueUsd: number;
  }>;
  dailyVolumeUsd: number;
  lastTradeAt: Record<string, number>;  // token → unix ms of the last trade (cooldown gate)
}

/** The pure risk verdict: allow with a (possibly shrunk) size, or reject with a reason. */
export type RiskDecision =
  | { allow: true; adjustedAmountUsd: number }
  | { allow: false; reason: string };
