/**
 * Structure abstraction (§10).
 *
 * NUVO identifies an economically attractive risk premium FIRST, then asks
 * what shape to take it in. Every structure therefore exposes the same
 * interface, and the Underwriter scores them all through one code path:
 * a CSP and a bull put spread on the same thesis are compared on identical
 * terms, and neither gets a sentimental advantage.
 */
import { isNum } from '../math/stats.js';

export const STRUCTURE = Object.freeze({
  CSP: 'CSP',
  BULL_PUT_SPREAD: 'BULL_PUT_SPREAD',
  SHARES: 'SHARES',
  COVERED_CALL: 'COVERED_CALL',
  CASH: 'CASH',
  NO_TRADE: 'NO_TRADE',
});

/**
 * @typedef {object} Structure
 * @property {string} kind
 * @property {string} underlying
 * @property {Array} legs
 * @property {number} credit        net credit received (positive) per unit
 * @property {number} debit         net debit paid (positive) per unit
 * @property {number} buyingPower   capital the broker locks
 * @property {number} maxLoss       worst case per unit, positive magnitude
 * @property {number} multiplier
 * @property {(terminalPrice:number)=>number} payoff  P&L at expiry, in dollars
 */

/** Mid price of a contract, or NaN when there is no honest mid. */
export const mid = (c) => (isNum(c?.bid) && isNum(c?.ask) && c.bid > 0 ? (c.bid + c.ask) / 2 : NaN);

/**
 * The price NUVO assumes it can actually transact at.
 *
 * `aggression` 0 = mid, 1 = fully crossing the spread. The default of 0.35
 * is deliberately pessimistic relative to mid, because an edge that only
 * exists at mid does not exist (§21, execution scoreboard).
 */
export function realisticFill(contract, side, aggression = 0.35) {
  const m = mid(contract);
  if (!isNum(m)) return NaN;
  const half = (contract.ask - contract.bid) / 2;
  return side === 'sell' ? m - half * aggression : m + half * aggression;
}

/** Cash-secured put. Undefined risk below the strike, full capital lockup. */
export function cashSecuredPut({ underlying, put, contracts = 1, aggression = 0.35 }) {
  const credit = realisticFill(put, 'sell', aggression);
  const mult = put.multiplier ?? 100;
  if (!isNum(credit)) return null;
  const bp = put.strike * mult * contracts - credit * mult * contracts;
  return {
    kind: STRUCTURE.CSP,
    underlying,
    contracts,
    legs: [{ action: 'SELL', right: 'put', strike: put.strike, expiration: put.expiration, contract: put, quantity: contracts }],
    credit: credit * mult * contracts,
    debit: 0,
    buyingPower: bp,
    // "Max loss" for a CSP is the strike going to zero. Quoting anything
    // smaller is the lie that makes CSPs look safer than spreads.
    maxLoss: (put.strike - credit) * mult * contracts,
    definedRisk: false,
    multiplier: mult,
    shortStrike: put.strike,
    dte: put.dte,
    expiration: put.expiration,
    payoff: (S) => (Math.min(0, S - put.strike) + credit) * mult * contracts,
    breakeven: put.strike - credit,
  };
}

/** Bull put spread — defined risk, far less capital. */
export function bullPutSpread({ underlying, shortPut, longPut, contracts = 1, aggression = 0.35 }) {
  const sc = realisticFill(shortPut, 'sell', aggression);
  const lc = realisticFill(longPut, 'buy', aggression);
  if (!isNum(sc) || !isNum(lc)) return null;
  const mult = shortPut.multiplier ?? 100;
  const net = sc - lc;
  const width = shortPut.strike - longPut.strike;
  if (width <= 0 || net <= 0) return null;
  return {
    kind: STRUCTURE.BULL_PUT_SPREAD,
    underlying,
    contracts,
    legs: [
      { action: 'SELL', right: 'put', strike: shortPut.strike, expiration: shortPut.expiration, contract: shortPut, quantity: contracts },
      { action: 'BUY', right: 'put', strike: longPut.strike, expiration: longPut.expiration, contract: longPut, quantity: contracts },
    ],
    credit: net * mult * contracts,
    debit: 0,
    buyingPower: (width - net) * mult * contracts,
    maxLoss: (width - net) * mult * contracts,
    definedRisk: true,
    multiplier: mult,
    shortStrike: shortPut.strike,
    longStrike: longPut.strike,
    width,
    dte: shortPut.dte,
    expiration: shortPut.expiration,
    payoff: (S) => {
      const shortLeg = Math.min(0, S - shortPut.strike);
      const longLeg = Math.max(0, longPut.strike - S);
      return (shortLeg + longLeg + net) * mult * contracts;
    },
    breakeven: shortPut.strike - net,
  };
}

/** Long shares. Included so "just buy it" competes on the same scoreboard. */
export function longShares({ underlying, spot, shares = 100 }) {
  return {
    kind: STRUCTURE.SHARES,
    underlying,
    contracts: shares / 100,
    legs: [{ action: 'BUY', right: 'shares', quantity: shares, price: spot }],
    credit: 0,
    debit: spot * shares,
    buyingPower: spot * shares,
    maxLoss: spot * shares,
    definedRisk: false,
    multiplier: 1,
    shortStrike: null,
    dte: null,
    payoff: (S) => (S - spot) * shares,
    breakeven: spot,
  };
}

/** Covered call against an existing share lot. */
export function coveredCall({ underlying, call, shares = 100, costBasis, aggression = 0.35 }) {
  const credit = realisticFill(call, 'sell', aggression);
  if (!isNum(credit)) return null;
  const contracts = Math.floor(shares / 100);
  if (contracts < 1) return null;
  const mult = call.multiplier ?? 100;
  return {
    kind: STRUCTURE.COVERED_CALL,
    underlying,
    contracts,
    legs: [{ action: 'SELL', right: 'call', strike: call.strike, expiration: call.expiration, contract: call, quantity: contracts }],
    credit: credit * mult * contracts,
    debit: 0,
    // Shares are already held; the call consumes no incremental buying power.
    buyingPower: 0,
    maxLoss: (costBasis - credit) * shares,
    definedRisk: false,
    multiplier: mult,
    shortStrike: call.strike,
    dte: call.dte,
    expiration: call.expiration,
    // P&L measured against cost basis, including the capped upside.
    payoff: (S) => (Math.min(S, call.strike) - costBasis + credit) * shares,
    breakeven: costBasis - credit,
    cappedUpside: (call.strike - costBasis + credit) * shares,
  };
}

/**
 * NO TRADE as a first-class structure (§6).
 *
 * It is scored, ranked and recorded like any other candidate. Its EV is
 * zero and its capital consumption is zero, which means any candidate with
 * negative NEV genuinely loses to it — the comparison is real, not rhetorical.
 */
export function noTrade({ underlying = null, reason = 'No qualifying opportunity.' } = {}) {
  return {
    kind: STRUCTURE.NO_TRADE,
    underlying,
    contracts: 0,
    legs: [],
    credit: 0,
    debit: 0,
    buyingPower: 0,
    maxLoss: 0,
    definedRisk: true,
    multiplier: 1,
    shortStrike: null,
    dte: null,
    payoff: () => 0,
    breakeven: null,
    reason,
  };
}
