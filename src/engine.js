/**
 * The assembled engine.
 *
 * One object holding every long-lived component, so a caller does not wire
 * ten subsystems together by hand and quietly omit one.
 */
import { DEFAULT_LIMITS } from './constitution/limits.js';
import { KillSwitchBoard, SWITCH } from './constitution/killswitch.js';
import { AUTHORITY, can, evaluatePromotion, evaluateDemotion } from './constitution/authority.js';
import { CapitalLedger } from './portfolio/capital_states.js';
import {
  CalibrationStore, calibrationTag, FORECAST_EVENT,
} from './underwriter/probabilities.js';
import { StrategyRegistry } from './registry/strategy_registry.js';
import { registerCatalogue } from './registry/strategies/vsim_strategies.js';
import { EvidenceStore } from './evidence/store.js';
import { OrderBook, fillQuality, contentHash } from './execution/order.js';
import { runCycle, OUTCOME } from './pipeline/cycle.js';
import { fullScoreboard, maxDrawdown } from './scoreboard/scoreboard.js';
import { buildClusters } from './portfolio/clusters.js';
import { exposures } from './portfolio/governor.js';
import { reconcile, RECON } from './truth/reconciliation.js';
import {
  verifyEvidence, verifyFingerprint, positionContractContent,
} from './evidence/package.js';

export class NuvoEngine {
  constructor({
    provider, broker, nav, limits = DEFAULT_LIMITS,
    authorityLevel = AUTHORITY.SHADOW, symbols = [], approved = [],
    clock = () => Date.now(), codeVersion = 'nuvo-5.0.0',
    modelVersion = 'nuvo-model-5.0.1-execution-cost-v2',
    evidenceStore = null, calibrationStore = null, accountMirror = null,
  }) {
    if (!provider) throw new Error('NuvoEngine requires a data provider.');
    if (!broker) throw new Error('NuvoEngine requires a broker adapter (use PaperBroker for shadow).');
    this.provider = provider;
    this.broker = broker;
    this.limits = limits;
    this.authorityLevel = authorityLevel;
    this.symbols = symbols;
    this.approved = approved;
    this.clock = clock;
    this.codeVersion = codeVersion;
    this.modelVersion = modelVersion;

    this.startingNav = nav;
    this.nav = nav;
    this.ledger = new CapitalLedger({ nav, limits });
    this.killSwitches = new KillSwitchBoard(clock);
    this.calibration = calibrationStore ?? new CalibrationStore();
    this.registry = registerCatalogue(new StrategyRegistry());
    // Production supplies an already-opened durable store. Default memory
    // storage is suitable only for research/paper runs and is blocked from
    // non-paper mutation below.
    this.evidence = evidenceStore ?? new EvidenceStore();
    this.orders = new OrderBook();
    this.accountMirror = accountMirror ?? { cash: nav, buyingPower: nav };

    this.positions = [];
    this.pendingPositions = [];
    /**
     * Leg-level mirror of the book, in the BROKER's schema.
     *
     * Reconciliation compares like with like. Position contracts are
     * multi-leg strategy objects (shortStrike/longStrike); the broker knows
     * only individual contracts (strike/right). Comparing the two directly
     * makes every filled position look simultaneously phantom and unknown,
     * which quarantines the engine permanently after its first fill.
     */
    this.legPositions = new Map();
    this.closedTrades = [];
    this.fills = [];
    this.equityCurve = [nav];
    this.breaches = [];
    this.cycles = 0;
  }

  get drawdownPct() {
    return maxDrawdown(this.equityCurve).current;
  }

  /** The book expressed the way the broker reports it, for reconciliation. */
  brokerView() {
    return [...this.legPositions.values()];
  }

  /** Apply a fill's legs to the leg-level mirror. */
  _applyLegs(order, sign = 1) {
    for (const leg of order.legs) {
      const key = leg.symbol;
      const prev = this.legPositions.get(key);
      const signed = sign * (leg.action === 'SELL' ? -1 : 1) * leg.quantity;
      const quantity = (prev?.quantity ?? 0) + signed;
      if (quantity === 0) this.legPositions.delete(key);
      else {
        this.legPositions.set(key, {
          underlying: order.intent.underlying,
          symbol: key,
          type: leg.right === 'shares' ? 'EQUITY' : 'OPTION',
          right: leg.right,
          strike: leg.strike,
          expiration: leg.expiration,
          quantity,
          multiplier: leg.right === 'shares' ? 1 : 100,
        });
      }
    }
  }

  /** Run one decision cycle and file the evidence, whatever the outcome. */
  async cycle({ cycleId = null, strategyId = 'VSIM-001', ...opts } = {}) {
    const now = this.clock();
    const id = cycleId ?? `CY-${String(this.cycles + 1).padStart(6, '0')}`;
    const existing = this.evidence.get(id);
    if (existing) {
      return {
        outcome: OUTCOME.REFUSED,
        cycleId: id,
        duplicateCycle: true,
        reason: `Cycle ${id} is already filed; refusing to create a second decision with the same identity.`,
        reasons: [`Cycle ${id} is already filed.`],
        evidence: existing,
      };
    }
    this.cycles += 1;

    const result = await runCycle({
      cycleId: id, now,
      provider: this.provider, broker: this.broker, limits: this.limits,
      killSwitches: this.killSwitches, ledger: this.ledger, registry: this.registry,
      calibrationStore: this.calibration, authorityLevel: this.authorityLevel,
      positions: [...this.positions, ...this.pendingPositions],
      reconcilePositions: this.brokerView(),
      reconcileAccount: this.accountMirror,
      reconcileOpenOrders: this.orders.open,
      closedTradePnl: this.closedTrades.map((t) => t.realizedPnl).filter(Number.isFinite),
      symbols: this.symbols, approved: this.approved,
      nav: this.nav, drawdownPct: this.drawdownPct, strategyId,
      modelVersion: this.modelVersion, codeVersion: this.codeVersion,
      ...opts,
    });

    if (result.evidence) {
      this.evidence.append(result.evidence);
      // A durable adapter is useful only if a failed write removes trading
      // authority. Do not return an executable result before its evidence is
      // known to have reached storage.
      if (this.evidence.durable) {
        await this.evidence.flush();
        if (this.evidence.persistenceError) {
          this.killSwitches.trip(SWITCH.DATA_INTEGRITY,
            `Evidence persistence failed: ${this.evidence.persistenceError.message}`);
          return {
            ...result,
            outcome: OUTCOME.REFUSED,
            reason: 'Evidence could not be persisted; mutation authority removed.',
            reasons: ['Evidence could not be persisted; mutation authority removed.'],
            evidencePersistenceError: this.evidence.persistenceError.message,
          };
        }
      }
    }

    // A refusal at TRUTH tier is a constitutional event worth counting, but
    // only when it was caused by the engine rather than by the market being
    // shut or the data simply being absent.
    if (result.outcome === OUTCOME.REFUSED) {
      for (const v of result.violations ?? []) {
        if (v.code?.startsWith('KILL_')) continue;
        this.breaches.push({ code: v.code, message: v.message, at: now, cycleId: id });
      }
    }
    return result;
  }

  /** Submit an approved order and record what the fill did to the edge. */
  async submit(result) {
    if (result.outcome !== OUTCOME.ORDER) {
      return { ok: false, reason: `Cycle outcome is ${result.outcome}; nothing to submit.` };
    }
    if (!can(this.authorityLevel, 'submit')) {
      return { ok: false, reason: 'Current authority no longer permits order submission.' };
    }
    if (this.killSwitches.blocksNewExposure()) {
      return { ok: false, reason: 'A kill switch currently blocks new exposure.' };
    }
    if (!result.evidence || !verifyEvidence(result.evidence) || !verifyFingerprint(result.evidence)) {
      this.killSwitches.trip(SWITCH.DATA_INTEGRITY, 'Order evidence is missing or invalid.');
      return { ok: false, reason: 'Order evidence is missing or invalid.' };
    }
    const orderContent = ({ clientOrderId, limitPrice, legs, expectation }) => ({
      clientOrderId, limitPrice, legs, expectation,
    });
    if (contentHash(orderContent(result.order)) !== contentHash(result.evidence.order)
      || contentHash(positionContractContent(result.positionContract))
        !== contentHash(result.evidence.positionContract)) {
      this.killSwitches.trip(SWITCH.DATA_INTEGRITY,
        'Executable order or position terms differ from their filed evidence.');
      return { ok: false, reason: 'Executable order or position terms differ from filed evidence.' };
    }
    const filed = this.evidence.get(result.cycleId);
    if (!filed || filed.hash !== result.evidence.hash || !this.evidence.verify().valid) {
      this.killSwitches.trip(SWITCH.DATA_INTEGRITY, 'Order evidence was not filed on a valid chain.');
      return { ok: false, reason: 'Order evidence was not filed on a valid chain.' };
    }
    if (this.broker.name !== 'paper' && !this.evidence.durable) {
      this.killSwitches.trip(SWITCH.DATA_INTEGRITY, 'Live mutation requires durable evidence storage.');
      return { ok: false, reason: 'Live mutation requires durable evidence storage.' };
    }

    // Re-check the mutable broker and session facts at the mutation boundary.
    // A decision that was valid one minute ago is not authority to trade a
    // changed account or a closed market now.
    const now = this.clock();
    const factsAsOf = result.evidence.truth?.factsAsOf ?? {};
    if (!Number.isFinite(factsAsOf.underlyingQuote)
      || now - factsAsOf.underlyingQuote > this.limits.maxQuoteAgeMs
      || !Number.isFinite(factsAsOf.optionChain)
      || now - factsAsOf.optionChain > this.limits.maxChainAgeMs) {
      return { ok: false, reason: 'The quote or option chain is stale at submission time.' };
    }
    const [account, positions, openOrders, session] = await Promise.all([
      this.broker.accountState(), this.broker.positions(), this.broker.openOrders(),
      this.provider.marketState(),
    ]);
    if ([account, positions, openOrders, session].some((x) => x?.error || !x?.value)) {
      return { ok: false, reason: 'Broker or market-session state could not be re-verified.' };
    }
    if (session.value.status !== 'OPEN') {
      return { ok: false, reason: `Market session is ${session.value.status ?? 'UNKNOWN'}; submission refused.` };
    }
    if (![account.asOf, positions.asOf, openOrders.asOf].every(Number.isFinite)
      || [account.asOf, positions.asOf, openOrders.asOf]
        .some((asOf) => now - asOf > this.limits.maxAccountAgeMs)) {
      return { ok: false, reason: 'Broker state is stale at submission time.' };
    }
    const preflight = reconcile({
      engine: {
        positions: this.brokerView(),
        cash: this.accountMirror.cash,
        buyingPower: this.accountMirror.buyingPower,
        openOrders: this.orders.open,
      },
      broker: {
        positions: positions.value,
        cash: account.value.cash,
        buyingPower: account.value.buyingPower,
        openOrders: openOrders.value,
      },
    });
    if (preflight.status === RECON.QUARANTINE) {
      this.ledger.quarantine('Pre-submit broker reconciliation failed.');
      this.killSwitches.trip(SWITCH.RECONCILIATION,
        'Broker state changed before submission.', preflight.details);
      return { ok: false, reason: 'Broker state changed before submission; capital quarantined.' };
    }
    // Reserve capital before crossing the broker boundary. This closes the
    // gap where two concurrent approved decisions could both spend the same
    // AVAILABLE dollars before either fill updated the ledger.
    const commitment = result.positionContract?.buyingPower;
    const reserved = this.ledger.move('AVAILABLE', 'COMMITTED', commitment,
      `submit ${result.order.clientOrderId}`);
    if (!reserved.ok) return { ok: false, reason: reserved.reason };

    const local = this.orders.submit(result.order);
    if (!local.ok) {
      this.ledger.move('COMMITTED', 'AVAILABLE', commitment,
        `duplicate/rejected ${result.order.clientOrderId}`);
      return local;
    }

    const resp = await this.broker.submit(result.order);
    if (resp.error) {
      this.orders.update(result.order.clientOrderId, { state: 'REJECTED', error: resp.error });
      this.ledger.move('COMMITTED', 'AVAILABLE', commitment,
        `broker rejected ${result.order.clientOrderId}`);
      return { ok: false, reason: resp.error };
    }
    this.orders.update(result.order.clientOrderId, {
      brokerOrderId: resp.value.brokerOrderId,
      state: resp.value.state,
    });
    const riskPosition = {
      ...structuredClone(result.positionContract),
      legs: structuredClone(result.selected.structure.legs),
      structureContracts: result.selected.structure.contracts ?? 1,
      quantity: -result.positionContract.contracts,
      sector: result.marketState?.underlyings?.[result.selected.underlying]?.quote?.sector ?? 'UNKNOWN',
      economicCapital: result.positionContract.economicCapital,
      buyingPower: result.positionContract.buyingPower,
      spot: result.positionContract.entrySpot,
      iv: result.selected.structure.legs.find((l) => l.action === 'SELL')?.contract?.iv
        ?? result.selected.structure.legs[0]?.contract?.iv,
      delta: result.selected.structure.legs[0]?.contract?.delta,
      vega: result.selected.structure.legs[0]?.contract?.vega,
      gamma: result.selected.structure.legs[0]?.contract?.gamma,
      beta: 1,
      evidenceMode: this.broker.name === 'paper' ? 'SHADOW' : 'LIVE',
      clientOrderId: result.order.clientOrderId,
      order: structuredClone(result.order),
    };
    if (resp.value.filled) {
      const q = fillQuality({ order: result.order, fill: resp.value.fill });
      q.evidenceMode = riskPosition.evidenceMode;
      this.fills.push(q);
      this.orders.update(result.order.clientOrderId, { state: 'FILLED', fill: resp.value.fill });
      this._applyLegs(result.order, 1);
      result.positionContract.state = 'OPEN';
      result.positionContract.order = result.order;
      result.positionContract.fill = resp.value.fill;
      const openPosition = { ...riskPosition, state: 'OPEN' };
      this.positions.push(openPosition);
      const impact = resp.value.accountImpact;
      if (Number.isFinite(impact?.cashDelta) && Number.isFinite(impact?.buyingPowerDelta)) {
        this.accountMirror.cash += impact.cashDelta;
        this.accountMirror.buyingPower += impact.buyingPowerDelta;
      } else {
        // The fill has happened, but its account effect is not reconstructable.
        // Stop here and require reconciliation before any further exposure.
        this.accountMirror.cash = NaN;
        this.accountMirror.buyingPower = NaN;
        this.killSwitches.trip(SWITCH.RECONCILIATION,
          'Broker fill omitted deterministic account-impact fields.');
      }
      const deployed = this.ledger.move('COMMITTED', 'AT_RISK', commitment,
        `open ${result.positionContract.id}`);
      if (!deployed.ok) {
        // The order is already filled, so this is an internal-integrity
        // emergency rather than a recoverable rejection.
        this.killSwitches.trip(SWITCH.DATA_INTEGRITY,
          `Filled order could not move committed capital to AT_RISK: ${deployed.reason}`);
      }
      return {
        ok: true, filled: true, fillQuality: q,
        position: structuredClone(openPosition),
      };
    }
    this.pendingPositions.push({ ...riskPosition, state: 'PENDING' });
    return { ok: true, filled: false, state: resp.value.state };
  }

  /**
   * Record a resolved position: its P&L, and — just as importantly —
   * whether the probability NUVO quoted came true. That second part is
   * what eventually earns authority (§17, §21).
   */
  recordOutcome({
    position, realizedPnl, strategyId,
    finishedBelowStrike, touchedStrike,
  }) {
    // The two events are demanded separately and neither is inferred from
    // the other. A position can finish above its strike having been deep
    // through it for a week; grading the terminal forecast on that path
    // would score a correct call as a miss.
    const pTerminal = position.pTerminalBelowStrike ?? position.probabilities?.pModel;
    if (typeof finishedBelowStrike !== 'boolean') {
      throw new Error(
        'recordOutcome requires finishedBelowStrike (the terminal event p_model predicted). '
        + 'Passing an ambiguous "breached" flag conflates terminal and touch probabilities.',
      );
    }
    if (touchedStrike !== undefined && typeof touchedStrike !== 'boolean') {
      throw new Error('recordOutcome requires touchedStrike to be boolean when supplied.');
    }
    if (!Number.isFinite(realizedPnl)) {
      throw new Error('recordOutcome requires a finite realizedPnl.');
    }
    this.nav += realizedPnl;
    this.equityCurve.push(this.nav);
    this.closedTrades.push({
      ...position, realizedPnl,
      capitalEmployed: position.buyingPower,
      economicCapital: position.economicCapital,
    });
    const tagFor = (event) => calibrationTag(strategyId ?? position.strategyId, event);
    const evidenceMode = position.evidenceMode === 'LIVE' ? 'LIVE' : 'SHADOW';

    // Terminal forecast: P(S_T < K), scored on that exact event. Storing its
    // complement would preserve Brier score but change the learned intercept,
    // so applying that calibration back to p(below) would be wrong.
    if (Number.isFinite(pTerminal)) {
      this.calibration.record({
        p: pTerminal,
        outcome: finishedBelowStrike,
        tag: tagFor(FORECAST_EVENT.TERMINAL_BELOW_STRIKE),
        evidenceMode,
        at: this.clock(),
      });
    }

    // Path forecast: P(never touched K). Only recorded when the caller
    // actually observed the path — inferring it from the terminal outcome
    // would fabricate the very data this separation exists to protect.
    const pTouch = position.pTouchStrike;
    if (Number.isFinite(pTouch) && touchedStrike !== undefined) {
      this.calibration.record({
        p: pTouch,
        outcome: touchedStrike,
        tag: tagFor(FORECAST_EVENT.TOUCHED_STRIKE),
        evidenceMode,
        at: this.clock(),
      });
    }
    const idx = this.positions.findIndex((p) => p.id === position.id);
    if (idx >= 0) {
      const held = this.positions[idx];
      this.ledger.move('AT_RISK', 'AVAILABLE', held.buyingPower, `close ${position.id}`);
      // Unwind the leg mirror too, or the next reconciliation will report
      // a phantom position and quarantine the engine.
      if (held.order) this._applyLegs(held.order, -1);
      this.positions.splice(idx, 1);
    }
    // Drawdown halt is checked on every resolution, not once a day.
    if (this.drawdownPct > this.limits.maxDrawdownPct) {
      this.killSwitches.trip(SWITCH.DRAWDOWN,
        `Drawdown ${(this.drawdownPct * 100).toFixed(1)}% breached the halt.`);
    }
    return this;
  }

  scoreboard({
    returnsBySymbol = {}, sectors = {}, stress = null, ruin = null,
    authorityOnly = false,
  } = {}) {
    const clustering = buildClusters(returnsBySymbol, {
      threshold: this.limits.clusterCorrelationThreshold, sectors,
    });
    const riskPositions = [...this.positions, ...this.pendingPositions];
    const exp = exposures(riskPositions, clustering, { nav: this.nav });
    const days = Math.max(1, this.equityCurve.length);
    return fullScoreboard({
      economic: {
        trades: this.closedTrades, nav: this.nav, startingNav: this.startingNav, days,
      },
      // Scored on the terminal board only. Mixing in touch forecasts would
      // blend two different questions into one slope.
      calibration: {
        store: this.calibration,
        tagSuffix: `|${FORECAST_EVENT.TERMINAL_BELOW_STRIKE}`,
        evidenceMode: authorityOnly ? 'LIVE' : null,
      },
      execution: { fills: this.fills, evidenceMode: authorityOnly ? 'LIVE' : null },
      constitutional: {
        cycles: this.cycles, breaches: this.breaches, killSwitchBoard: this.killSwitches,
      },
      survival: {
        equityCurve: this.equityCurve, positions: riskPositions, nav: this.nav,
        limits: this.limits, stress, ruin, exposures: exp,
      },
    });
  }

  /** Evidence for the authority ladder, assembled from the live scoreboards. */
  authorityEvidence() {
    // Promotion gates explicitly require LIVE observations. Synthetic/paper
    // outcomes remain visible for research but can never promote authority.
    const sb = this.scoreboard({ authorityOnly: true });
    return {
      liveObservations: sb.calibration.n,
      brierScore: sb.calibration.brierScore,
      calibrationSlope: sb.calibration.calibrationSlope,
      executionEdgeRetained: sb.execution.edgeRetained,
      constitutionalBreaches: this.breaches.length,
      maxDrawdownPct: sb.survival.maxDrawdownPct,
      profitFactor: sb.economic.profitFactor,
      dataIntegrityFailure: this.killSwitches.isTripped(SWITCH.DATA_INTEGRITY),
    };
  }

  /** Promotion and demotion are both evaluated; demotion always wins. */
  reviewAuthority() {
    const ev = this.authorityEvidence();
    const dem = evaluateDemotion(this.authorityLevel, ev);
    if (dem.demote) {
      const from = this.authorityLevel;
      this.authorityLevel = dem.target;
      return { changed: true, direction: 'DEMOTION', from, to: dem.target, reasons: dem.reasons };
    }
    const pro = evaluatePromotion(this.authorityLevel, ev);
    if (pro.eligible) {
      const from = this.authorityLevel;
      this.authorityLevel = pro.target;
      return { changed: true, direction: 'PROMOTION', from, to: pro.target, gate: pro.gate };
    }
    return { changed: false, direction: null, blockers: pro.failures, evidence: ev };
  }
}

export { OUTCOME };
