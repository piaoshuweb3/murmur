// meme/types.ts — shared types for the meme monitoring channel (the 二次开发 optional layer).
//
// This channel runs PARALLEL to the Arc market temperature: it watches multi-chain meme markets
// (Solana / Base / ETH / Arc) and reduces them to one overallHeat plus a coarse regime. It is a
// strictly READ-ONLY observation layer — nothing here trades, holds a key or moves money; the only
// consumers are the sensory fusion in state.ts (temperature blend + RUG_RISK ⇒ COLD) and the
// external intent builder in execution/intents.ts.

/** Chains the meme channel can watch. "arc" keeps the door open for Arc-native meme pools. */
export type MemeChain = "solana" | "base" | "eth" | "arc";

/**
 * Coarse meme regime. RUG_RISK is the safety override: when liquidity health collapses or holder
 * concentration spikes, state.ts forces the swarm regime to COLD and the execution layer refuses
 * new buys on the offending tokens (defence-in-depth against the classic meme rug pattern).
 */
export type MemeRegime = "PUMP" | "DUMP" | "NEUTRAL" | "RUG_RISK";

/** One tradable meme signal: a token worth the swarm's attention (or its avoidance). */
export interface MemeSignal {
  token: string;            // token contract / mint address
  chain: MemeChain;
  score: number;            // 0..1 composite attractiveness (already risk-discounted)
  reasons: string[];        // human-readable detector hits, e.g. "volumeSpike 6.2x vs 1h EWMA"
  liquidityUsd?: number;    // pool liquidity in USD when the source reports it
  holderConcentration?: number; // top-10 holder share 0..1 when the source reports it
  priceUsd?: number;        // current mark price USD when the source reports it (feeds the exit layer)
}

/** Raw indicator set computed from the configured data sources (all 0..1 unless noted). */
export interface MemeIndicators {
  launchHeat: number;           // 0..1 new-pool launch heat (count × initial liquidity, 5–15 min window)
  volumeSpike: number;          // 0..1 normalised volume multiple vs the 1h EWMA baseline
  smartMoneyFlow: number;       // 0..1 net inflow of known smart-money wallets
  socialMomentum: number;       // 0..1 mention-growth proxy (X/Telegram keyword velocity)
  liquidityHealth: number;      // 0..1 locked-liquidity quality / rug-feature absence (1 = healthy)
  holderConcentration: number;  // 0..1 top-10 holder share of the hottest token (higher = more dangerous)
  priceVelocity: number;        // 0..1 |short-term price move| proxy feeding regime thresholds
  topSignals: MemeSignal[];     // ranked candidate tokens (risk-discounted score, best first)
}

/** The meme channel's published snapshot — what state.ts fuses into the swarm's temperature. */
export interface MemeSnapshot {
  overallHeat: number;      // 0..1 weighted composite of the raw indicators
  regime: MemeRegime;
  topSignals: MemeSignal[];
  raw: {
    launchHeat: number;
    volumeSpike: number;
    smartMoneyFlow: number;
    socialMomentum: number;
    liquidityHealth: number;
  };
}

/** One observation handed to the detectors by a data source (see sources.ts). */
export interface MemeObservation {
  token: string;
  chain: MemeChain;
  poolCreatedAtMs?: number;     // when the pool was deployed (undefined = mature pool)
  initialLiquidityUsd?: number; // pool's current liquidity in USD
  volume1mUsd?: number;         // trailing 1-minute volume
  volume5mUsd?: number;         // trailing 5-minute volume
  volume1hUsd?: number;         // trailing 1-hour volume (EWMA baseline reference)
  top10HolderShare?: number;    // 0..1
  liquidityLockedFrac?: number; // 0..1 share of LP tokens locked/burned
  smartMoneyNetUsd?: number;    // net smart-money flow over the window (USD; + = inflow)
  socialMentionsPerHour?: number; // mention velocity across X/Telegram
  priceChangePct1h?: number;    // signed % move over the last hour
  priceUsd?: number;            // current mark price USD (the exit layer's P&L reference)
}
