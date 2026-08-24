/**
 * The Portfolio Governor (§14).
 *
 * It sits ABOVE the Underwriter and can veto anything the Underwriter
 * likes. Portfolio construction is more important than trade selection,
 * so the veto is one-directional: the Governor may shrink or refuse a
 * position, never enlarge or permit one.
 */
import { TIER, violation } from '../constitution/hierarchy.js';
import { isNum } from '../math/stats.js';
import { structureGreeks } from '../structures/structure.js';
import { buildClusters, clusterOf } from './clusters.js';
import { sizePosition } from './sizing.js';
import { stressTest, portfolioLossDistribution, ruinProbability } from './stress.js';

/**
 * Position-level Greeks for one holding.
 *
 * Prefers the leg set when present, because a position IS its legs. The
 * flat single-leg shape is still honoured for simple holdings, but a
 * multi-leg structure that arrives without legs returns zeros rather than
 * silently reporting one leg as the whole position.
 */
export function positionGreeks(pos) {
  if (Array.isArray(pos.legs) && pos.legs.length) {
    return structureGreeks({
      legs: pos.legs,
      // `contracts` on an open position is the filled size. The legs retain
      // their per-structure quantities, so scale from that original size.
      contracts: pos.structureContracts ?? 1,
    }, { contracts: pos.contracts ?? 1 });
  }
  const units = (pos.quantity ?? 0) * (pos.multiplier ?? 100);
  return {
    delta: (pos.delta ?? 0) * units,
    gamma: (pos.gamma ?? 0) * units,
    vega: (pos.vega ?? 0) * units,
    theta: (pos.theta ?? 0) * units,
  };
}

/**
 * Aggregate the book's Greeks, beta-weighted where a beta is known.
 *
 * Beta-weighted delta is a DOLLAR figure: position delta x spot x beta.
 * A position without a spot price therefore contributes nothing to it,
 * which would quietly understate the book's directional exposure — so a
 * missing spot is counted and surfaced rather than absorbed.
 */
export function portfolioGreeks(positions, { nav }) {
  const agg = {
    delta: 0, gamma: 0, vega: 0, theta: 0, betaWeightedDelta: 0, notional: 0,
    positionsMissingSpot: 0,
  };
  for (const p of positions) {
    const g = positionGreeks(p);
    agg.delta += g.delta;
    agg.gamma += g.gamma;
    agg.vega += g.vega;
    agg.theta += g.theta;
    if (isNum(p.spot) && p.spot > 0) {
      agg.betaWeightedDelta += g.delta * (p.beta ?? 1) * p.spot;
    } else {
      agg.positionsMissingSpot += 1;
    }
    const notionalRef = isNum(p.shortStrike) ? p.shortStrike : (p.spot ?? 0);
    agg.notional += Math.abs(notionalRef * (p.contracts ?? Math.abs(p.quantity ?? 0)) * (p.multiplier ?? 100));
  }
  return {
    ...agg,
    deltaPctNav: nav > 0 ? agg.betaWeightedDelta / nav : NaN,
    vegaPctNav: nav > 0 ? agg.vega / nav : NaN,
    gammaPctNav: nav > 0 ? agg.gamma / nav : NaN,
    notionalPctNav: nav > 0 ? agg.notional / nav : NaN,
  };
}

/** Exposure grouped by cluster, sector, underlying and expiration. */
export function exposures(positions, clustering, { nav }) {
  const byCluster = new Map();
  const bySector = new Map();
  const byUnderlying = new Map();
  const byExpiration = new Map();
  const addTo = (map, key, amt) => map.set(key, (map.get(key) ?? 0) + amt);

  for (const p of positions) {
    // Exposure measured as economic capital, which is what the limits mean.
    const amt = p.economicCapital ?? p.buyingPower ?? 0;
    const cl = clusterOf(clustering, p.underlying);
    addTo(byCluster, cl?.id ?? `SOLO:${p.underlying}`, amt);
    addTo(bySector, p.sector ?? 'UNKNOWN', amt);
    addTo(byUnderlying, p.underlying, amt);
    if (p.expiration) addTo(byExpiration, p.expiration, amt);
  }
  const pct = (m) => Object.fromEntries([...m].map(([k, v]) => [k, v / nav]));
  return {
    byCluster: Object.fromEntries(byCluster),
    bySector: Object.fromEntries(bySector),
    byUnderlying: Object.fromEntries(byUnderlying),
    byExpiration: Object.fromEntries(byExpiration),
    pctOfNav: {
      cluster: pct(byCluster), sector: pct(bySector),
      underlying: pct(byUnderlying), expiration: pct(byExpiration),
    },
  };
}

/**
 * Check the book against every constitutional portfolio limit.
 * Used both to audit the current book and to test a hypothetical addition.
 */
export function checkLimits({ positions, nav, limits, clustering, drawdownPct = 0 }) {
  const violations = [];
  const exp = exposures(positions, clustering, { nav });
  const greeks = portfolioGreeks(positions, { nav });

  for (const [id, pct] of Object.entries(exp.pctOfNav.cluster)) {
    if (pct > limits.maxClusterPct) {
      violations.push(violation(TIER.SURVIVAL, 'CLUSTER_LIMIT',
        `Cluster ${id} at ${(pct * 100).toFixed(1)}% of capital exceeds ${(limits.maxClusterPct * 100).toFixed(0)}%.`,
        { cluster: id, pct, members: clustering.clusters.find((c) => c.id === id)?.members }));
    }
  }
  for (const [sym, pct] of Object.entries(exp.pctOfNav.underlying)) {
    if (pct > limits.maxSingleUnderlyingPct) {
      violations.push(violation(TIER.SURVIVAL, 'UNDERLYING_LIMIT',
        `${sym} at ${(pct * 100).toFixed(1)}% exceeds ${(limits.maxSingleUnderlyingPct * 100).toFixed(0)}%.`, { sym, pct }));
    }
  }
  for (const [sec, pct] of Object.entries(exp.pctOfNav.sector)) {
    if (sec !== 'UNKNOWN' && pct > limits.maxSectorPct) {
      violations.push(violation(TIER.SURVIVAL, 'SECTOR_LIMIT',
        `Sector ${sec} at ${(pct * 100).toFixed(1)}% exceeds ${(limits.maxSectorPct * 100).toFixed(0)}%.`, { sec, pct }));
    }
  }
  for (const [exp2, pct] of Object.entries(exp.pctOfNav.expiration)) {
    if (pct > limits.maxExpirationPct) {
      violations.push(violation(TIER.SURVIVAL, 'EXPIRATION_LIMIT',
        `Expiration ${exp2} carries ${(pct * 100).toFixed(1)}% of capital, exceeding ${(limits.maxExpirationPct * 100).toFixed(0)}%.`,
        { expiration: exp2, pct }));
    }
  }
  if (isNum(greeks.deltaPctNav) && Math.abs(greeks.deltaPctNav) > limits.maxNetDeltaPctNav) {
    violations.push(violation(TIER.SURVIVAL, 'DELTA_LIMIT',
      `Beta-weighted delta is ${(greeks.deltaPctNav * 100).toFixed(0)}% of NAV.`, { delta: greeks.deltaPctNav }));
  }
  if (isNum(greeks.vegaPctNav) && Math.abs(greeks.vegaPctNav) > limits.maxNetVegaPctNav) {
    violations.push(violation(TIER.SURVIVAL, 'VEGA_LIMIT',
      `Net vega is ${(greeks.vegaPctNav * 100).toFixed(2)}% of NAV per vol point.`, { vega: greeks.vegaPctNav }));
  }
  if (isNum(greeks.gammaPctNav) && Math.abs(greeks.gammaPctNav) > limits.maxNetGammaPctNav) {
    violations.push(violation(TIER.SURVIVAL, 'GAMMA_LIMIT',
      `Net gamma is ${(greeks.gammaPctNav * 100).toFixed(3)}% of NAV.`, { gamma: greeks.gammaPctNav }));
  }
  // A position whose spot is unknown contributes nothing to beta-weighted
  // delta, so an unmeasurable book must not read as a flat one.
  if (greeks.positionsMissingSpot > 0) {
    violations.push(violation(TIER.TRUTH, 'EXPOSURE_UNMEASURABLE',
      `${greeks.positionsMissingSpot} position(s) lack a spot price; directional exposure is understated.`,
      { count: greeks.positionsMissingSpot }));
  }
  if (drawdownPct > limits.maxDrawdownPct) {
    violations.push(violation(TIER.SURVIVAL, 'DRAWDOWN_HALT',
      `Drawdown ${(drawdownPct * 100).toFixed(1)}% exceeds the ${(limits.maxDrawdownPct * 100).toFixed(0)}% halt.`, { drawdownPct }));
  } else if (drawdownPct > limits.softDrawdownPct) {
    violations.push(violation(TIER.SURVIVAL, 'DRAWDOWN_DERISK',
      `Drawdown ${(drawdownPct * 100).toFixed(1)}% past the ${(limits.softDrawdownPct * 100).toFixed(0)}% de-risking threshold.`,
      { drawdownPct, soft: true }));
  }

  return { violations, exposures: exp, greeks, passed: violations.length === 0 };
}

/**
 * Govern one candidate: size it, then test the book WITH it included.
 *
 * The order matters. Sizing then checking means the Governor evaluates the
 * portfolio that would actually exist, rather than approving a position and
 * discovering the concentration afterwards.
 */
export function govern({
  candidate, positions, nav, ledger, limits, regime, returnsBySymbol,
  sectors, authorityLevel, drawdownPct = 0, repricer = null, baseRiskPct = 0.02,
  spot = null, beta = 1, rng = null, closedTradePnl = null,
}) {
  const clustering = buildClusters(returnsBySymbol, {
    threshold: limits.clusterCorrelationThreshold, sectors,
  });
  const cluster = clusterOf(clustering, candidate.underlying);
  const currentExp = exposures(positions, clustering, { nav });
  const clusterExposure = currentExp.byCluster[cluster?.id ?? `SOLO:${candidate.underlying}`] ?? 0;

  // Average correlation of the candidate against what is already held.
  const heldSymbols = [...new Set(positions.map((p) => p.underlying))];
  const clusterCorrelation = heldSymbols.length
    ? (clustering.pairs
      .filter((p) => (p.a === candidate.underlying && heldSymbols.includes(p.b))
        || (p.b === candidate.underlying && heldSymbols.includes(p.a)))
      .reduce((s, p, _, arr) => s + Math.abs(p.rho) / arr.length, 0) || null)
    : null;

  const sizing = sizePosition({
    candidate, nav, ledger, regime, clusterExposure, clusterCorrelation,
    limits, authorityLevel, baseRiskPct, holdingsCount: positions.length,
  });

  if (sizing.contracts === 0) {
    return {
      approved: false, sizing, clustering, cluster,
      violations: [violation(TIER.CAPITAL_EFFICIENCY, 'SIZE_ZERO', sizing.zeroReason ?? 'Size resolved to zero.')],
    };
  }

  // Build the hypothetical position and re-check the whole book.
  //
  // It carries its LEGS, not a single leg's Greeks, and it carries a real
  // spot price. Both were wrong before: leg[0] overstates a spread's delta
  // by roughly two thirds, and a position with no spot contributes zero to
  // beta-weighted delta, so the Governor was testing a book that looked
  // both more directional per spread and less directional in aggregate
  // than the one it was about to create.
  if (!isNum(spot) || spot <= 0) {
    return {
      approved: false, sizing, clustering, cluster,
      violations: [violation(TIER.TRUTH, 'SPOT_UNAVAILABLE',
        `No verified spot price for ${candidate.underlying}; portfolio exposure cannot be measured.`)],
    };
  }
  const hypothetical = {
    id: 'HYPOTHETICAL',
    underlying: candidate.underlying,
    sector: sectors[candidate.underlying] ?? 'UNKNOWN',
    legs: candidate.structure.legs,
    structureContracts: candidate.structure.contracts ?? 1,
    contracts: sizing.contracts,
    quantity: -sizing.contracts,
    multiplier: candidate.structure.multiplier,
    spot,
    iv: candidate.structure.legs.find((l) => l.action === 'SELL')?.contract?.iv
      ?? candidate.structure.legs[0]?.contract?.iv,
    shortStrike: candidate.structure.shortStrike,
    longStrike: candidate.structure.longStrike ?? null,
    expiration: candidate.structure.expiration,
    beta: beta ?? 1,
    economicCapital: sizing.totalEconomicCapital,
    buyingPower: sizing.totalBuyingPower,
  };

  const check = checkLimits({
    positions: [...positions, hypothetical], nav, limits, clustering, drawdownPct,
  });

  // Soft de-risking warnings do not block; hard limits do.
  const blocking = check.violations.filter((v) => !v.detail?.soft);

  // ── Survival gates that need a repricer ─────────────────────────────
  //
  // These limits were declared in the constitution but never evaluated at
  // entry, which made them documentation. A limit that cannot block a
  // trade is not a limit.
  const bookWithCandidate = [...positions, hypothetical];
  let stress = null;
  let portfolioCvar = null;
  let ruin = null;

  if (repricer) {
    stress = stressTest({ positions: bookWithCandidate, nav, repricer, limits });
    if (!stress.valid) {
      blocking.push(violation(TIER.TRUTH, 'STRESS_UNMEASURABLE',
        'One or more positions could not be repriced; stress and CVaR cannot be trusted.',
        { errors: stress.invalid.flatMap((s) => s.errors ?? []) }));
    } else if (!stress.passed) {
      blocking.push(violation(TIER.SURVIVAL, 'STRESS_BREACH',
        `Stress scenario ${stress.worst.scenario} loses ${(Math.abs(stress.worstPctOfNav) * 100).toFixed(1)}% of NAV.`,
        { stress: stress.worst }));
    }

    if (rng) {
      const loss = portfolioLossDistribution({
        positions: bookWithCandidate, repricer, rng: rng.fork('portfolio-cvar'),
        paths: 2000, horizonDays: 5,
      });
      portfolioCvar = { ...loss, pctOfNav: nav > 0 ? loss.cvar95 / nav : NaN };
      if (!loss.valid || !isNum(portfolioCvar.pctOfNav)) {
        blocking.push(violation(TIER.TRUTH, 'PORTFOLIO_CVAR_UNMEASURABLE',
          loss.error ?? 'Portfolio CVaR could not be measured from the complete book.'));
      } else if (portfolioCvar.pctOfNav > limits.maxPortfolioCVaRPct) {
        blocking.push(violation(TIER.SURVIVAL, 'PORTFOLIO_CVAR_LIMIT',
          `Portfolio 95% CVaR is ${(portfolioCvar.pctOfNav * 100).toFixed(1)}% of NAV; limit ${(limits.maxPortfolioCVaRPct * 100).toFixed(0)}%.`,
          { cvar95: loss.cvar95, pctOfNav: portfolioCvar.pctOfNav }));
      }
    }
  } else {
    // Silence here would read as a pass. It is not one.
    blocking.push(violation(TIER.TRUTH, 'STRESS_NOT_EVALUATED',
      'No repricer supplied: portfolio stress and CVaR limits could not be evaluated.'));
  }

  // Ruin probability, gated on having enough realised P&L to mean anything.
  if (rng && Array.isArray(closedTradePnl) && closedTradePnl.length >= 30) {
    ruin = ruinProbability({
      perCyclePnl: closedTradePnl, nav, trials: 1000, cycles: 52,
      rng: rng.fork('ruin'),
    });
    if (isNum(ruin.probability) && ruin.probability > limits.maxRuinProbability) {
      blocking.push(violation(TIER.SURVIVAL, 'RUIN_LIMIT',
        `Ruin probability ${(ruin.probability * 100).toFixed(2)}% (SE ${(ruin.standardError * 100).toFixed(2)}%) exceeds ${(limits.maxRuinProbability * 100).toFixed(2)}%.`,
        ruin));
    }
  }

  return {
    approved: blocking.length === 0,
    sizing,
    clustering,
    cluster,
    clusterExposure,
    clusterCorrelation,
    portfolio: check,
    stress,
    portfolioCvar,
    ruin,
    violations: blocking,
    warnings: check.violations.filter((v) => v.detail?.soft),
  };
}
