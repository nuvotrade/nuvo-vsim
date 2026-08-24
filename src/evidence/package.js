/**
 * Evidence packages (§19).
 *
 * "Every order should be reconstructable years later."
 *
 * The package captures inputs, intermediate reasoning, rejected
 * alternatives and the final decision, then hashes the whole thing. The
 * rejected candidates matter as much as the chosen one: without them there
 * is no way to tell later whether NUVO chose well or simply chose first.
 */
import { contentHash, stableStringify } from '../execution/order.js';

export const EVIDENCE_VERSION = 'nuvo-evidence-1';

/**
 * Build the package for one decision.
 * `raw` holds verbatim observations; nothing here is a re-derivation.
 */
export function buildEvidence({
  cycleId, now, decision, truthReport, marketState, universe, candidates,
  selected, governance, sizing, order, positionContract, strategyId,
  modelVersion, codeVersion, limits, authorityLevel,
}) {
  const pkg = {
    version: EVIDENCE_VERSION,
    cycleId,
    at: now,

    // ── Provenance ──
    modelVersion,
    codeVersion,
    limitsVersion: limits?.version ?? null,
    authorityLevel,
    strategyId,

    // ── Raw observations, exactly as verified ──
    truth: {
      verdict: truthReport?.verdict ?? null,
      summary: truthReport?.summary?.() ?? null,
      factsAsOf: truthReport
        ? Object.fromEntries(Object.entries(truthReport.facts).map(([k, f]) => [k, f.asOf]))
        : null,
      sources: truthReport
        ? Object.fromEntries(Object.entries(truthReport.facts).map(([k, f]) => [k, f.source]))
        : null,
    },

    // ── Market state ──
    market: marketState ? {
      regime: marketState.regime?.regime,
      regimeScore: marketState.regime?.score,
      regimeComponents: marketState.regime?.components,
      regimeConfident: marketState.regime?.confident,
      breadthCorrelation: marketState.breadthCorrelation,
      index: marketState.index,
      underlyings: Object.fromEntries(
        Object.entries(marketState.underlyings ?? {}).map(([s, u]) => [s, {
          spot: u.spot,
          realized: u.realized,
          atmIv: u.surface?.atmIv,
          skew: u.surface?.skew,
          term: u.surface?.term?.slope,
          vrp: { spread: u.vrp?.spread, ratio: u.vrp?.ratio, forward: u.vrp?.forward?.spread },
          gapFrequency: u.gapFrequency,
          garch: u.volProfile?.garch ? {
            alpha: u.volProfile.garch.alpha,
            beta: u.volProfile.garch.beta,
            conditionalVol: u.volProfile.garch.conditionalVol,
            longRunVol: u.volProfile.garch.longRunVol,
          } : null,
        }]),
      ),
    } : null,

    // ── Universe: what was considered and what was excluded, with reasons ──
    universe: universe ? {
      tierA: universe.tierA.map((c) => c.symbol),
      tierB: universe.tierB.map((c) => ({ symbol: c.symbol, admission: c.admission })),
      prohibited: universe.prohibited.map((c) => ({
        symbol: c.symbol, note: c.note, reasons: c.reasons.map(String),
      })),
    } : null,

    // ── Every candidate scored, not just the winner ──
    candidates: (candidates ?? []).map(summariseCandidate),
    rejectedCount: (candidates ?? []).filter((c) => !c.admissible).length,

    selected: selected ? summariseCandidate(selected) : null,
    decision,

    governance: governance ? {
      approved: governance.approved,
      cluster: governance.cluster?.id ?? null,
      clusterMembers: governance.cluster?.members ?? null,
      clusterExposure: governance.clusterExposure,
      clusterCorrelation: governance.clusterCorrelation,
      violations: (governance.violations ?? []).map(String),
      warnings: (governance.warnings ?? []).map(String),
      portfolioGreeks: governance.portfolio?.greeks ?? null,
      stressWorst: governance.stress?.worst
        ? { scenario: governance.stress.worst.scenario, pctOfNav: governance.stress.worstPctOfNav }
        : null,
    } : null,

    sizing: sizing ? {
      contracts: sizing.contracts,
      multipliers: sizing.multipliers,
      binding: sizing.binding,
      caps: sizing.caps,
      zeroReason: sizing.zeroReason,
    } : null,

    order: order ? {
      clientOrderId: order.clientOrderId,
      limitPrice: order.limitPrice,
      legs: order.legs,
      expectation: order.expectation,
    } : null,

    positionContractId: positionContract?.id ?? null,

    // ── Outcome, filled in later ──
    outcome: null,
  };

  pkg.hash = contentHash(pkg);
  return pkg;
}

function summariseCandidate(c) {
  return {
    underlying: c.underlying,
    kind: c.structure?.kind,
    shortStrike: c.structure?.shortStrike ?? null,
    longStrike: c.structure?.longStrike ?? null,
    expiration: c.structure?.expiration ?? null,
    dte: c.dte,
    credit: c.structure?.credit,
    buyingPower: c.structure?.buyingPower,
    ev: c.evaluation?.ev,
    nev: c.evaluation?.nev,
    cvar: c.evaluation?.cvar,
    gapRisk: c.evaluation?.gapRisk?.value,
    raroc: c.capital?.raroc,
    roc: c.capital?.roc,
    economicCapital: c.capital?.economicCapital,
    probabilities: c.probabilities ? {
      pMarket: c.probabilities.pMarket,
      pModel: c.probabilities.pModel,
      pCal: c.probabilities.pCal,
      calibration: c.probabilities.calibration,
      edge: c.probabilities.edge,
      confidence: c.probabilities.confidence,
    } : null,
    admissible: c.admissible,
    violations: (c.violations ?? []).map(String),
  };
}

/**
 * Attach the realised outcome and re-hash.
 * The original hash is kept so the chain from decision to result is intact
 * and tamper-evident.
 */
export function sealOutcome(pkg, outcome) {
  // The prior hash must be REMOVED from the payload before re-hashing,
  // not merely overwritten: verifyEvidence hashes everything except
  // `hash`, so leaving the old value in would make every sealed package
  // fail its own verification.
  const { hash: priorHash, ...payload } = pkg;
  const sealed = { ...payload, outcome, decisionHash: priorHash };
  sealed.hash = contentHash(sealed);
  return sealed;
}

/** Verify a package has not been altered since it was written. */
export function verifyEvidence(pkg) {
  const { hash, ...rest } = pkg;
  return contentHash(rest) === hash;
}

export { stableStringify };
