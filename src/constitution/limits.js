/**
 * Hard risk limits (§1, §14, §16).
 *
 * These are constitutional: the Underwriter may not trade through them and
 * the Portfolio Governor may not size through them. Changing a number here
 * is an amendment — it should be deliberate, versioned, and accompanied by
 * the evidence that justified it, which is why every limit carries `basis`.
 */
export const DEFAULT_LIMITS = Object.freeze({
  version: 'constitution-v5.2.1',

  // ── Survival ──────────────────────────────────────────────────────────
  maxDrawdownPct: 0.15,            // halt trading beyond this peak-to-trough
  softDrawdownPct: 0.10,           // begin de-risking here
  maxPortfolioCVaRPct: 0.20,       // 95% CVaR as fraction of NAV
  maxSingleTradeCVaRPct: 0.04,     // one position may not threaten the book
  maxRuinProbability: 0.005,       // P(losing 50% of capital) over 1y horizon
  stressScenarioLossPct: 0.25,     // max loss under the mandated stress set

  // ── Concentration (§14) ───────────────────────────────────────────────
  maxClusterPct: 0.25,             // no correlated cluster > 25% of capital
  maxSingleUnderlyingPct: 0.20,    // Principal mandate: manage-only above 20% of NAV
  maxSectorPct: 0.30,
  maxExpirationPct: 0.25,          // Principal mandate: one expiration cycle <= 25% of NAV
  clusterCorrelationThreshold: 0.65, // |rho| above this joins a cluster

  // ── Capital utilisation (§16) ─────────────────────────────────────────
  minReservePct: 0.20,             // never deployable
  maxDeployedPct: 0.65,            // of NAV, at Authority 5
  maxNewCommitmentsPerCycle: 3,

  // ── Portfolio Greeks ──────────────────────────────────────────────────
  maxNetDeltaPctNav: 0.60,         // beta-weighted, per $1 of NAV
  maxNetVegaPctNav: 0.015,         // vega per 1 vol point
  maxNetGammaPctNav: 0.004,

  // ── Liquidity (§7) ────────────────────────────────────────────────────
  maxSpreadPctOfMid: 0.08,
  minOpenInterest: 250,
  minDailyOptionVolume: 50,
  minUnderlyingAdv: 500_000,       // shares/day
  maxPositionPctOfOi: 0.05,

  // ── Expectancy floors (§3) ────────────────────────────────────────────
  minNev: 0,                       // NEV must be strictly positive to trade
  minRaroc: 0.08,                  // annualised, after costs
  minRoc: 0.015,                   // per-trade on buying power
  minEdgeOverCosts: 2.0,           // modelled edge must be >= 2x round-trip cost
  riskFreeRate: 0.045,              // observable collateral yield baseline
  cspRequiredExcessReturn: 0.04,    // CSP edge required above collateral yield
  wheelCcDte: 14,                   // recovery distance measured on a standard CC cycle
  wheelRecoverySigmaThreshold: 1,  // farther than this is economically stranded
  maxCspStrandedAssignmentPct: 0.40, // refuse CSP if too many assignment paths strand shares

  // ── Data freshness (§18) ──────────────────────────────────────────────
  maxQuoteAgeMs: 60_000,
  maxAccountAgeMs: 120_000,
  maxChainAgeMs: 120_000,

  // ── Lifecycle (§12) ───────────────────────────────────────────────────
  harvestProfitPct: 0.75,          // close at 75% of premium captured
  reassessAdverseSigma: 0.5,       // re-underwrite at 0.5 sigma adverse
  breachActionRequired: true,      // short-strike breach forces a decision
  minDte: 7,
  maxDte: 45,
  eventBlackoutDays: 2,            // no new entry within N days of a known event
});

/** Limits are constructed, not mutated — an amendment produces a new object. */
export function amend(limits, changes, { reason, evidence } = {}) {
  if (!reason) throw new Error('Constitutional amendments require a stated reason.');
  const next = Object.freeze({
    ...limits,
    ...changes,
    version: `${limits.version}+amend`,
    amendments: [
      ...(limits.amendments ?? []),
      { changes, reason, evidence: evidence ?? null, keys: Object.keys(changes) },
    ],
  });
  return next;
}

/** Human-readable rationale, surfaced whenever a limit blocks a trade. */
export const LIMIT_BASIS = Object.freeze({
  maxClusterPct: 'Ten short puts on correlated tech names are one short-vol trade, not ten trades.',
  maxSingleUnderlyingPct: 'The Principal mandate blocks additions and makes an existing name manage-only above 20% of NAV.',
  maxExpirationPct: 'No more than 25% of NAV may be concentrated in one expiration cycle.',
  minReservePct: 'Assignment and margin expansion both arrive at the worst moment.',
  minEdgeOverCosts: 'An edge that only exists at mid-price does not exist.',
  harvestProfitPct: 'The last 25% of premium is the worst-paid risk in the position.',
  maxRuinProbability: 'Geometric growth is destroyed by ruin regardless of expectancy.',
  minNev: 'Premium is not income until it survives its own tail.',
});
