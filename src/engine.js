/**
 * The assembled engine.
 *
 * One object holding every long-lived component, so a caller does not wire
 * ten subsystems together by hand and quietly omit one.
 */
import { DEFAULT_LIMITS } from './constitution/limits.js';
import { KillSwitchBoard, SWITCH } from './constitution/killswitch.js';
import { AUTHORITY, evaluatePromotion, evaluateDemotion } from './constitution/authority.js';
import { CapitalLedger } from './portfolio/capital_states.js';
import { CalibrationStore } from './underwriter/probabilities.js';
import { StrategyRegistry } from './registry/strategy_registry.js';
import { registerCatalogue } from './registry/strategies/vsim_strategies.js';
import { EvidenceStore } from './evidence/store.js';
import { OrderBook, fillQuality } from './execution/order.js';
import { runCycle, OUTCOME } from './pipeline/cycle.js';
import { fullScoreboard, maxDrawdown } from './scoreboard/scoreboard.js';
import { buildClusters } from './portfolio/clusters.js';
import { exposures } from './portfolio/governor.js';

export class NuvoEngine {
  constructor({
    provider, broker, nav, limits = DEFAULT_LIMITS,
    authorityLevel = AUTHORITY.SHADOW, symbols = [], approved = [],
    clock = () => Date.now(), codeVersion = 'nuvo-5.0.0',
    modelVersion = 'nuvo-model-5.0.0',
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
    this.calibration = new CalibrationStore();
    this.registry = registerCatalogue(new StrategyRegistry());
    this.evidence = new EvidenceStore();
    this.orders = new OrderBook();

    this.positions = [];
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
    this.cycles += 1;

    const result = await runCycle({
      cycleId: id, now,
      provider: this.provider, broker: this.broker, limits: this.limits,
      killSwitches: this.killSwitches, ledger: this.ledger, registry: this.registry,
      calibrationStore: this.calibration, authorityLevel: this.authorityLevel,
      positions: this.positions,
      reconcilePositions: this.brokerView(),
      symbols: this.symbols, approved: this.approved,
      nav: this.nav, drawdownPct: this.drawdownPct, strategyId,
      modelVersion: this.modelVersion, codeVersion: this.codeVersion,
      ...opts,
    });

    if (result.evidence) this.evidence.append(result.evidence);

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
    const local = this.orders.submit(result.order);
    if (!local.ok) return local;

    const resp = await this.broker.submit(result.order);
    if (resp.error) {
      this.orders.update(result.order.clientOrderId, { state: 'REJECTED', error: resp.error });
      return { ok: false, reason: resp.error };
    }
    if (resp.value.filled) {
      const q = fillQuality({ order: result.order, fill: resp.value.fill });
      this.fills.push(q);
      this.orders.update(result.order.clientOrderId, { state: 'FILLED', fill: resp.value.fill });
      this._applyLegs(result.order, 1);
      result.positionContract.state = 'OPEN';
      result.positionContract.order = result.order;
      result.positionContract.fill = resp.value.fill;
      this.positions.push({
        ...result.positionContract,
        quantity: -result.positionContract.contracts,
        sector: result.marketState?.underlyings?.[result.selected.underlying]?.quote?.sector ?? 'UNKNOWN',
        economicCapital: result.positionContract.economicCapital,
        buyingPower: result.positionContract.buyingPower,
        spot: result.positionContract.entrySpot,
        iv: result.selected.structure.legs[0]?.contract?.iv,
        delta: result.selected.structure.legs[0]?.contract?.delta,
        vega: result.selected.structure.legs[0]?.contract?.vega,
        gamma: result.selected.structure.legs[0]?.contract?.gamma,
        beta: 1,
      });
      this.ledger.move('AVAILABLE', 'AT_RISK', result.positionContract.buyingPower, `open ${result.positionContract.id}`);
      return { ok: true, filled: true, fillQuality: q, position: result.positionContract };
    }
    return { ok: true, filled: false, state: resp.value.state };
  }

  /**
   * Record a resolved position: its P&L, and — just as importantly —
   * whether the probability NUVO quoted came true. That second part is
   * what eventually earns authority (§17, §21).
   */
  recordOutcome({ position, realizedPnl, breached, strategyId }) {
    this.nav += realizedPnl;
    this.equityCurve.push(this.nav);
    this.closedTrades.push({
      ...position, realizedPnl,
      capitalEmployed: position.buyingPower,
      economicCapital: position.economicCapital,
    });
    if (position.probabilities && Number.isFinite(position.probabilities.pModel)) {
      // The forecast being scored is P(no breach) — the event NUVO priced.
      this.calibration.record({
        p: 1 - position.probabilities.pModel,
        outcome: !breached,
        tag: strategyId ?? position.strategyId,
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

  scoreboard({ returnsBySymbol = {}, sectors = {}, stress = null, ruin = null } = {}) {
    const clustering = buildClusters(returnsBySymbol, {
      threshold: this.limits.clusterCorrelationThreshold, sectors,
    });
    const exp = exposures(this.positions, clustering, { nav: this.nav });
    const days = Math.max(1, this.equityCurve.length);
    return fullScoreboard({
      economic: {
        trades: this.closedTrades, nav: this.nav, startingNav: this.startingNav, days,
      },
      calibration: { store: this.calibration },
      execution: { fills: this.fills },
      constitutional: {
        cycles: this.cycles, breaches: this.breaches, killSwitchBoard: this.killSwitches,
      },
      survival: {
        equityCurve: this.equityCurve, positions: this.positions, nav: this.nav,
        limits: this.limits, stress, ruin, exposures: exp,
      },
    });
  }

  /** Evidence for the authority ladder, assembled from the live scoreboards. */
  authorityEvidence() {
    const sb = this.scoreboard();
    return {
      liveObservations: this.calibration.n,
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
