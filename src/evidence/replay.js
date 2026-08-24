/**
 * Deterministic replay (§19).
 *
 * "Every order should be reconstructable years later."
 *
 * That claim is only true if it can be demonstrated. This module rebuilds a
 * provider and broker that serve nothing but the raw payload captured in an
 * evidence package, reruns the cycle against them, and compares the result
 * to what was recorded.
 *
 * A package that does not replay is not evidence, however complete it looks.
 */
import { DataProvider } from '../truth/providers/provider.js';
import { BrokerAdapter } from '../execution/broker/adapter.js';
import { runCycle } from '../pipeline/cycle.js';
import { DEFAULT_LIMITS } from '../constitution/limits.js';
import { CalibrationStore } from '../underwriter/probabilities.js';
import { CapitalLedger } from '../portfolio/capital_states.js';
import { KillSwitchBoard } from '../constitution/killswitch.js';
import { StrategyRegistry } from '../registry/strategy_registry.js';
import { registerCatalogue } from '../registry/strategies/vsim_strategies.js';
import { contentHash } from '../execution/order.js';
import { decisionContent } from './package.js';

/** Serves exactly the captured bytes, and refuses anything not captured. */
export class ReplayProvider extends DataProvider {
  constructor(raw) {
    super('replay');
    this.raw = raw;
  }

  _sym(symbol) { return this.raw.symbols?.[symbol] ?? null; }

  async quote(symbol) {
    const s = this._sym(symbol);
    if (!s?.quote) return { error: `no captured quote for ${symbol}` };
    return { value: s.quote, asOf: s.quoteAsOf, source: 'replay' };
  }

  async optionChain(symbol) {
    const s = this._sym(symbol);
    if (!s?.chain) return { error: `no captured chain for ${symbol}` };
    return { value: s.chain, asOf: s.chainAsOf, source: 'replay' };
  }

  async history(symbol) {
    const s = this._sym(symbol);
    if (!s?.history) return { error: `no captured history for ${symbol}` };
    return { value: s.history, asOf: s.historyAsOf, source: 'replay' };
  }

  async events(symbol) {
    const s = this._sym(symbol);
    if (!s) return { error: `no captured events for ${symbol}` };
    return { value: s.events ?? [], asOf: s.eventsAsOf, source: 'replay' };
  }

  async marketState() {
    if (!this.raw.indexState) return { error: 'no captured index state' };
    return { value: this.raw.indexState, asOf: this.raw.indexAsOf, source: 'replay' };
  }
}

/** Read-only broker view reconstructed from the capture. */
export class ReplayBroker extends BrokerAdapter {
  constructor(raw) {
    super('replay');
    this.raw = raw;
  }

  async accountState() {
    if (!this.raw.account) return { error: 'no captured account state' };
    return { value: this.raw.account, asOf: this.raw.accountAsOf, source: 'replay' };
  }

  async positions() {
    return {
      value: this.raw.brokerPositions ?? [],
      asOf: this.raw.brokerPositionsAsOf,
      source: 'replay',
    };
  }

  async openOrders() {
    return {
      value: this.raw.brokerOpenOrders ?? [],
      asOf: this.raw.brokerOpenOrdersAsOf,
      source: 'replay',
    };
  }

  async submit() { return { error: 'replay is read-only; it may not submit orders' }; }
  async cancel() { return { error: 'replay is read-only' }; }
}

/**
 * Rerun a decision from its evidence package.
 *
 * Returns `{ reproduced, recordedHash, replayedHash, differences }`.
 * `reproduced` is true only when the replayed decision hashes identically
 * to the recorded one — anything less is a failure to reproduce, not a
 * near miss.
 */
export async function replay(pkg, { limits = null, rawInputs = null } = {}) {
  const raw = rawInputs ?? pkg.inputs?.data;
  if (!raw) {
    return {
      reproduced: false,
      reason: pkg.inputs?.externalized
        ? 'Raw payload was externalised; supply it via rawInputs to replay.'
        : 'Package captured no raw inputs and is therefore not replayable.',
    };
  }
  // An externalised payload must prove it is the one that was recorded.
  if (pkg.inputs?.hash && contentHash(raw) !== pkg.inputs.hash) {
    return {
      reproduced: false,
      reason: 'Supplied raw inputs do not match the hash recorded in the package.',
      expectedHash: pkg.inputs.hash,
      actualHash: contentHash(raw),
    };
  }

  const es = raw.engineState ?? {};
  const replayLimits = limits ?? es.limits ?? DEFAULT_LIMITS;
  if (pkg.limitsVersion && replayLimits.version !== pkg.limitsVersion) {
    return {
      reproduced: false,
      reason: `Recorded limits ${pkg.limitsVersion} are unavailable (got ${replayLimits.version}).`,
    };
  }
  const provider = new ReplayProvider(raw);
  const broker = new ReplayBroker(raw);
  const calibrationStore = restoreCalibration(es.calibration);
  const ledger = restoreLedger(es.ledger, es.nav, replayLimits);

  const result = await runCycle({
    cycleId: pkg.cycleId,
    now: raw.capturedAt,
    provider,
    broker,
    limits: replayLimits,
    killSwitches: new KillSwitchBoard(() => raw.capturedAt),
    ledger,
    registry: restoredRegistry(es.strategyId, es.strategyState),
    calibrationStore,
    authorityLevel: es.authorityLevel,
    positions: es.positions ?? [],
    reconcilePositions: es.reconcilePositions ?? [],
    reconcileAccount: es.reconcileAccount ?? null,
    reconcileOpenOrders: es.reconcileOpenOrders ?? [],
    symbols: Object.keys(raw.symbols ?? {}),
    approved: es.approved ?? Object.keys(raw.symbols ?? {}),
    nav: es.nav,
    drawdownPct: es.drawdownPct ?? 0,
    strategyId: es.strategyId,
    modelVersion: pkg.modelVersion,
    codeVersion: pkg.codeVersion,
    closedTradePnl: es.closedTradePnl ?? null,
    dteTargets: es.dteTargets,
    baseRiskPct: es.baseRiskPct,
    maxGovernanceAttempts: es.maxGovernanceAttempts,
    commitmentsThisCycle: es.commitmentsThisCycle,
    screenSamples: es.sampling?.screenSamples,
    decisionSamples: es.sampling?.decisionSamples,
    refineTop: es.sampling?.refineTop,
    indexExtras: es.indexExtras ?? {},
  });

  // Reproduction is judged on the DECISION fingerprint, not the whole
  // record: a faithful replay reads from a different provider and so
  // legitimately differs in source labels, while the decision is identical.
  const recordedFingerprint = pkg.decisionFingerprint
    ?? contentHash(decisionContent(pkg));
  const replayedFingerprint = result.evidence
    ? (result.evidence.decisionFingerprint ?? contentHash(decisionContent(result.evidence)))
    : null;
  const differences = diff(pkg, result.evidence);

  return {
    reproduced: recordedFingerprint === replayedFingerprint,
    recordedFingerprint,
    replayedFingerprint,
    recordedHash: pkg.hash,
    replayedHash: result.evidence?.hash ?? null,
    recordedDecision: pkg.decision,
    replayedDecision: result.evidence?.decision ?? null,
    differences,
    result,
  };
}

/** Registry with the recorded strategy live, so permissions match the original run. */
function restoredRegistry(strategyId, targetState = 'LIVE') {
  const r = registerCatalogue(new StrategyRegistry());
  const s = r.get(strategyId);
  if (!s || targetState === 'RESEARCH') return r;
  const reason = 'replay: restoring recorded state';
  if (targetState === 'REJECTED') {
    s.transition('REJECTED', reason);
    return r;
  }
  s.transition('VALIDATED', reason);
  if (targetState === 'VALIDATED') return r;
  s.transition('SHADOW', reason);
  if (targetState === 'SHADOW') return r;
  if (targetState === 'SUSPENDED' || targetState === 'TERMINATED') {
    s.transition(targetState, reason);
    return r;
  }
  s.transition('LIVE', reason);
  return r;
}

function restoreCalibration(saved) {
  const store = new CalibrationStore({
    bins: saved?.bins,
    minPerBin: saved?.minPerBin,
    minTotal: saved?.minTotal,
  });
  for (const obs of saved?.observations ?? []) store.record(obs);
  return store;
}

function restoreLedger(saved, nav, limits) {
  const ledger = new CapitalLedger({ nav, limits });
  if (saved) {
    for (const key of ['RESERVE', 'AVAILABLE', 'COMMITTED', 'AT_RISK', 'ASSIGNED', 'QUARANTINED']) {
      if (Number.isFinite(saved[key])) ledger.buckets[key] = saved[key];
    }
  }
  return ledger;
}

/** First-order comparison of the fields that decide a trade. */
function diff(a, b) {
  if (!b) return ['replay produced no evidence package'];
  const out = [];
  const check = (path, x, y) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${path}: recorded=${JSON.stringify(x)} replayed=${JSON.stringify(y)}`);
  };
  check('decision', a.decision, b.decision);
  check('market.regime', a.market?.regime, b.market?.regime);
  check('selected.kind', a.selected?.kind, b.selected?.kind);
  check('selected.shortStrike', a.selected?.shortStrike, b.selected?.shortStrike);
  check('selected.longStrike', a.selected?.longStrike, b.selected?.longStrike);
  check('selected.nev', a.selected?.nev, b.selected?.nev);
  check('selected.raroc', a.selected?.raroc, b.selected?.raroc);
  check('sizing.contracts', a.sizing?.contracts, b.sizing?.contracts);
  check('order.limitPrice', a.order?.limitPrice, b.order?.limitPrice);
  check('candidateCount', a.candidates?.length, b.candidates?.length);
  return out;
}
