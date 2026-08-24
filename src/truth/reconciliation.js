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
export function reconcile({ engine, broker }, {
  cashTolerance = 1.0,
  cashQuarantineTolerance = Math.max(1, cashTolerance * 5),
  bpTolerancePct = 0.005,
} = {}) {
  const problems = [];
  const details = {
    missingInEngine: [], missingInBroker: [], quantityMismatch: [],
    missingOrdersInEngine: [], missingOrdersInBroker: [],
  };

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
      const code = diff > cashQuarantineTolerance ? 'CASH_MISMATCH_FATAL' : 'CASH_MISMATCH';
      problems.push(violation(TIER.TRUTH, code,
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
  } else {
    problems.push(violation(TIER.TRUTH, 'BP_UNVERIFIED',
      'Buying power is not verifiable on both sides.'));
  }

  // Compare working orders in both directions. A broker-only order may be
  // unauthorized; an engine-only order may have vanished or filled while
  // the engine was offline. Either invalidates mutation authority.
  const orderKey = (o) => o.brokerOrderId ?? o.clientOrderId ?? o.id;
  const eOrders = new Set((engine.openOrders ?? []).map(orderKey));
  const bOrders = new Set((broker.openOrders ?? []).map(orderKey));
  for (const o of broker.openOrders ?? []) {
    const id = orderKey(o);
    if (!eOrders.has(id)) {
      details.missingOrdersInEngine.push(id);
      problems.push(violation(TIER.TRUTH, 'ORDER_UNKNOWN',
        `Broker reports open order ${id} unknown to the engine.`, { order: o }));
    }
  }
  for (const o of engine.openOrders ?? []) {
    const id = orderKey(o);
    if (!bOrders.has(id)) {
      details.missingOrdersInBroker.push(id);
      problems.push(violation(TIER.TRUTH, 'ORDER_PHANTOM',
        `Engine reports working order ${id} that the broker does not.`, { order: o }));
    }
  }

  const fatal = problems.some((p) => p.code !== 'CASH_MISMATCH');
  let status;
  if (!problems.length) status = RECON.PASS;
  else if (!fatal) status = RECON.DRIFT;
  else status = RECON.QUARANTINE;

  return { status, problems, details, passed: status === RECON.PASS };
}
