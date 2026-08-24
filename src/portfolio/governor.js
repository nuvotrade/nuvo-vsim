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
import { buildClusters, clusterOf } from './clusters.js';
import { sizePosition } from './sizing.js';
import { stressTest } from './stress.js';

/** Aggregate the book's Greeks, beta-weighted where a beta is known. */
export function portfolioGreeks(positions, { nav }) {
  const agg = { delta: 0, gamma: 0, vega: 0, theta: 0, betaWeightedDelta: 0, notional: 0 };
  for (const p of positions) {
    const q = p.quantity ?? 1;
    const mult = p.multiplier ?? 100;
    agg.delta += (p.delta ?? 0) * q * mult;
    agg.gamma += (p.gamma ?? 0) * q * mult;
    agg.vega += (p.vega ?? 0) * q * mult;
    agg.theta += (p.theta ?? 0) * q * mult;
    agg.betaWeightedDelta += (p.delta ?? 0) * q * mult * (p.beta ?? 1) * (p.spot ?? 1);
    agg.notional += Math.abs((p.shortStrike ?? p.spot ?? 0) * q * mult);
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
  const hypothetical = {
    id: 'HYPOTHETICAL',
    underlying: candidate.underlying,
    sector: sectors[candidate.underlying] ?? 'UNKNOWN',
    quantity: -sizing.contracts,
    multiplier: candidate.structure.multiplier,
    delta: candidate.structure.legs[0]?.contract?.delta ?? 0,
    gamma: candidate.structure.legs[0]?.contract?.gamma ?? 0,
    vega: candidate.structure.legs[0]?.contract?.vega ?? 0,
    theta: candidate.structure.legs[0]?.contract?.theta ?? 0,
    spot: candidate.structure.legs[0]?.contract ? undefined : undefined,
    shortStrike: candidate.structure.shortStrike,
    expiration: candidate.structure.expiration,
    beta: 1,
    economicCapital: sizing.totalEconomicCapital,
    buyingPower: sizing.totalBuyingPower,
  };

  const check = checkLimits({
    positions: [...positions, hypothetical], nav, limits, clustering, drawdownPct,
  });

  // Soft de-risking warnings do not block; hard limits do.
  const blocking = check.violations.filter((v) => !v.detail?.soft);

  let stress = null;
  if (repricer) {
    stress = stressTest({ positions: [...positions, hypothetical], nav, repricer, limits });
    if (!stress.passed) {
      blocking.push(violation(TIER.SURVIVAL, 'STRESS_BREACH',
        `Stress scenario ${stress.worst.scenario} loses ${(Math.abs(stress.worstPctOfNav) * 100).toFixed(1)}% of NAV.`,
        { stress: stress.worst }));
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
    violations: blocking,
    warnings: check.violations.filter((v) => v.detail?.soft),
  };
}
