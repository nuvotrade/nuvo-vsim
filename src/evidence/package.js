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

// v2 adds the full engine/calibration/portfolio/config state required for a
// faithful non-empty-book replay. Calling that v1 would make incompatible
// records look interchangeable.
export const EVIDENCE_VERSION = 'nuvo-evidence-2';

/**
 * Build the package for one decision.
 * `raw` holds verbatim observations; nothing here is a re-derivation.
 */
export function buildEvidence({
  cycleId, now, decision, truthReport, marketState, universe, candidates,
  selected, governance, sizing, order, positionContract, strategyId,
  modelVersion, codeVersion, limits, authorityLevel,
  rawInputs = null, screenedOut = null, distributions = null,
  externalizeRaw = false,
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

    /**
     * The raw observations the decision was computed from — chains,
     * histories, quotes, account state, positions, open orders — captured
     * verbatim rather than summarised.
     *
     * Without these the package documents a decision but cannot REPRODUCE
     * one, and 19's claim that a decision is reconstructable years later
     * is not true. `externalizeRaw` drops the payload but keeps its hash,
     * for deployments that put the bytes in object storage keyed by that
     * hash; the hash is computed over the payload either way, so an
     * externalised blob can still be verified against the record.
     */
    inputs: rawInputs ? {
      hash: contentHash(rawInputs),
      captured: !externalizeRaw,
      externalized: externalizeRaw,
      data: externalizeRaw ? null : rawInputs,
      note: externalizeRaw
        ? 'Raw payload stored externally; retrieve by hash and verify before replay.'
        : 'Raw payload embedded. Replaying it must reproduce this decision exactly.',
    } : {
      hash: null, captured: false, externalized: false, data: null,
      note: 'NO RAW INPUTS CAPTURED — this decision is not replayable.',
    },

    /** Distribution provenance, so a replay builds the same forward model. */
    distributions: distributions ?? null,

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

    /**
     * Candidates the coarse screen dropped before refinement.
     *
     * Omitting them made the recorded field look like the field that was
     * considered, when it was only the shortlist. Anyone auditing whether
     * NUVO looked at the right strikes needs to see what it discarded and
     * on what basis.
     */
    screenedOut: screenedOut ?? [],
    screenedOutCount: (screenedOut ?? []).length,

    selected: selected ? summariseCandidate(selected) : null,
    decision,

    governance: governance ? {
      approved: governance.approved,
      stressWorstScenario: governance.stress?.worst?.scenario ?? null,
      stressEvaluated: Boolean(governance.stress),
      portfolioCvarPctOfNav: governance.portfolioCvar?.pctOfNav ?? null,
      ruinProbability: governance.ruin?.probability ?? null,
      ruinStandardError: governance.ruin?.standardError ?? null,
      cluster: governance.cluster?.id ?? null,
      clusterMembers: governance.cluster?.members ?? null,
      clusterExposure: governance.clusterExposure,
      clusterCorrelation: governance.clusterCorrelation,
      violations: (governance.violations ?? []).map(String),
      warnings: (governance.warnings ?? []).map(String),
      portfolioBefore: governance.portfolioBefore ? {
        exposures: governance.portfolioBefore.exposures ?? null,
        greeks: governance.portfolioBefore.greeks ?? null,
        violations: (governance.portfolioBefore.violations ?? []).map(String),
      } : null,
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
    positionContract: positionContract ? positionContractContent(positionContract) : null,

    // ── Outcome, filled in later ──
    outcome: null,
  };

  /**
   * Two hashes, because they answer two different questions.
   *
   *   hash                — integrity of the whole record. Any alteration
   *                         anywhere breaks it. This is the audit guarantee.
   *   decisionFingerprint — the DECISION content only, with provenance
   *                         metadata excluded. This is what a replay must
   *                         reproduce.
   *
   * Collapsing them makes reproducibility untestable: a faithful replay
   * necessarily reads from a different provider, so its record differs in
   * source labels while the decision is identical. Judging reproduction on
   * the full-record hash would report every correct replay as a failure.
   */
  // Detach evidence from the mutable cycle/order objects before hashing.
  // Otherwise changing an order after the decision can also mutate the
  // supposedly filed record through a shared array reference.
  const snapshot = structuredClone(pkg);
  snapshot.decisionFingerprint = contentHash(decisionContent(snapshot));
  snapshot.hash = contentHash(snapshot);
  return snapshot;
}

/**
 * The subset of a package that constitutes the decision itself.
 * Deliberately excludes: the raw input blob (identified by its own hash),
 * provider/source names, and record-keeping ids.
 */
export function decisionContent(pkg) {
  return {
    decision: pkg.decision,
    inputsHash: pkg.inputs?.hash ?? null,
    modelVersion: pkg.modelVersion,
    codeVersion: pkg.codeVersion,
    limitsVersion: pkg.limitsVersion,
    authorityLevel: pkg.authorityLevel,
    strategyId: pkg.strategyId,
    regime: pkg.market?.regime ?? null,
    regimeScore: pkg.market?.regimeScore ?? null,
    universe: pkg.universe ?? null,
    candidates: pkg.candidates ?? [],
    screenedOut: pkg.screenedOut ?? [],
    selected: pkg.selected ?? null,
    sizing: pkg.sizing ?? null,
    governance: pkg.governance ?? null,
    orderLegs: pkg.order?.legs ?? null,
    orderLimitPrice: pkg.order?.limitPrice ?? null,
    orderExpectation: pkg.order?.expectation ?? null,
    positionContract: pkg.positionContract ?? null,
  };
}

/** Immutable, execution-relevant position terms bound into the evidence. */
export function positionContractContent(p) {
  return {
    id: p.id, createdAt: p.createdAt, state: p.state,
    underlying: p.underlying, strategy: p.strategy, strategyId: p.strategyId,
    modelVersion: p.modelVersion, codeVersion: p.codeVersion, thesis: p.thesis,
    expiration: p.expiration, dte: p.dte,
    shortStrike: p.shortStrike, longStrike: p.longStrike,
    contracts: p.contracts, multiplier: p.multiplier,
    entryCredit: p.entryCredit, buyingPower: p.buyingPower,
    expectedValue: p.expectedValue, expectedLoss: p.expectedLoss,
    cvar: p.cvar, maxLoss: p.maxLoss, economicCapital: p.economicCapital,
    rarocAtEntry: p.rarocAtEntry, pLossAtEntry: p.pLossAtEntry,
    probabilities: p.probabilities,
    pTerminalBelowStrike: p.pTerminalBelowStrike,
    pTouchStrike: p.pTouchStrike,
    regimeAtEntry: p.regimeAtEntry, entrySpot: p.entrySpot,
    rules: p.rules,
  };
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
    liquidityRisk: c.evaluation?.liquidityRisk?.value,
    nevPerDay: Number.isFinite(c.evaluation?.nev) && Number.isFinite(c.dte) && c.dte > 0
      ? c.evaluation.nev / c.dte : null,
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
    success: c.success ?? null,
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

/** Does this package's recorded fingerprint still match its own content? */
export function verifyFingerprint(pkg) {
  return contentHash(decisionContent(pkg)) === pkg.decisionFingerprint;
}

export { stableStringify };
