/**
 * Execution cost model (§21).
 *
 * Applied at UNDERWRITING time, not reconciled afterwards. A candidate that
 * is only attractive before costs is not attractive, and discovering that
 * after the fill is how modelled edge quietly becomes realised loss.
 */
import { isNum } from '../math/stats.js';
import { mid } from '../structures/structure.js';

export const DEFAULT_COSTS = Object.freeze({
  version: 'execution-cost-v2',
  commissionPerContract: 0.65,
  exchangeFeePerContract: 0.15,
  assignmentFee: 5.00,
  // Fraction of the half-spread NUVO expects to give up per leg, per side.
  slippageHalfSpreads: 0.35,
  // Round trips are assumed: entry plus a managed exit.
  roundTrip: true,
});

/**
 * Costs not already embedded in the structure's executable entry price.
 *
 * Structure builders use `realisticFill`, so entry slippage is already in
 * the payoff and must not be subtracted a second time here. Closing costs are
 * included by default because NUVO's lifecycle rules mean most positions are
 * managed rather than simply expired. `allInTotal` reports both the embedded
 * entry slippage and the additional costs charged here.
 */
export function structureCost(structure, cfg = DEFAULT_COSTS) {
  const legs = structure.legs.filter((l) => l.right !== 'shares');
  const contracts = legs.reduce((s, l) => s + (l.quantity ?? 0), 0);
  const perContract = cfg.commissionPerContract + cfg.exchangeFeePerContract;
  const trips = cfg.roundTrip ? 2 : 1;

  let exitSlippage = 0;
  for (const leg of legs) {
    const c = leg.contract;
    const m = mid(c);
    if (!isNum(m) || !isNum(c?.bid) || !isNum(c?.ask)) continue;
    const half = (c.ask - c.bid) / 2;
    if (cfg.roundTrip) {
      exitSlippage += half * cfg.slippageHalfSpreads
        * (leg.quantity ?? 0) * (c.multiplier ?? 100);
    }
  }

  const commissions = contracts * perContract * trips;

  // Shares cost spread, not commission.
  let shareCost = 0;
  for (const leg of structure.legs.filter((l) => l.right === 'shares')) {
    shareCost += (leg.quantity ?? 0) * (leg.price ?? 0) * 0.0002 * trips;
  }

  const embeddedEntrySlippage = isNum(structure.entrySlippage)
    ? Math.max(0, structure.entrySlippage) : 0;
  const total = commissions + exitSlippage + shareCost;
  return {
    modelVersion: cfg.version ?? 'UNVERSIONED_EXECUTION_COST',
    commissions,
    slippage: exitSlippage,
    exitSlippage,
    embeddedEntrySlippage,
    allInSlippage: embeddedEntrySlippage + exitSlippage,
    shareCost,
    total,
    allInTotal: total + embeddedEntrySlippage,
    contracts,
    trips,
  };
}

/**
 * Cost as a fraction of the gross credit. A structure giving up a large
 * share of its premium to frictions is a bad structure even if its EV is
 * positive — it has no margin for the cost model being wrong.
 */
export function costRatio(structure, cfg = DEFAULT_COSTS) {
  const c = structureCost(structure, cfg);
  const gross = Math.abs(structure.credit) || Math.abs(structure.debit);
  return gross > 0 ? c.allInTotal / gross : Infinity;
}
