// economySim.ts – S40 Game Economy & Balance Simulator.
//
// HONESTY NOTE: this module used to return
//     inflation = (Math.random()*0.04-0.02).toFixed(4)
// with `iterations` echoed back but never used and `balance` hard-coded to
// "stable". That is a fabricated receipt shaped exactly like a real Monte Carlo
// result, and a model will act on it. Everything below is now computed from the
// inputs; `iterations` genuinely drives the simulation.

/** Per-iteration (read: per-player-day) flows, in currency units. */
export interface EconomyConfig {
  /** Coins a player earns per day from quests/drops. */
  faucetPerDay?: number;
  /** Coins a player spends per day on shops/upgrades. */
  sinkPerDay?: number;
  /** Starting wallet. */
  startingBalance?: number;
  /** Relative price inflation applied to sinks each iteration (0 = fixed). */
  priceGrowth?: number;
  /** Fractional growth applied to faucets each iteration (0 = fixed). */
  faucetGrowth?: number;
  /** Hard ceiling; clamped sinks above it are counted as "capped" days. */
  dailyCap?: number;
}

export interface EconomyResult {
  iterations: number;
  /** Net coins created per day at the end of the run (negative = drain). */
  netPerDay: number;
  /** Total coins created by faucets over the whole run. */
  totalFaucet: number;
  /** Total coins destroyed by sinks over the whole run. */
  totalSink: number;
  /** totalFaucet / totalSink. >1 means the economy inflates. */
  faucetToSinkRatio: number;
  /** Annualised drift: sum(faucet-sink) / startingBalance, as a percentage. */
  inflationPct: number;
  balance: "inflationary" | "deflationary" | "stable";
  /** Wallet at the end of the run. */
  endingBalance: number;
  /** Days where the daily cap clamped spending. */
  cappedDays: number;
  sinks: string[];
  faucets: string[];
  suggestions: string[];
  /** Everything that went into the numbers, so the model can sanity-check it. */
  config: Required<EconomyConfig>;
}

const DEFAULTS: Required<EconomyConfig> = {
  faucetPerDay: 100,
  sinkPerDay: 80,
  startingBalance: 0,
  priceGrowth: 0,
  faucetGrowth: 0,
  dailyCap: 0, // 0 = no cap
};

/** Stable band: within +/- 2% drift over the run reads as "stable". */
const STABLE_BAND_PCT = 2;

export function simulateEconomy(config: EconomyConfig = {}, iterations = 1000): EconomyResult {
  const cfg: Required<EconomyConfig> = {
    faucetPerDay: num(config.faucetPerDay, DEFAULTS.faucetPerDay),
    sinkPerDay: num(config.sinkPerDay, DEFAULTS.sinkPerDay),
    startingBalance: num(config.startingBalance, DEFAULTS.startingBalance),
    priceGrowth: num(config.priceGrowth, DEFAULTS.priceGrowth),
    faucetGrowth: num(config.faucetGrowth, DEFAULTS.faucetGrowth),
    dailyCap: num(config.dailyCap, DEFAULTS.dailyCap),
  };
  const days = Math.max(1, Math.min(36500, Math.floor(iterations)));

  let faucet = cfg.faucetPerDay;
  let sink = cfg.sinkPerDay;
  let balance = cfg.startingBalance;
  let totalFaucet = 0;
  let totalSink = 0;
  let cappedDays = 0;

  for (let d = 0; d < days; d++) {
    let spend = sink;
    if (cfg.dailyCap > 0 && spend > cfg.dailyCap) {
      spend = cfg.dailyCap;
      cappedDays++;
    }
    // A wallet cannot spend below zero: the sink is limited by what is on hand.
    const faucetToday = faucet;
    const affordable = Math.max(0, Math.min(spend, balance + faucetToday));
    totalFaucet += faucetToday;
    totalSink += affordable;
    balance += faucetToday - affordable;
    // Growth compounds per iteration (deterministic, no randomness).
    faucet *= 1 + cfg.faucetGrowth;
    sink *= 1 + cfg.priceGrowth;
  }

  const netPerDay = (totalFaucet - totalSink) / days;
  const faucetToSinkRatio = totalSink > 0 ? totalFaucet / totalSink : totalFaucet > 0 ? Infinity : 1;
  // Relative to the money that existed at the start; when it starts at zero we
  // measure against the faucet flow instead of dividing by zero.
  const denom = cfg.startingBalance > 0 ? cfg.startingBalance : Math.max(1, totalFaucet);
  const inflationPct = round((totalFaucet - totalSink) / denom * 100, 4);

  let label: EconomyResult["balance"] = "stable";
  if (Math.abs(inflationPct) > STABLE_BAND_PCT) {
    label = inflationPct > 0 ? "inflationary" : "deflationary";
  }

  return {
    iterations: days,
    netPerDay: round(netPerDay, 4),
    totalFaucet: round(totalFaucet, 4),
    totalSink: round(totalSink, 4),
    faucetToSinkRatio: Number.isFinite(faucetToSinkRatio) ? round(faucetToSinkRatio, 4) : Infinity,
    inflationPct,
    balance: label,
    endingBalance: round(balance, 4),
    cappedDays,
    sinks: ["shop", "upgrades", "cosmetics"],
    faucets: ["quests", "drops", "daily"],
    suggestions: suggestionsFor(label, cfg, inflationPct),
    config: cfg,
  };
}

function suggestionsFor(
  label: EconomyResult["balance"],
  cfg: Required<EconomyConfig>,
  inflationPct: number
): string[] {
  if (label === "inflationary") {
    return [
      `Faucets outrun sinks by ${inflationPct.toFixed(2)}% - raise prices or add a sink`,
      `Consider a sink of ~${Math.ceil(cfg.faucetPerDay * 1.05)}/day to outpace the faucet`,
      "Add diminishing returns so late-game income cannot compound unchecked",
    ];
  }
  if (label === "deflationary") {
    return [
      `Sinks outrun faucets by ${Math.abs(inflationPct).toFixed(2)}% - players will run dry`,
      `Raise the faucet toward ~${Math.ceil(cfg.sinkPerDay * 0.95)}/day or lower sink prices`,
      "Check whether the daily cap is throttling spending instead of the price",
    ];
  }
  return [
    `Faucets and sinks are within ${STABLE_BAND_PCT}% over the run - no action needed`,
    "Re-run with a different iteration count to check the balance holds over time",
  ];
}

export function suggestBalance(_projectId = "default", report: any = null) {
  // Derive from a real report when one is supplied; never invent numbers.
  const inflation = Number(report?.inflationPct);
  if (!Number.isFinite(inflation)) {
    return [
      "run simulate_economy first - suggest_balance has no report to reason from",
    ];
  }
  return suggestionsFor(
    Math.abs(inflation) > STABLE_BAND_PCT ? (inflation > 0 ? "inflationary" : "deflationary") : "stable",
    DEFAULTS,
    inflation
  );
}

function num(v: unknown, d: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function round(n: number, places: number): number {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}
