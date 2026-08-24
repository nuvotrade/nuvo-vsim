/**
 * Paper broker.
 *
 * Models partial fills and realistic slippage rather than filling
 * everything at the limit. A paper broker that always fills at mid teaches
 * the system a lie, and Authority 3 is gated on execution evidence that
 * would then be worthless.
 */
import { BrokerAdapter } from './adapter.js';
import { ORDER_STATE } from '../order.js';
import { Rng } from '../../math/random.js';
import { isNum } from '../../math/stats.js';

export class PaperBroker extends BrokerAdapter {
  constructor({ cash = 100_000, seed = 'paper', fillProbability = 0.85, now = () => Date.now() } = {}) {
    super('paper');
    this.cash = cash;
    this.startingCash = cash;
    this._positions = new Map();
    this._orders = new Map();
    this.rng = new Rng(seed);
    this.fillProbability = fillProbability;
    this.now = now;
    this.fills = [];
  }

  async accountState() {
    return {
      value: {
        cash: this.cash,
        buyingPower: this.cash,
        nav: this.cash + this._markPositions(),
      },
      asOf: this.now(),
      source: 'paper',
    };
  }

  _markPositions() {
    let m = 0;
    for (const p of this._positions.values()) m += (p.mark ?? 0) * p.quantity * (p.multiplier ?? 1);
    return m;
  }

  async positions() {
    return { value: [...this._positions.values()], asOf: this.now(), source: 'paper' };
  }

  async openOrders() {
    return {
      value: [...this._orders.values()].filter((o) =>
        [ORDER_STATE.SUBMITTED, ORDER_STATE.WORKING, ORDER_STATE.PARTIAL].includes(o.state)),
      asOf: this.now(),
      source: 'paper',
    };
  }

  /**
   * Submit. Fill probability falls as the limit gets further from the
   * market, so an order priced at an optimistic level often does NOT fill —
   * which is the honest simulation of trying to keep the whole edge.
   */
  async submit(order) {
    if (this._orders.has(order.clientOrderId)) {
      return { error: `duplicate clientOrderId ${order.clientOrderId}` };
    }
    const brokerOrderId = `PB-${this._orders.size + 1}`;
    const rec = { ...order, brokerOrderId, state: ORDER_STATE.SUBMITTED };
    this._orders.set(order.clientOrderId, rec);

    const roll = this.rng.next();
    if (roll > this.fillProbability) {
      rec.state = ORDER_STATE.WORKING;
      return { value: { brokerOrderId, state: rec.state, filled: false }, asOf: this.now(), source: 'paper' };
    }

    // Fill somewhere between the limit and slightly worse.
    const concession = this.rng.uniform(0, 0.06) * Math.abs(order.limitPrice);
    const creditPerUnit = order.limitPrice - concession;
    const qty = order.legs.reduce((s, l) => s + Math.abs(l.quantity), 0) / Math.max(1, order.legs.length);
    const credit = creditPerUnit * 100 * qty;

    rec.state = ORDER_STATE.FILLED;
    rec.fill = { credit, price: creditPerUnit, at: this.now(), quantity: qty };
    this.cash += credit;
    this.fills.push({ clientOrderId: order.clientOrderId, ...rec.fill });

    for (const leg of order.legs) {
      const key = `${leg.symbol}`;
      const prev = this._positions.get(key);
      const signed = (leg.action === 'SELL' ? -1 : 1) * leg.quantity;
      const quantity = (prev?.quantity ?? 0) + signed;
      if (quantity === 0) this._positions.delete(key);
      else {
        this._positions.set(key, {
          underlying: order.intent.underlying,
          symbol: leg.symbol,
          type: leg.right === 'shares' ? 'EQUITY' : 'OPTION',
          right: leg.right,
          strike: leg.strike,
          expiration: leg.expiration,
          quantity,
          multiplier: leg.right === 'shares' ? 1 : 100,
          mark: prev?.mark ?? 0,
        });
      }
    }
    return {
      value: { brokerOrderId, state: rec.state, filled: true, fill: rec.fill },
      asOf: this.now(), source: 'paper',
    };
  }

  async cancel(clientOrderId) {
    const o = this._orders.get(clientOrderId);
    if (!o) return { error: 'unknown order' };
    if (o.state === ORDER_STATE.FILLED) return { error: 'already filled' };
    o.state = ORDER_STATE.CANCELLED;
    return { value: { cancelled: true }, asOf: this.now(), source: 'paper' };
  }

  /** Mark positions for NAV. */
  mark(symbol, price) {
    const p = this._positions.get(symbol);
    if (p && isNum(price)) p.mark = price;
  }
}
