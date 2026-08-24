/**
 * The Position Contract (§12).
 *
 * "Nothing important gets invented after the position starts losing."
 *
 * Every lifecycle rule is fixed at inception and frozen. A losing position
 * cannot renegotiate its own exit criteria, because the object holding
 * those criteria is immutable.
 */
import { isNum } from '../math/stats.js';
import { contentHash } from '../execution/order.js';

export const POSITION_STATE = Object.freeze({
  PENDING: 'PENDING',
  OPEN: 'OPEN',
  BREACHED: 'BREACHED',
  CLOSED: 'CLOSED',
  ASSIGNED: 'ASSIGNED',
  EXPIRED: 'EXPIRED',
});

/**
 * Build the complete lifecycle object. Throws on missing fields rather
 * than defaulting them — an incomplete contract is exactly the situation
 * this exists to prevent.
 */
export function createPositionContract({
  underlying, structure, candidate, sizing, regime, limits,
  strategyId, modelVersion, codeVersion, thesis, now, id = null,
}) {
  const required = { underlying, structure, candidate, regime, strategyId, modelVersion, thesis };
  for (const [k, v] of Object.entries(required)) {
    if (v === undefined || v === null) {
      throw new Error(`Position contract requires '${k}'. Refusing to open a position with an incomplete contract.`);
    }
  }

  const contracts = sizing?.contracts ?? structure.contracts ?? 1;
  const scale = contracts / Math.max(1, structure.contracts);
  const entryCredit = structure.credit * scale;

  // Content-derived, not a counter. A sequence number depends on how many
  // positions the PROCESS happened to create first, so the same decision
  // replayed in a fresh process produced a different id — which meant an
  // otherwise byte-identical reconstruction did not match.
  const identity = {
    underlying,
    kind: structure.kind,
    shortStrike: structure.shortStrike ?? null,
    longStrike: structure.longStrike ?? null,
    expiration: structure.expiration ?? null,
    contracts,
    strategyId,
    openedAt: now,
  };

  const contract = {
    id: id ?? `POS-${contentHash(identity).slice(0, 12)}-${underlying}`,
    createdAt: now,
    state: POSITION_STATE.PENDING,

    // ── Identity ──
    underlying,
    strategy: structure.kind,
    strategyId,
    modelVersion,
    codeVersion,
    thesis,

    // ── Terms ──
    expiration: structure.expiration,
    dte: structure.dte,
    shortStrike: structure.shortStrike,
    longStrike: structure.longStrike ?? null,
    contracts,
    multiplier: structure.multiplier,
    entryCredit,
    buyingPower: structure.buyingPower * scale,

    // ── Underwriting at inception (frozen) ──
    expectedValue: candidate.evaluation.ev * scale,
    expectedLoss: candidate.evaluation.expectedLoss * scale,
    cvar: candidate.evaluation.cvar * scale,
    maxLoss: structure.maxLoss * scale,
    economicCapital: candidate.capital.economicCapital * scale,
    rarocAtEntry: candidate.capital.raroc,
    pLossAtEntry: candidate.evaluation.pLoss,
    probabilities: candidate.probabilities,
    /**
     * Two distinct forecasts, recorded separately so each is scored against
     * the event it actually predicted.
     *   pTerminalBelowStrike — P(S_T < K) at expiry
     *   pTouchStrike         — P(S touches K at any point before expiry)
     */
    pTerminalBelowStrike: candidate.probabilities?.pModel ?? null,
    pTouchStrike: candidate.pTouch ?? null,
    regimeAtEntry: regime.regime,
    entrySpot: candidate.structure.legs[0]?.contract
      ? candidate.underlyingSpot ?? null
      : null,

    // ── Lifecycle rules, decided NOW (§12) ──
    rules: Object.freeze({
      profitExitPct: limits.harvestProfitPct,
      reassessAdverseSigma: limits.reassessAdverseSigma,
      strikeBreachAction: 'RE_UNDERWRITE',
      maxLossStop: structure.maxLoss * scale,
      expirationBehaviour: structure.definedRisk ? 'CLOSE_BEFORE_EXPIRY' : 'RE_UNDERWRITE_AT_5_DTE',
      eventConstraint: 'CLOSE_IF_UNSCHEDULED_EVENT_ANNOUNCED',
      minDteToHold: 2,
    }),

    // ── Mutable tracking ──
    events: [],
    currentMark: null,
    realizedPnl: null,
    closedAt: null,
    closeReason: null,
  };

  // Freeze the underwriting terms so a drawdown cannot rewrite them.
  Object.freeze(contract.rules);
  return contract;
}

/** Profit captured so far, as a fraction of the credit received. */
export function capturedFraction(position, currentMarkDebit) {
  if (!isNum(currentMarkDebit) || !isNum(position.entryCredit) || position.entryCredit === 0) return NaN;
  return (position.entryCredit - currentMarkDebit) / position.entryCredit;
}

/** Adverse move measured in sigmas of the position's own daily vol. */
export function adverseSigma({ entrySpot, currentSpot, iv, daysElapsed }) {
  if (![entrySpot, currentSpot, iv].every(isNum) || entrySpot <= 0 || iv <= 0) return NaN;
  const elapsed = Math.max(1, daysElapsed ?? 1);
  const sigma = iv * Math.sqrt(elapsed / 252);
  return Math.log(currentSpot / entrySpot) / sigma;
}

export function summarise(position) {
  return {
    id: position.id,
    underlying: position.underlying,
    strategy: position.strategy,
    state: position.state,
    shortStrike: position.shortStrike,
    expiration: position.expiration,
    contracts: position.contracts,
    entryCredit: position.entryCredit,
    cvar: position.cvar,
    rarocAtEntry: position.rarocAtEntry,
    thesis: position.thesis,
  };
}
