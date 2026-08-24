/**
 * Order construction with idempotency (§ architecture 7).
 *
 * The failure this guards against is duplicate submission after a timeout:
 * NUVO sends an order, the response is lost, and a retry doubles the
 * position. The client order ID is derived from the order's own content,
 * so a retry of the same intent is recognisably the same order.
 */
import { isNum } from '../math/stats.js';
import { TIER, violation } from '../constitution/hierarchy.js';

export const ORDER_STATE = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  WORKING: 'WORKING',
  FILLED: 'FILLED',
  PARTIAL: 'PARTIAL',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
});

/** FNV-1a — small, dependency-free, and stable across runs and platforms. */
export function contentHash(obj) {
  const str = stableStringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Second pass over the reversed string widens the hash to 64 bits.
  let g = 0xcbf29ce4;
  for (let i = str.length - 1; i >= 0; i -= 1) {
    g ^= str.charCodeAt(i);
    g = Math.imul(g, 0x01000193) >>> 0;
  }
  return (h.toString(16).padStart(8, '0') + g.toString(16).padStart(8, '0'));
}

/** Key order matters for hashing, so keys are sorted deterministically. */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).filter((k) => typeof v[k] !== 'function' && v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/**
 * Limit price policy.
 *
 * Starts at mid and walks toward the market in steps. It never crosses
 * past `maxAggression`, because an order that chases is an order that
 * gives back the edge the underwriting just measured.
 */
export function limitPrice({ structure, side, aggression = 0.35 }) {
  let net = 0;
  for (const leg of structure.legs) {
    const c = leg.contract;
    if (!c || !isNum(c.bid) || !isNum(c.ask)) return { price: NaN, error: 'missing quote' };
    const mid = (c.bid + c.ask) / 2;
    const half = (c.ask - c.bid) / 2;
    // Selling: accept less than mid. Buying: pay more than mid.
    const legPrice = leg.action === 'SELL' ? mid - half * aggression : mid + half * aggression;
    net += leg.action === 'SELL' ? legPrice : -legPrice;
  }
  return { price: +net.toFixed(2), side, aggression };
}

/** Step schedule for working an order without chasing. */
export function priceLadder({ structure, side, steps = 4, maxAggression = 0.75 }) {
  const out = [];
  for (let i = 0; i < steps; i += 1) {
    const a = (maxAggression * (i + 1)) / steps;
    out.push({ step: i + 1, ...limitPrice({ structure, side, aggression: a }) });
  }
  return out;
}

/**
 * Build an order from an approved candidate.
 *
 * Refuses to build if authority, sizing or pricing is not fully determined.
 * A half-specified order is not submitted with defaults filled in.
 */
export function buildOrder({
  candidate, sizing, position, authorityLevel, limits, now, strategyId, modelVersion, codeVersion,
}) {
  const problems = [];
  if (!sizing || sizing.contracts < 1) {
    problems.push(violation(TIER.CAPITAL_EFFICIENCY, 'NO_SIZE', 'Order has no size.'));
  }
  const price = limitPrice({ structure: candidate.structure, side: 'OPEN' });
  if (!isNum(price.price)) {
    problems.push(violation(TIER.TRUTH, 'NO_LIMIT_PRICE', 'Cannot determine a limit price from the chain.'));
  }
  if (problems.length) return { ok: false, violations: problems };

  const legs = candidate.structure.legs.map((l) => ({
    action: l.action,
    right: l.right,
    symbol: l.contract?.symbol ?? candidate.underlying,
    strike: l.strike ?? null,
    expiration: l.expiration ?? null,
    quantity: (l.quantity ?? 1) * sizing.contracts / Math.max(1, candidate.structure.contracts),
  }));

  const intent = {
    underlying: candidate.underlying,
    strategy: candidate.structure.kind,
    legs,
    limitPrice: price.price,
    // The trading day, not the timestamp: a retry seconds later must hash
    // identically, while the same order tomorrow must not.
    tradingDay: new Date(now).toISOString().slice(0, 10),
    strategyId,
  };

  return {
    ok: true,
    order: {
      clientOrderId: `NUVO-${contentHash(intent)}`,
      state: ORDER_STATE.DRAFT,
      createdAt: now,
      intent,
      legs,
      limitPrice: price.price,
      orderType: 'NET_LIMIT',
      timeInForce: 'DAY',
      ladder: priceLadder({ structure: candidate.structure, side: 'OPEN' }),
      positionContractId: position?.id ?? null,
      authorityLevel,
      modelVersion,
      codeVersion,
      // What NUVO believed at submission — compared against the fill later
      // to measure whether the modelled edge survived execution (§21).
      expectation: {
        credit: candidate.structure.credit * sizing.contracts / Math.max(1, candidate.structure.contracts),
        nev: candidate.evaluation.nev,
        raroc: candidate.capital.raroc,
        modelledSlippage: candidate.evaluation.costs.slippage,
      },
    },
  };
}

/**
 * Order book with idempotency enforcement.
 * A duplicate clientOrderId is rejected rather than sent twice.
 */
export class OrderBook {
  constructor() {
    this.orders = new Map();
    this.history = [];
  }

  submit(order) {
    const existing = this.orders.get(order.clientOrderId);
    if (existing) {
      return {
        ok: false, duplicate: true, existing,
        reason: `Order ${order.clientOrderId} already exists in state ${existing.state}.`,
      };
    }
    const rec = { ...order, state: ORDER_STATE.SUBMITTED };
    this.orders.set(order.clientOrderId, rec);
    this.history.push({ event: 'SUBMIT', clientOrderId: order.clientOrderId, at: order.createdAt });
    return { ok: true, order: rec };
  }

  update(clientOrderId, patch) {
    const o = this.orders.get(clientOrderId);
    if (!o) return { ok: false, reason: 'unknown order' };
    Object.assign(o, patch);
    this.history.push({ event: 'UPDATE', clientOrderId, patch });
    return { ok: true, order: o };
  }

  get open() {
    return [...this.orders.values()].filter((o) =>
      [ORDER_STATE.SUBMITTED, ORDER_STATE.WORKING, ORDER_STATE.PARTIAL].includes(o.state));
  }
}

/**
 * Fill quality: how much of the modelled edge actually survived.
 * This is the number that promotes or demotes authority (§17).
 */
export function fillQuality({ order, fill }) {
  const expected = order.expectation.credit;
  const received = fill.credit;
  const slip = expected - received;
  return {
    expectedCredit: expected,
    receivedCredit: received,
    slippage: slip,
    slippagePct: expected !== 0 ? slip / Math.abs(expected) : NaN,
    /** Fraction of modelled NEV retained after the real fill. */
    edgeRetained: order.expectation.nev > 0
      ? Math.max(0, (order.expectation.nev - slip) / order.expectation.nev)
      : NaN,
    latencyMs: isNum(fill.at) && isNum(order.createdAt) ? fill.at - order.createdAt : NaN,
  };
}
