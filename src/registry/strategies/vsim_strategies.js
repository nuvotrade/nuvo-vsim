/**
 * The strategy catalogue (§23, §25).
 *
 * NUVO starts NARROWER than every previous incarnation. One falsifiable
 * economic hypothesis, tested properly, beats five plausible ones tested
 * casually.
 */
import { Strategy, STRATEGY_STATE } from '../strategy_registry.js';
import { STRUCTURE } from '../../structures/structure.js';
import { REGIME } from '../../market/regime.js';

/**
 * VSIM-001 — the first economic hypothesis (§25).
 *
 * Deliberately the narrowest useful claim, and falsifiable as stated: if
 * the expectancy is not there after realistic costs, the test says so.
 */
export const VSIM_001 = () => new Strategy({
  id: 'VSIM-001',
  name: 'Fear-regime downside underwriting',
  hypothesis:
    'Liquid index and high-quality single-name downside options become periodically '
    + 'overpriced relative to conditional realised downside risk during elevated fear '
    + 'regimes, creating positive expectancy for systematically selling defined '
    + 'downside risk after realistic execution costs.',
  state: STRATEGY_STATE.RESEARCH,
  allowedStructures: [STRUCTURE.CSP, STRUCTURE.BULL_PUT_SPREAD],
  allowedRegimes: [REGIME.FEAR, REGIME.PANIC, REGIME.NORMAL],
  dteBand: [7, 45],
  killCriteria: {
    minObservations: 50,
    maxOosExpectancy: 0,        // non-positive out-of-sample expectancy kills it
    maxCvarPct: 0.06,
    minCalibrationSlope: 0.60,
    maxBrierScore: 0.26,
    minEdgeRetained: 0.40,
    maxDrawdownPct: 0.18,
    minProfitFactor: 1.05,
  },
});

/**
 * VSIM-002 — defined-risk only. Exists to isolate whether the edge comes
 * from the premium or from the undefined tail of the CSP.
 */
export const VSIM_002 = () => new Strategy({
  id: 'VSIM-002',
  name: 'Defined-risk downside VRP',
  hypothesis:
    'The downside volatility risk premium can be harvested with strictly defined risk, '
    + 'retaining materially better RAROC than cash-secured puts on the same thesis '
    + 'after the wider round-trip cost of a two-leg structure.',
  state: STRATEGY_STATE.RESEARCH,
  allowedStructures: [STRUCTURE.BULL_PUT_SPREAD],
  allowedRegimes: [REGIME.NORMAL, REGIME.FEAR, REGIME.PANIC, REGIME.DISLOCATION],
  dteBand: [7, 45],
  killCriteria: {
    minObservations: 50,
    maxOosExpectancy: 0,
    maxCvarPct: 0.04,
    minCalibrationSlope: 0.60,
    maxBrierScore: 0.26,
    minEdgeRetained: 0.35,
    maxDrawdownPct: 0.12,
  },
});

/**
 * VSIM-003 — post-event volatility compression.
 * Note this is the OPPOSITE of the usual event-avoidance rule: it sells
 * only AFTER the binary resolves, when the IV crush is the edge.
 */
export const VSIM_003 = () => new Strategy({
  id: 'VSIM-003',
  name: 'Post-event volatility compression',
  hypothesis:
    'Implied volatility remains elevated relative to subsequent realised volatility '
    + 'for several sessions after a scheduled binary event resolves, and selling that '
    + 'residual premium is positive expectancy once the event risk itself is gone.',
  state: STRATEGY_STATE.RESEARCH,
  allowedStructures: [STRUCTURE.BULL_PUT_SPREAD, STRUCTURE.CSP],
  allowedRegimes: [REGIME.CALM, REGIME.NORMAL, REGIME.FEAR],
  dteBand: [7, 21],
  killCriteria: {
    minObservations: 40,
    maxOosExpectancy: 0,
    maxCvarPct: 0.05,
    minCalibrationSlope: 0.60,
    maxBrierScore: 0.26,
    minEdgeRetained: 0.40,
  },
});

/**
 * VSIM-004 — 0DTE index premium. Registered as REJECTED, on purpose.
 *
 * §22: the 0DTE operation must not contaminate VSIM's statistical record.
 * Recording the rejection is more useful than omitting the idea, because
 * it stops the question being reopened informally every few weeks.
 */
export const VSIM_004 = () => {
  const s = new Strategy({
    id: 'VSIM-004',
    name: '0DTE index premium',
    hypothesis:
      'Same-day index options carry harvestable premium at the index level.',
    state: STRATEGY_STATE.RESEARCH,
    allowedStructures: [STRUCTURE.BULL_PUT_SPREAD],
    allowedRegimes: [REGIME.NORMAL, REGIME.FEAR],
    dteBand: [0, 1],
    killCriteria: { minObservations: 100, maxOosExpectancy: 0, maxCvarPct: 0.03 },
  });
  s.transition(
    STRATEGY_STATE.REJECTED,
    'Out of scope for core VSIM (§22): gamma profile and holding period are '
    + 'incompatible with the 7-45 DTE operating band, and its variance would '
    + 'contaminate the statistical record the authority ladder depends on. '
    + 'Belongs in a separate sleeve with its own ledger and risk budget.',
  );
  return s;
};

/** Register the standard catalogue. */
export function registerCatalogue(registry) {
  for (const make of [VSIM_001, VSIM_002, VSIM_003, VSIM_004]) registry.register(make());
  return registry;
}
