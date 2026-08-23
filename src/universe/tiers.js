/**
 * The three universes (§7).
 *
 *   Tier A — structurally approved, the permanent operating universe.
 *   Tier B — conditionally admitted when compensation is unusually rich.
 *   Tier C — prohibited.
 *
 * Tier B exists so that an attractive premium can earn a name a hearing,
 * and admission is explicitly TEMPORARY and reasoned. It is not a back door
 * around Tier C: a name that fails liquidity, data or event gates cannot be
 * promoted by any amount of premium.
 */
import { TIER as HTIER } from '../constitution/hierarchy.js';
import {
  underlyingLiquidity, dataQuality, structuralRisk,
} from './filters.js';
import { isNum } from '../math/stats.js';

export const UNIVERSE_TIER = Object.freeze({ A: 'A', B: 'B', C: 'C' });

/**
 * Classify one underlying.
 *
 * Note the ordering: TRUTH-tier failures are disqualifying full stop.
 * Everything else can, at most, keep a name out of Tier A.
 */
export function classifyUnderlying(state, {
  limits,
  approved = new Set(),      // explicitly blessed Tier A membership
  vrpAdmissionRatio = 1.35,  // how rich the premium must be for Tier B
} = {}) {
  const fails = [
    ...underlyingLiquidity(state, limits),
    ...dataQuality(state),
    ...structuralRisk(state),
  ];

  const truthFails = fails.filter((f) => f.tier === HTIER.TRUTH);
  const survivalFails = fails.filter((f) => f.tier === HTIER.SURVIVAL);

  // A name NUVO cannot model or price is prohibited regardless of anything else.
  if (truthFails.length) {
    return {
      symbol: state.symbol, tier: UNIVERSE_TIER.C, reasons: fails,
      note: 'Prohibited: the truth requirements are not met.',
    };
  }
  if (survivalFails.length) {
    return {
      symbol: state.symbol, tier: UNIVERSE_TIER.C, reasons: fails,
      note: 'Prohibited: fails a structural or liquidity requirement.',
    };
  }

  if (approved.has(state.symbol)) {
    return { symbol: state.symbol, tier: UNIVERSE_TIER.A, reasons: fails, note: 'Structurally approved.' };
  }

  // Tier B admission is earned by compensation, and it expires.
  const ratio = state.vrp?.ratio;
  const forwardOk = isNum(state.vrp?.forward?.spread) && state.vrp.forward.spread > 0;
  if (isNum(ratio) && ratio >= vrpAdmissionRatio && forwardOk) {
    return {
      symbol: state.symbol,
      tier: UNIVERSE_TIER.B,
      reasons: fails,
      note: `Conditionally admitted: IV/RV ${ratio.toFixed(2)} with positive forward VRP.`,
      admission: { ratio, forwardSpread: state.vrp.forward.spread, expiresAfterCycles: 1 },
    };
  }

  return {
    symbol: state.symbol,
    tier: UNIVERSE_TIER.C,
    reasons: fails,
    note: 'Not structurally approved and compensation is not exceptional.',
  };
}

/**
 * Build the tradeable universe for a cycle.
 * Returns tiers plus the full rejection record — the rejected candidates
 * are part of the evidence package (§19), not discarded.
 */
export function buildUniverse(states, opts) {
  const classified = Object.values(states).map((s) => classifyUnderlying(s, opts));
  const byTier = { A: [], B: [], C: [] };
  for (const c of classified) byTier[c.tier].push(c);
  return {
    tierA: byTier.A,
    tierB: byTier.B,
    prohibited: byTier.C,
    tradeable: [...byTier.A, ...byTier.B].map((c) => c.symbol),
    classified,
  };
}

/**
 * Sector/cluster tags used by the Portfolio Governor. Kept here because
 * universe membership and concentration control must share one taxonomy.
 */
export function taxonomyOf(state) {
  return {
    symbol: state.symbol,
    sector: state.quote?.sector ?? 'UNKNOWN',
    beta: state.quote?.beta ?? null,
  };
}
