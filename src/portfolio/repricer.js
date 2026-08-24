/**
 * Position repricing under a shocked market.
 *
 * The Portfolio Governor's stress limits are unenforceable without one of
 * these, and a stress test that is silently skipped reads as a stress test
 * that passed. This supplies the honest version: every leg re-priced with
 * Black-Scholes at the shocked spot and vol, with time decay held constant
 * so the scenario measures market risk rather than the calendar.
 */
import { price, dteToT } from '../math/black_scholes.js';
import { isNum } from '../math/stats.js';

/**
 * Mark a position at a given spot and vol.
 * Returns the position's value in dollars — negative for a short option,
 * because the obligation is a liability.
 */
export function markPosition(pos, spot, vol) {
  if (!isNum(spot) || spot <= 0) return NaN;

  // Multi-leg: value each leg at the shocked market.
  if (Array.isArray(pos.legs) && pos.legs.length) {
    let value = 0;
    const scale = isNum(pos.contracts) && pos.contracts > 0
      ? pos.contracts / Math.max(1, legContracts(pos))
      : 1;
    for (const leg of pos.legs) {
      const sign = leg.action === 'SELL' ? -1 : 1;
      const qty = (leg.quantity ?? 0) * scale;
      if (leg.right === 'shares') {
        value += sign * qty * spot;
        continue;
      }
      const c = leg.contract;
      if (!c) return NaN;
      // Each leg keeps its own strike and its own vol offset from ATM, so
      // a spread's legs do not both move as if they were at the money.
      const legVol = Math.max(0.01, vol * legVolRatio(c, pos));
      const px = price({
        type: c.right ?? leg.right, spot, strike: c.strike ?? leg.strike,
        vol: legVol, t: dteToT(c.dte ?? pos.dte ?? 30), rate: 0.045,
      });
      if (!isNum(px)) return NaN;
      value += sign * qty * (c.multiplier ?? 100) * px;
    }
    return value;
  }

  // Single-leg / legacy shape.
  if (pos.right === 'shares' || pos.type === 'EQUITY') {
    return (pos.quantity ?? 0) * spot * (pos.multiplier ?? 1);
  }
  // An option without a strike is unpriceable, not equity. Treating an
  // incomplete option record as shares made stress tests silently pass.
  if (!isNum(pos.strike)) return NaN;
  const px = price({
    type: pos.right ?? 'put', spot, strike: pos.strike,
    vol: Math.max(0.01, vol), t: dteToT(pos.dte ?? 30), rate: 0.045,
  });
  return isNum(px) ? (pos.quantity ?? 0) * (pos.multiplier ?? 100) * px : NaN;
}

const legContracts = (pos) =>
  pos.legs.reduce((m, l) => Math.max(m, l.quantity ?? 0), 1);

/**
 * Preserve each leg's position on the skew when the surface is shocked.
 * Shocking every leg to the same vol collapses the skew and understates a
 * spread's loss, because the short leg's vol is the one that matters most.
 */
function legVolRatio(contract, pos) {
  const ref = pos.iv;
  if (!isNum(ref) || ref <= 0 || !isNum(contract.iv) || contract.iv <= 0) return 1;
  return contract.iv / ref;
}

/** The repricer signature the stress module expects. */
export const blackScholesRepricer = (pos, spot, vol) => markPosition(pos, spot, vol);
