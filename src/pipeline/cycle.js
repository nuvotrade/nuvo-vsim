/**
 * THE DECISION CYCLE (§25).
 *
 *   regime -> IV/realised dislocation -> skew -> conditional loss ->
 *   event clearance -> liquidity clearance -> all strikes/structures ->
 *   RAROC ranking -> portfolio correlation -> size -> order -> lifecycle ->
 *   calibration
 *
 * "That is the entire business."
 *
 * Every stage can terminate the cycle with NO_TRADE, and every termination
 * carries the tier and reason it happened at. The cycle NEVER throws its
 * way out of a decision: a failure produces a recorded refusal.
 */
import { verify, auditChain, VERDICT } from '../truth/contract.js';
import { reconcile, RECON } from '../truth/reconciliation.js';
import { buildUnderlyingState, buildMarketState } from '../market/market_state.js';
import { buildUniverse } from '../universe/tiers.js';
import { eventClearance } from '../universe/filters.js';
import { screenAndRefine, selectBest, structureComparison } from '../structures/optimizer.js';
import { govern } from '../portfolio/governor.js';
import { buildOrder } from '../execution/order.js';
import { createPositionContract } from '../lifecycle/contract.js';
import { buildEvidence } from '../evidence/package.js';
import { TIER, violation, governingTier, TIER_NAME } from '../constitution/hierarchy.js';
import { authorityValue, can, CAPITAL_AUTHORITY_FRACTION } from '../constitution/authority.js';
import { SWITCH } from '../constitution/killswitch.js';
import {
  lognormalTerminal, jumpDiffusionTerminal, studentTTerminal, ensembleTerminal,
  bootstrapTerminal,
} from '../math/distribution.js';
import { dteToT } from '../math/black_scholes.js';
import { isNum } from '../math/stats.js';
import { STRUCTURE } from '../structures/structure.js';
import { blackScholesRepricer } from '../portfolio/repricer.js';
import { Rng } from '../math/random.js';

export const OUTCOME = Object.freeze({
  ORDER: 'ORDER',
  PROPOSAL: 'PROPOSAL',   // Authority 2: plan built, human approval required
  NO_TRADE: 'NO_TRADE',
  REFUSED: 'REFUSED',     // truth/authority failure: fail closed
});

/** Listed expirations rarely equal a requested target DTE exactly. */
export function availableContractDtes(chain) {
  return [...new Set((chain?.contracts ?? []).map((contract) => contract.dte)
    .filter((dte) => Number.isFinite(dte) && dte > 0))].sort((a, b) => a - b);
}

/**
 * Build the forward distribution for one underlying at one tenor.
 *
 * An ensemble, because the disagreement between members is a first-class
 * input to sizing (§15). The seed is derived from the cycle so the whole
 * simulation is replayable from the evidence package.
 */
export function buildDistribution({
  spot, vol, dte, returns = null, seed, drift = 0, n = 20000,
  minBootstrapReturns = 120,
}) {
  const t = dteToT(dte);
  const members = [
    { dist: lognormalTerminal({ spot, vol, t, drift, n, seed: `${seed}:ln` }), weight: 1.0 },
    {
      // Jump parameters are deliberately harsher than a quiet-period fit
      // would produce. The cost of overstating crash risk is trades not
      // taken; the cost of understating it is the account.
      dist: jumpDiffusionTerminal({
        spot, vol, t, drift, n, seed: `${seed}:jd`,
        jumpIntensity: 2.0, jumpMean: -0.06, jumpVol: 0.10,
      }),
      weight: 1.5,
    },
    { dist: studentTTerminal({ spot, vol, t, drift, nu: 5, n, seed: `${seed}:st` }), weight: 1.0 },
  ];

  // The empirical member. Every other member imposes a shape on the
  // returns; this one asks what this underlying has actually done, in
  // blocks that preserve its own volatility clustering. Omitting it while
  // the history sits unused in the call signature made the ensemble
  // narrower than it claimed to be.
  if (Array.isArray(returns) && returns.length >= minBootstrapReturns) {
    members.push({
      dist: bootstrapTerminal({
        spot, returns, horizonDays: dte, drift, blockSize: 5, n, seed: `${seed}:bs`,
      }),
      weight: 1.25,
    });
  }

  return {
    dist: ensembleTerminal(members, { seed }),
    bootstrapIncluded: Array.isArray(returns) && returns.length >= minBootstrapReturns,
    // Pure-diffusion counterfactual, used to isolate gap risk.
    diffusionDist: lognormalTerminal({ spot, vol, t, drift, n, seed: `${seed}:ln` }),
  };
}

/**
 * Run one full decision cycle.
 *
 * Returns { outcome, ... , evidence } — never throws for a business reason.
 */
export async function runCycle(ctx) {
  const {
    cycleId, now, provider, broker, limits, killSwitches, ledger, registry,
    calibrationStore, authorityLevel, positions = [], reconcilePositions = null,
    reconcileAccount = null, reconcileOpenOrders = null,
    symbols, approved,
    nav, drawdownPct = 0, strategyId = 'VSIM-001',
    modelVersion = 'nuvo-model-5.0.1-execution-cost-v2', codeVersion = 'nuvo-5.0.0',
    dteTargets = [14, 30, 45], baseRiskPct = 0.02, maxGovernanceAttempts = 25,
    screenSamples = 3000, decisionSamples = 20_000, refineTop = 12,
    modelDrift = 0,
    structureAllowlist = null,
    commitmentsThisCycle = 0, closedTradePnl = null, externalizeRaw = false,
    portfolioReturnsBySymbol = {}, portfolioSectors = {},
    holdings = {},
  } = ctx;

  const trace = [];
  const step = (name, ok, detail) => { trace.push({ name, ok, detail }); return ok; };
  // Populated once the provider calls return; a refusal before that point
  // legitimately has nothing raw to record, and says so.
  let capturedRaw = null;
  const screenedOutAll = [];

  const refuse = (violations, extra = {}) => {
    const tier = governingTier(violations);
    return {
      outcome: OUTCOME.REFUSED,
      cycleId,
      governingTier: tier ? TIER_NAME[tier] : null,
      violations,
      reasons: violations.map(String),
      trace,
      ...extra,
      evidence: buildEvidence({
        cycleId, now, decision: OUTCOME.REFUSED, candidates: [],
        strategyId, modelVersion, codeVersion, limits, authorityLevel,
        rawInputs: capturedRaw, externalizeRaw,
        ...extra,
      }),
    };
  };

  // ── 0. Authority ─────────────────────────────────────────────────────
  if (!can(authorityLevel, 'rank')) {
    return refuse([violation(TIER.TRUTH, 'AUTHORITY_RESEARCH_ONLY',
      `Authority ${authorityLevel} may not evaluate live opportunities.`)]);
  }

  // ── 0a. Per-cycle commitment cap (§16) ───────────────────────────────
  // Declared in the constitution and previously never checked. It exists to
  // stop a single cycle from rebuilding the whole book in one pass.
  if (isNum(commitmentsThisCycle) && commitmentsThisCycle >= limits.maxNewCommitmentsPerCycle) {
    return refuse([violation(TIER.SURVIVAL, 'COMMITMENT_CAP',
      `${commitmentsThisCycle} commitments already made this cycle; limit is ${limits.maxNewCommitmentsPerCycle}.`,
      { commitmentsThisCycle, limit: limits.maxNewCommitmentsPerCycle })]);
  }

  // ── 0b. Kill switches ────────────────────────────────────────────────
  if (killSwitches?.blocksNewExposure()) {
    step('killSwitches', false, killSwitches.tripped.map((k) => k.name));
    return refuse(killSwitches.violations());
  }
  step('killSwitches', true, []);

  // ── 1. TRUTH ENGINE ──────────────────────────────────────────────────
  const account = await broker.accountState();
  const brokerPositions = await broker.positions();
  const brokerOrders = await broker.openOrders();
  const indexState = await provider.marketState();

  const chains = {};
  const histories = {};
  const quotes = {};
  const events = {};
  for (const sym of symbols) {
    chains[sym] = await provider.optionChain(sym, { expirations: dteTargets });
    histories[sym] = await provider.history(sym, { lookback: 400 });
    quotes[sym] = await provider.quote(sym);
    events[sym] = await provider.events(sym);
  }

  const sharedSnapshot = {
    accountState: account,
    marketStatus: { value: indexState.value?.status, asOf: indexState.asOf, source: 'provider' },
    positions: brokerPositions,
    openOrders: brokerOrders,
    buyingPower: { value: account.value?.buyingPower, asOf: account.asOf, source: 'broker' },
    modelVersion: { value: modelVersion, asOf: now, source: 'engine' },
  };

  /**
   * Everything the decision will be computed from, captured verbatim.
   * This is what makes a replay possible; summaries cannot reproduce a
   * decision, they can only describe one.
   */
  const rawInputs = {
    capturedAt: now,
    cycleId,
    account: account.value ?? null,
    accountAsOf: account.asOf ?? null,
    brokerPositions: brokerPositions.value ?? null,
    brokerPositionsAsOf: brokerPositions.asOf ?? null,
    brokerOpenOrders: brokerOrders.value ?? null,
    brokerOpenOrdersAsOf: brokerOrders.asOf ?? null,
    indexState: { ...(indexState.value ?? {}), ...(ctx.indexExtras ?? {}) },
    indexAsOf: indexState.asOf ?? null,
    indexError: indexState.error ?? null,
    symbols: Object.fromEntries(symbols.map((sym) => [sym, {
      quote: quotes[sym]?.value ?? null,
      quoteAsOf: quotes[sym]?.asOf ?? null,
      chain: chains[sym]?.value ?? null,
      chainAsOf: chains[sym]?.asOf ?? null,
      history: histories[sym]?.value ?? null,
      historyAsOf: histories[sym]?.asOf ?? null,
      events: events[sym]?.value ?? null,
      eventsAsOf: events[sym]?.asOf ?? null,
    }])),
    engineState: {
      // Strategy-level positions drive concentration, Greeks, stress and
      // sizing; the leg mirror exists only for broker reconciliation. Both
      // are decision inputs and must be captured separately.
      positions,
      reconcilePositions: reconcilePositions ?? [],
      reconcileAccount,
      reconcileOpenOrders: reconcileOpenOrders ?? [],
      nav, drawdownPct, authorityLevel: authorityValue(authorityLevel), strategyId,
      approved: approved ?? [],
      limits,
      dteTargets, baseRiskPct, maxGovernanceAttempts,
      commitmentsThisCycle,
      closedTradePnl: closedTradePnl ?? null,
      portfolioReturnsBySymbol,
      portfolioSectors,
      indexExtras: ctx.indexExtras ?? {},
      strategyState: registry?.get(strategyId)?.state ?? null,
      calibration: calibrationStore ? {
        bins: calibrationStore.binCount,
        minPerBin: calibrationStore.minPerBin,
        minTotal: calibrationStore.minTotal,
        observations: calibrationStore.observations,
      } : null,
      ledger: ledger?.snapshot?.() ?? null,
      limitsVersion: limits.version,
      seeds: { governor: `${cycleId}:governor`, distributions: `${cycleId}:<symbol>:<dte>` },
      sampling: { screenSamples, decisionSamples, refineTop },
      structureAllowlist,
      holdings,
    },
  };

  capturedRaw = rawInputs;
  let truthReport = null;
  for (const sym of symbols) {
    const report = verify({
      ...sharedSnapshot,
      underlyingQuote: quotes[sym],
      optionChain: chains[sym],
      greeks: { value: chains[sym]?.value ? true : undefined, asOf: chains[sym]?.asOf, source: 'chain' },
      eventCalendar: events[sym],
    }, { limits, now });
    truthReport ??= report;
    if (!report.tradeable) {
      killSwitches?.trip(SWITCH.DATA_INTEGRITY, `Truth contract not satisfied for ${sym}.`,
        { symbol: sym, ...report.summary() });
      step('truth', false, { symbol: sym, ...report.summary() });
      return refuse(report.violations, { truthReport: report });
    }
  }
  step('truth', true, { verdict: truthReport.verdict, symbols: [...symbols] });

  // Chain-level structural audit for every symbol, not just the first.
  for (const sym of symbols) {
    const problems = auditChain(chains[sym].value, { limits, now });
    if (problems.length) {
      step('chainAudit', false, { symbol: sym, problems: problems.map(String) });
      return refuse(problems, { truthReport });
    }
  }
  step('chainAudit', true, {});

  // ── 1b. Reconciliation (§16) ─────────────────────────────────────────
  const recon = reconcile({
    // Compared at LEG level in the broker's own schema — see
    // NuvoEngine.brokerView(). Passing strategy-level contracts here makes
    // every position look both phantom and unknown.
    engine: {
      positions: reconcilePositions ?? [],
      cash: reconcileAccount?.cash, buyingPower: reconcileAccount?.buyingPower,
      openOrders: reconcileOpenOrders ?? [],
    },
    broker: {
      positions: brokerPositions.value ?? [], cash: account.value.cash,
      buyingPower: account.value.buyingPower, openOrders: brokerOrders.value ?? [],
    },
  });
  if (recon.status === RECON.QUARANTINE) {
    ledger?.quarantine('Broker/engine reconciliation failed.');
    killSwitches?.trip(SWITCH.RECONCILIATION, 'Positions do not reconcile.', recon.details);
    step('reconciliation', false, recon.problems.map(String));
    return refuse(recon.problems, { truthReport });
  }
  step('reconciliation', true, { status: recon.status });

  // ── 2. MARKET STATE + REGIME ─────────────────────────────────────────
  const underlyings = {};
  for (const sym of symbols) {
    underlyings[sym] = buildUnderlyingState({
      symbol: sym,
      bars: histories[sym].value,
      chain: chains[sym].value,
      quote: quotes[sym].value,
      events: events[sym].value ?? [],
      dte: dteTargets[Math.floor(dteTargets.length / 2)],
    });
    underlyings[sym].nav = nav;
  }
  const marketState = buildMarketState({
    underlyings,
    indexState: { ...indexState.value, ...(ctx.indexExtras ?? {}) },
    limits,
    now,
  });
  step('regime', true, {
    regime: marketState.regime.regime,
    score: marketState.regime.score,
    confident: marketState.regime.confident,
  });

  // An unconfident regime call does not get trading authority (§6, §18).
  if (!marketState.regime.confident) {
    return noTradeResult({
      cycleId, now, reason: `Regime determined from only ${(marketState.regime.coverage * 100).toFixed(0)}% of its inputs; `
        + 'insufficient basis for new exposure.',
      trace, marketState, truthReport, strategyId, modelVersion, codeVersion, limits, authorityLevel,
      rawInputs: capturedRaw, externalizeRaw,
    });
  }

  // ── 3. UNIVERSE (§7) ─────────────────────────────────────────────────
  const universe = buildUniverse(underlyings, { limits, approved: new Set(approved ?? []) });
  step('universe', universe.tradeable.length > 0, {
    tierA: universe.tierA.map((c) => c.symbol),
    tierB: universe.tierB.map((c) => c.symbol),
    prohibited: universe.prohibited.map((c) => c.symbol),
  });
  if (!universe.tradeable.length) {
    return noTradeResult({
      cycleId, now, reason: 'No underlying cleared the universe requirements.',
      trace, marketState, truthReport, universe, strategyId, modelVersion, codeVersion, limits, authorityLevel,
      rawInputs: capturedRaw, externalizeRaw,
    });
  }

  // ── 4-9. UNDERWRITE EVERY CANDIDATE ──────────────────────────────────
  const strategy = registry?.get(strategyId) ?? null;
  const allCandidates = [];
  const screenLog = [];
  const distributionLog = [];

  for (const sym of universe.tradeable) {
    const st = underlyings[sym];
    // Event clearance BEFORE any scoring — §7's "do not score garbage".
    const listedDtes = availableContractDtes(chains[sym].value);
    if (!listedDtes.length) {
      trace.push({ name: 'listedExpirations', ok: false, detail: { symbol: sym, reason: 'NO_LISTED_DTE' } });
      continue;
    }
    const maxDte = Math.max(...listedDtes);
    const evFails = eventClearance(st, { dte: maxDte, limits, now });
    if (evFails.length) {
      trace.push({ name: 'eventClearance', ok: false, detail: { symbol: sym, reasons: evFails.map(String) } });
      continue;
    }
    // VRP screen (§25 step 2-3).
    if (!st.vrp.assessment.attractive) {
      trace.push({ name: 'vrpScreen', ok: false, detail: { symbol: sym, reasons: st.vrp.assessment.reasons } });
      continue;
    }

    for (const dte of listedDtes) {
      const seedBase = `${cycleId}:${sym}:${dte}`;
      // Coarse pass to rank the field, full pass to decide. Both are
      // seeded from the cycle, so the whole thing stays reproducible.
      const screen = buildDistribution({
        spot: st.spot, vol: st.realized, dte, returns: st.returns,
        seed: seedBase, n: screenSamples, drift: modelDrift,
      });
      const full = buildDistribution({
        spot: st.spot, vol: st.realized, dte, returns: st.returns,
        seed: seedBase, n: decisionSamples, drift: modelDrift,
      });
      distributionLog.push({
        symbol: sym, dte, modelDrift,
        bootstrapIncluded: full.bootstrapIncluded,
      });
      const chain = {
        ...chains[sym].value,
        contracts: chains[sym].value.contracts.filter((c) => c.dte === dte),
      };
      if (!chain.contracts.length) continue;

      const { candidates: cands, screenedOut, screenedCount } = screenAndRefine({
        underlyingState: st, chain,
        regime: marketState.regime, limits, calibrationStore, strategyId,
        holdings: holdings?.[sym] ?? null,
        allowedStructures: structureAllowlist ?? strategy?.allowedStructures ?? null,
        screenParams: { dist: screen.dist, diffusionDist: screen.diffusionDist },
        fullParams: { dist: full.dist, diffusionDist: full.diffusionDist },
        refineTop,
      });
      screenLog.push({ symbol: sym, dte, screened: screenedCount, refined: cands.length, droppedByScreen: screenedOut.length });
      screenedOutAll.push(...screenedOut);
      // Respect the strategy's own structure and regime permissions.
      const permittedStructures = structureAllowlist ?? strategy?.allowedStructures ?? null;
      const filtered = strategy
        ? cands.filter((c) =>
          permittedStructures.includes(c.structure.kind)
          && strategy.allowedRegimes.includes(marketState.regime.regime)
          && (c.dte === null || (c.dte >= strategy.dteBand[0] && c.dte <= strategy.dteBand[1])))
        : cands;
      allCandidates.push(...filtered);
    }
  }

  step('underwriting', allCandidates.length > 0, {
    screened: screenLog.reduce((s, l) => s + l.screened, 0),
    refined: allCandidates.length,
    admissible: allCandidates.filter((c) => c.admissible).length,
    bootstrapIncluded: distributionLog.every((d) => d.bootstrapIncluded),
  });

  const selection = selectBest(allCandidates, { limits });
  const comparison = structureComparison(allCandidates);

  if (!selection.selected) {
    return noTradeResult({
      cycleId, now, reason: selection.structure.reason,
      trace, marketState, truthReport, universe, candidates: allCandidates,
      comparison, strategyId, modelVersion, codeVersion, limits, authorityLevel,
      rawInputs: capturedRaw, externalizeRaw, screenedOut: screenedOutAll, distributions: distributionLog,
    });
  }
  step('ranking', true, {
    winner: selection.selected.structure.kind,
    decisionMetric: selection.selected.capital.decisionMetric,
    decisionValue: selection.selected.capital.decisionValue,
    comparison,
  });

  // ── 10. PORTFOLIO GOVERNOR (§14, §15) ────────────────────────────────
  //
  // The Governor may shrink or refuse, never enlarge or permit. When it
  // refuses the top-ranked candidate, the cycle walks DOWN the ranking
  // rather than giving up: a candidate that cannot be sized is not evidence
  // that the next one cannot either, and abandoning the whole cycle over it
  // would silently convert a capital constraint into a false NO_TRADE.
  const returnsBySymbol = {
    ...portfolioReturnsBySymbol,
    ...Object.fromEntries(Object.entries(underlyings).map(([s, u]) => [s, u.returns])),
  };
  const sectors = { ...portfolioSectors };
  for (const [symbol, underlying] of Object.entries(underlyings)) {
    const observed = underlying.quote?.sector;
    if (observed && observed !== 'UNKNOWN') sectors[symbol] = observed;
    else if (!sectors[symbol]) sectors[symbol] = 'UNKNOWN';
  }

  const governanceAttempts = [];
  let selected = null;
  let governance = null;

  for (const candidate of selection.ranked.slice(0, maxGovernanceAttempts)) {
    const g = govern({
      candidate, positions, nav, ledger, limits,
      regime: marketState.regime, returnsBySymbol, sectors, authorityLevel,
      drawdownPct, baseRiskPct,
      // Without these the stress, portfolio-CVaR and ruin limits cannot be
      // evaluated, and the Governor now refuses rather than passing silently.
      repricer: blackScholesRepricer,
      rng: new Rng(`${cycleId}:governor`),
      spot: underlyings[candidate.underlying]?.spot ?? null,
      beta: underlyings[candidate.underlying]?.quote?.beta ?? 1,
      closedTradePnl,
      // Fully-collateralised means settled cash, never broker buying power.
      settledCash: account.value.cash,
    });
    governanceAttempts.push({
      underlying: candidate.underlying,
      kind: candidate.structure.kind,
      shortStrike: candidate.structure.shortStrike,
      decisionMetric: candidate.capital.decisionMetric,
      decisionValue: candidate.capital.decisionValue,
      approved: g.approved,
      contracts: g.sizing.contracts,
      reasonCodes: g.violations.map((item) => item.code),
      reasons: g.violations.map(String),
      sizing: {
        binding: g.sizing.binding,
        deployable: g.sizing.deployable,
        caps: g.sizing.caps,
        zeroReason: g.sizing.zeroReason,
      },
      assignmentFunding: g.assignmentFunding ?? null,
    });
    if (g.approved) { selected = candidate; governance = g; break; }
  }

  step('governor', Boolean(selected), {
    attempted: governanceAttempts.length,
    approved: selected
      ? { underlying: selected.underlying, contracts: governance.sizing.contracts,
        multipliers: governance.sizing.multipliers, binding: governance.sizing.binding }
      : null,
    rejections: governanceAttempts.filter((a) => !a.approved).slice(0, 5),
  });

  if (!selected) {
    const first = governanceAttempts[0];
    return noTradeResult({
      cycleId, now,
      reason: `Portfolio Governor declined all ${governanceAttempts.length} ranked candidates. `
        + `Top candidate: ${first ? first.reasons.join(' ') : 'none evaluated'}`,
      trace, marketState, truthReport, universe, candidates: allCandidates,
      comparison, governance: null, selected: selection.selected,
      governanceAttempts,
      strategyId, modelVersion, codeVersion, limits, authorityLevel,
      rawInputs: capturedRaw, externalizeRaw, screenedOut: screenedOutAll, distributions: distributionLog,
    });
  }

  // ── 11. POSITION CONTRACT (§12) — before any order exists ────────────
  const positionContract = createPositionContract({
    underlying: selected.underlying,
    structure: selected.structure,
    candidate: selected,
    sizing: governance.sizing,
    regime: marketState.regime,
    limits, strategyId, modelVersion, codeVersion,
    thesis: strategy?.hypothesis ?? 'Downside volatility premium exceeds modelled conditional risk.',
    now,
  });
  positionContract.entrySpot = underlyings[selected.underlying].spot;

  // ── 12. ORDER ────────────────────────────────────────────────────────
  const built = buildOrder({
    candidate: selected, sizing: governance.sizing,
    position: positionContract, authorityLevel, limits, now,
    strategyId, modelVersion, codeVersion,
  });
  if (!built.ok) {
    return noTradeResult({
      cycleId, now, reason: built.violations.map((v) => v.message).join(' '),
      trace, marketState, truthReport, universe, candidates: allCandidates,
      comparison, governance, selected,
      strategyId, modelVersion, codeVersion, limits, authorityLevel,
      rawInputs: capturedRaw, externalizeRaw, screenedOut: screenedOutAll, distributions: distributionLog,
    });
  }

  const evidence = buildEvidence({
    cycleId, now,
    decision: can(authorityLevel, 'submit') ? OUTCOME.ORDER : OUTCOME.PROPOSAL,
    truthReport, marketState, universe, candidates: allCandidates,
    selected, governance, sizing: governance.sizing,
    order: built.order, positionContract, strategyId, modelVersion, codeVersion,
    limits, authorityLevel,
    rawInputs: capturedRaw, externalizeRaw,
    screenedOut: screenedOutAll,
    distributions: distributionLog,
  });

  return {
    outcome: can(authorityLevel, 'submit') ? OUTCOME.ORDER : OUTCOME.PROPOSAL,
    cycleId,
    regime: marketState.regime.regime,
    selected,
    ranked: selection.ranked,
    comparison,
    governance,
    governanceAttempts,
    sizing: governance.sizing,
    positionContract,
    order: built.order,
    marketState,
    universe,
    candidates: allCandidates,
    trace,
    evidence,
    requiresApproval: !can(authorityLevel, 'submit'),
  };
}

/** NO TRADE is a first-class, fully-evidenced outcome (§6). */
function noTradeResult({
  cycleId, now, reason, trace, marketState, truthReport, universe,
  candidates = [], comparison = null, governance = null, selected = null,
  governanceAttempts = null, rawInputs = null, externalizeRaw = false,
  screenedOut = [], distributions = null,
  strategyId, modelVersion, codeVersion, limits, authorityLevel,
}) {
  return {
    outcome: OUTCOME.NO_TRADE,
    cycleId,
    regime: marketState?.regime?.regime ?? null,
    reason,
    decision: STRUCTURE.NO_TRADE,
    comparison,
    candidates,
    marketState,
    universe,
    governance,
    governanceAttempts,
    trace,
    evidence: buildEvidence({
      cycleId, now, decision: STRUCTURE.NO_TRADE, truthReport, marketState,
      universe, candidates, selected, governance,
      strategyId, modelVersion, codeVersion, limits, authorityLevel,
      rawInputs, externalizeRaw, screenedOut, distributions,
    }),
    note: 'Idle capital is undesirable. Deploying capital into negative expectancy is worse.',
  };
}

export { OUTCOME as CYCLE_OUTCOME };
