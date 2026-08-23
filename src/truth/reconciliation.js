/**
 * Broker/engine reconciliation (§16).
 *
 * "If broker state and NUVO state disagree: QUARANTINE."
 *
 * The Schwab discrepancies that motivated this are the ordinary case, not
 * the exotic one: a fill lands between polls, a corporate action restates a
 * position, an order is cancelled by the venue. Every one of those makes
 * NUVO's internal book a fiction. Fiction plus leverage is how accounts die.
 */
import { TIER, violation } from '../constitution/hierarchy.js';
import { isNum } from '../math/stats.js';

export const RECON = Object.freeze({
  PASS: 'PASS',
  DRIFT: 'DRIFT',         // small, explainable, tolerated with a note
  QUARANTINE: 'QUARANTINE',
});

const key = (p) => [p.underlying, p.type ?? 'EQUITY', p.expiration ?? '', p.strike ?? '', p.right ?? '']
  .join('|');

/**
 * Compare the engine's book against the broker's.
 * Tolerances are deliberately tight: cash may drift by rounding, quantities
 * may not drift at all.
 */
export function reconcile({ engine, broker }, { cashTolerance = 1.0, bpTolerancePct = 0.005 } = {}) {
  const problems = [];
  const details = { missingInEngine: [], missingInBroker: [], quantityMismatch: [] };

  const eMap = new Map((engine.positions ?? []).map((p) => [key(p), p]));
  const bMap = new Map((broker.positions ?? []).map((p) => [key(p), p]));

  for (const [k, bp] of bMap) {
    const ep = eMap.get(k);
    if (!ep) {
      details.missingInEngine.push({ key: k, brokerQty: bp.quantity });
      problems.push(violation(TIER.TRUTH, 'POSITION_UNKNOWN',
        `Broker holds ${bp.quantity} of ${k} that the engine does not know about.`, { key: k }));
    } else if (ep.quantity !== bp.quantity) {
      details.quantityMismatch.push({ key: k, engineQty: ep.quantity, brokerQty: bp.quantity });
      problems.push(violation(TIER.TRUTH, 'POSITION_QTY_MISMATCH',
        `Quantity mismatch on ${k}: engine ${ep.quantity}, broker ${bp.quantity}.`,
        { key: k, engineQty: ep.quantity, brokerQty: bp.quantity }));
    }
  }
  for (const [k, ep] of eMap) {
    if (!bMap.has(k)) {
      details.missingInBroker.push({ key: k, engineQty: ep.quantity });
      problems.push(violation(TIER.TRUTH, 'POSITION_PHANTOM',
        `Engine believes it holds ${ep.quantity} of ${k}; broker does not.`, { key: k }));
    }
  }

  // Cash and buying power.
  if (isNum(engine.cash) && isNum(broker.cash)) {
    const diff = Math.abs(engine.cash - broker.cash);
    details.cashDiff = diff;
    if (diff > cashTolerance) {
      problems.push(violation(TIER.TRUTH, 'CASH_MISMATCH',
        `Cash differs by ${diff.toFixed(2)} (tolerance ${cashTolerance.toFixed(2)}).`,
        { engine: engine.cash, broker: broker.cash, diff }));
    }
  } else {
    problems.push(violation(TIER.TRUTH, 'CASH_UNVERIFIED', 'Cash is not verifiable on both sides.'));
  }

  if (isNum(engine.buyingPower) && isNum(broker.buyingPower)) {
    const base = Math.max(Math.abs(broker.buyingPower), 1);
    const rel = Math.abs(engine.buyingPower - broker.buyingPower) / base;
    details.buyingPowerRelDiff = rel;
    if (rel > bpTolerancePct) {
      problems.push(violation(TIER.TRUTH, 'BP_MISMATCH',
        `Buying power differs by ${(rel * 100).toFixed(2)}%.`,
        { engine: engine.buyingPower, broker: broker.buyingPower }));
    }
  }

  // Orders the engine never issued are the most alarming case of all.
  const eOrders = new Set((engine.openOrders ?? []).map((o) => o.brokerOrderId ?? o.id));
  for (const o of broker.openOrders ?? []) {
    if (!eOrders.has(o.brokerOrderId ?? o.id)) {
      problems.push(violation(TIER.TRUTH, 'ORDER_UNKNOWN',
        `Broker reports open order ${o.brokerOrderId ?? o.id} unknown to the engine.`, { order: o }));
    }
  }

  const fatal = problems.some((p) => p.code !== 'CASH_MISMATCH');
  let status;
  if (!problems.length) status = RECON.PASS;
  else if (!fatal) status = RECON.DRIFT;
  else status = RECON.QUARANTINE;

  return { status, problems, details, passed: status === RECON.PASS };
}
