/**
 * Authority tiers (§17).
 *
 * NUVO does not graduate from "recommendation engine" to "autonomous
 * trader" by decree. Each promotion is earned against thresholds that are
 * PRE-REGISTERED — written down before the evidence arrives, so they
 * cannot be relaxed after a good month.
 */
import { TIER, violation } from './hierarchy.js';

export const AUTHORITY = Object.freeze({
  RESEARCH_ONLY: 0,
  SHADOW: 1,
  PROPOSE: 2,          // executable order plans, human approval required
  AUTO_ENTRY: 3,       // autonomous entry within narrow limits
  AUTO_LIFECYCLE: 4,   // autonomous lifecycle management
  AUTO_PORTFOLIO: 5,   // full autonomous portfolio operation
});

export const AUTHORITY_NAME = Object.freeze(
  Object.fromEntries(Object.entries(AUTHORITY).map(([k, v]) => [v, k])),
);

/** What each tier is permitted to do. */
export const CAPABILITIES = Object.freeze({
  0: { research: true, rank: false, propose: false, submit: false, manage: false },
  1: { research: true, rank: true, propose: false, submit: false, manage: false },
  2: { research: true, rank: true, propose: true, submit: false, manage: false },
  3: { research: true, rank: true, propose: true, submit: true, manage: false },
  4: { research: true, rank: true, propose: true, submit: true, manage: true },
  5: { research: true, rank: true, propose: true, submit: true, manage: true },
});

/**
 * Pre-registered promotion gates. Every field is a floor that must be met
 * by LIVE evidence — backtests do not promote anything past SHADOW.
 */
export const PROMOTION_GATES = Object.freeze({
  1: { liveObservations: 0, note: 'Shadow requires only a validated hypothesis.' },
  2: {
    requiresPrincipalAmendment: true,
    note: 'Propose authority opens only through an explicit Principal Constitution amendment.',
  },
  3: {
    liveObservations: 100,
    maxBrierScore: 0.20,
    minCalibrationSlope: 0.80,
    minExecutionEdgeRetained: 0.60, // fraction of modelled edge surviving fills
    maxConstitutionalBreaches: 0,
    note: 'Autonomous entry requires proven execution, not just proven theory.',
  },
  4: {
    liveObservations: 250,
    maxBrierScore: 0.18,
    minCalibrationSlope: 0.85,
    minExecutionEdgeRetained: 0.70,
    maxConstitutionalBreaches: 0,
    maxDrawdownPct: 0.12,
    note: 'Lifecycle autonomy requires a survived drawdown, not an unhurt record.',
  },
  5: {
    liveObservations: 500,
    maxBrierScore: 0.17,
    minCalibrationSlope: 0.90,
    minExecutionEdgeRetained: 0.75,
    maxConstitutionalBreaches: 0,
    maxDrawdownPct: 0.10,
    minProfitFactor: 1.25,
    note: 'Full autonomy is the last gate and the hardest.',
  },
});

/** Capital ceiling by authority — an unvalidated model gets less money (§15). */
export const CAPITAL_AUTHORITY_FRACTION = Object.freeze({
  0: 0, 1: 0, 2: 0.20, 3: 0.35, 4: 0.60, 5: 1.00,
});

export function can(level, capability) {
  return Boolean(CAPABILITIES[level]?.[capability]);
}

/** Assert a capability, returning a Violation instead of throwing. */
export function requireCapability(level, capability) {
  if (can(level, capability)) return null;
  return violation(
    TIER.TRUTH,
    'AUTHORITY_INSUFFICIENT',
    `Authority ${level} (${AUTHORITY_NAME[level]}) may not '${capability}'.`,
    { level, capability, required: lowestLevelFor(capability) },
  );
}

export function lowestLevelFor(capability) {
  for (const lvl of Object.keys(CAPABILITIES).map(Number).sort((a, b) => a - b)) {
    if (CAPABILITIES[lvl][capability]) return lvl;
  }
  return null;
}

/**
 * Evaluate a promotion request against the pre-registered gate.
 * Returns { eligible, target, failures } — never mutates anything.
 * Promotion is one step at a time; skipping tiers is not a thing.
 */
export function evaluatePromotion(currentLevel, evidence) {
  const target = currentLevel + 1;
  if (target > AUTHORITY.AUTO_PORTFOLIO) {
    return { eligible: false, target: null, failures: ['Already at maximum authority.'] };
  }
  const gate = PROMOTION_GATES[target];
  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); };

  const {
    liveObservations = 0, brierScore = Infinity, calibrationSlope = 0,
    executionEdgeRetained = 0, constitutionalBreaches = Infinity,
    maxDrawdownPct = Infinity, profitFactor = 0,
    principalConstitutionAmendment = false,
  } = evidence;

  if (gate.requiresPrincipalAmendment) {
    check(principalConstitutionAmendment === true,
      'Explicit Principal Constitution amendment is required.');
  }
  if (gate.liveObservations !== undefined) {
    check(liveObservations >= gate.liveObservations,
      `liveObservations ${liveObservations} < ${gate.liveObservations}`);
  }
  if (gate.maxBrierScore !== undefined) {
    check(brierScore <= gate.maxBrierScore, `brierScore ${brierScore} > ${gate.maxBrierScore}`);
  }
  if (gate.minCalibrationSlope !== undefined) {
    check(calibrationSlope >= gate.minCalibrationSlope,
      `calibrationSlope ${calibrationSlope} < ${gate.minCalibrationSlope}`);
  }
  if (gate.minExecutionEdgeRetained !== undefined) {
    check(executionEdgeRetained >= gate.minExecutionEdgeRetained,
      `executionEdgeRetained ${executionEdgeRetained} < ${gate.minExecutionEdgeRetained}`);
  }
  if (gate.maxConstitutionalBreaches !== undefined) {
    check(constitutionalBreaches <= gate.maxConstitutionalBreaches,
      `constitutionalBreaches ${constitutionalBreaches} > ${gate.maxConstitutionalBreaches}`);
  }
  if (gate.maxDrawdownPct !== undefined) {
    check(maxDrawdownPct <= gate.maxDrawdownPct,
      `maxDrawdownPct ${maxDrawdownPct} > ${gate.maxDrawdownPct}`);
  }
  if (gate.minProfitFactor !== undefined) {
    check(profitFactor >= gate.minProfitFactor,
      `profitFactor ${profitFactor} < ${gate.minProfitFactor}`);
  }

  return { eligible: failures.length === 0, target, gate, failures };
}

/**
 * Demotion is automatic and needs no ceremony. A constitutional breach or a
 * calibration collapse drops authority immediately; earning it back goes
 * through the same gates as the first time.
 */
export function evaluateDemotion(currentLevel, evidence) {
  const reasons = [];
  if ((evidence.constitutionalBreaches ?? 0) > 0) reasons.push('constitutional breach recorded');
  if ((evidence.brierScore ?? 0) > 0.28) reasons.push(`brier score ${evidence.brierScore} indicates broken calibration`);
  if ((evidence.maxDrawdownPct ?? 0) > 0.20) reasons.push(`drawdown ${evidence.maxDrawdownPct} beyond survival tolerance`);
  if (evidence.dataIntegrityFailure) reasons.push('truth-engine integrity failure');
  if (!reasons.length) return { demote: false, target: currentLevel, reasons };
  // A breach costs everything above PROPOSE; an integrity failure costs everything.
  const target = evidence.dataIntegrityFailure
    ? AUTHORITY.RESEARCH_ONLY
    : Math.min(currentLevel, AUTHORITY.PROPOSE);
  return { demote: target < currentLevel, target, reasons };
}
