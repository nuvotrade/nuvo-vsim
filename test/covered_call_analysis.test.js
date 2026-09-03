import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeCoveredCallLifecycle, coveredCallEntryEvidenceFromOpenLots,
} from '../src/lifecycle/covered_call_analysis.js';
import { d1d2, dteToT, greeks } from '../src/math/black_scholes.js';
import { normCdf } from '../src/math/stats.js';

const spcx = {
  optionPosition: {
    symbol: 'SPCX260904C00141000', underlying: 'SPCX', right: 'call',
    strike: 141, expiration: '2026-09-04', qty: -5, multiplier: 100,
  },
  sharePosition: { symbol: 'SPCX', qty: 500, average_price: 145.61832 },
  optionQuote: {
    bid: 1.40, ask: 1.42, mid: 1.41, iv: 0.50, delta: 0.25, theta: -0.18,
    asof: '2026-09-02T16:00:00.000Z', source: 'SCHWAB',
  },
  underlyingQuote: { last: 137.81, bid: 137.81, asof: '2026-09-02T16:00:00.000Z' },
  entryEvidence: {
    verified: true, source: 'SPCX_REGRESSION_FIXTURE', transactionIds: ['SPCX-ENTRY'],
    grossCredit: 1001.64, openingFees: 0, netCredit: 1001.64,
  },
  events: [],
  eventCoverage: { eventsVerified: true, dividendsVerified: true },
  now: Date.parse('2026-09-02T16:00:00.000Z'),
  closeCommissionPerContract: 0.65,
  closeExchangeFeePerContract: 0,
  stockExitFees: 0,
  assignmentFees: 0,
  expirationScenarioPrice: 137.81,
};

test('SPCX lifecycle regression reproduces all nine locked values with explicit zero-fee assumptions', () => {
  const result = analyzeCoveredCallLifecycle(spcx);
  assert.equal(result.ok, true);
  assert.equal(result.entry_evidence.opening_fees, 0);
  assert.equal(result.quote.share_exit_bid, 137.81);
  assert.equal(result.current_trade.buyback_principal, 710);
  assert.equal(result.current_trade.total_close_outlay, 713.25);
  assert.equal(result.current_trade.adjusted_share_basis, 143.61504);
  assert.equal(result.current_trade.profit_locked_if_call_closed_now, 288.39);
  assert.equal(result.paths.assignment.pnl, -1307.52);
  assert.equal(result.paths.exit_now.pnl, -3615.77);
  assert.equal(result.paths.expire_worthless.pnl, -2902.52);
  assert.equal(result.paths.close_call_keep_shares.crossover_share_price, 142.4265);
  assert.equal(result.paths.sell_shares_wait_on_call.crossover_share_price, 136.3835);
});

test('opening and stock-exit fees remain explicit and change their dependent economics', () => {
  const result = analyzeCoveredCallLifecycle({
    ...spcx,
    entryEvidence: {
      ...spcx.entryEvidence, grossCredit: 1001.64, openingFees: 5, netCredit: 996.64,
    },
    stockExitFees: 10,
  });
  assert.equal(result.current_trade.adjusted_share_basis, 143.62504);
  assert.equal(result.paths.exit_now.pnl, -3630.77);
  assert.equal(result.paths.sell_shares_wait_on_call.crossover_share_price, 136.3635);
});

test('risk-neutral sigma distance is exactly -d2 and reconciles with N(-d2)', () => {
  const result = analyzeCoveredCallLifecycle(spcx);
  const t = dteToT(result.dte);
  const { d2 } = d1d2({ spot: 137.81, strike: 141, vol: 0.50, t });
  assert.equal(result.risk_neutral.sigma_distance_to_strike, -d2);
  assert.ok(Math.abs(result.risk_neutral.probability_expire_otm - normCdf(-d2)) < 1e-12);
});

test('Schwab per-contract theta is scaled by contract count and never by 100 shares', () => {
  const result = analyzeCoveredCallLifecycle(spcx);
  assert.equal(result.current_trade.broker_long_theta_per_contract_per_day, -0.18);
  assert.equal(result.current_trade.broker_theta_contracts, 5);
  assert.equal(result.current_trade.broker_short_theta_per_day, 0.9);
  assert.equal(result.current_trade.broker_theta_scaling,
    'NEGATE_LONG_CONTRACT_THETA_X_CONTRACTS_NO_EQUITY_MULTIPLIER');
});

test('risk-neutral rate sources are explicit and carried into the result', () => {
  const result = analyzeCoveredCallLifecycle({
    ...spcx,
    rate: 0.045,
    dividendYield: 0,
    rateSource: 'constitution-v5.2.1:riskFreeRate',
    dividendYieldSource: 'INTENTIONAL_ZERO_NO_VERIFIED_CONTINUOUS_DIVIDEND_YIELD',
  });
  assert.equal(result.risk_neutral.rate, 0.045);
  assert.equal(result.risk_neutral.dividend_yield, 0);
  assert.equal(result.risk_neutral.rate_source, 'constitution-v5.2.1:riskFreeRate');
  assert.equal(result.risk_neutral.dividend_yield_source,
    'INTENTIONAL_ZERO_NO_VERIFIED_CONTINUOUS_DIVIDEND_YIELD');
});

test('Black-Scholes theta uses 2*sqrt(T), not 2*T', () => {
  const input = { type: 'call', spot: 100, strike: 105, vol: 0.4, t: 0.02, rate: 0.05, yield: 0.01 };
  const { d1, d2 } = d1d2(input);
  const pdf = Math.exp(-(d1 * d1) / 2) / Math.sqrt(2 * Math.PI);
  const expectedAnnual = -(100 * Math.exp(-0.01 * 0.02) * pdf * 0.4) / (2 * Math.sqrt(0.02))
    - 0.05 * 105 * Math.exp(-0.05 * 0.02) * normCdf(d2)
    + 0.01 * 100 * Math.exp(-0.01 * 0.02) * normCdf(d1);
  assert.ok(Math.abs(greeks(input).theta - expectedAnnual / 365) < 1e-12);
});

test('deterministic flags carry their observed values and never become recommendations', () => {
  const result = analyzeCoveredCallLifecycle({
    ...spcx,
    optionPosition: { ...spcx.optionPosition, strike: 140 },
    sharePosition: { ...spcx.sharePosition, average_price: 145 },
    optionQuote: { ...spcx.optionQuote, bid: 0.08, ask: 0.10, mid: 0.09 },
    underlyingQuote: { ...spcx.underlyingQuote, last: 141, bid: 140.95 },
    events: [
      { type: 'EARNINGS', at: Date.parse('2026-09-03T20:00:00.000Z') },
      { type: 'EX_DIVIDEND', at: Date.parse('2026-09-03T13:30:00.000Z'), cash_amount: 0.50 },
    ],
  });
  const flags = new Map(result.classification.flags.map((flag) => [flag.code, flag]));
  for (const code of [
    'EXPIRY_PROXIMITY', 'BELOW_BASIS', 'ASSIGNMENT_LIKELY',
    'EVENT_IN_TENOR', 'EARLY_ASSIGNMENT_RISK',
  ]) {
    assert.equal(flags.has(code), true, code);
    assert.ok(Object.hasOwn(flags.get(code), 'observed'), code);
    assert.ok(flags.get(code).threshold, code);
  }
  assert.deepEqual(result.classification.recommendations, {
    do_nothing: 'NOT_RECOMMENDED_BY_FLAGS',
    close: 'NO_TRUTH',
    roll: 'NO_TRUTH',
    exit: 'NO_TRUTH',
  });
});

test('NOMINAL is emitted only when no deterministic condition is flagged', () => {
  const result = analyzeCoveredCallLifecycle({
    ...spcx,
    optionPosition: { ...spcx.optionPosition, strike: 150, expiration: '2026-09-18' },
  });
  assert.deepEqual(result.classification.flags.map((flag) => flag.code), ['NOMINAL']);
});

test('uncovered calls and unverified entry economics are refused rather than guessed', () => {
  assert.equal(analyzeCoveredCallLifecycle({
    ...spcx, sharePosition: { ...spcx.sharePosition, qty: 100 },
  }).error, 'COVERED_CALL_ANALYSIS_INPUT_INCOMPLETE');
  assert.equal(analyzeCoveredCallLifecycle({
    ...spcx, entryEvidence: { verified: false, reason: 'MISSING_FEE' },
  }).error, 'MISSING_FEE');
});

test('broker open lots reconstruct gross credit, opening fees and net credit exactly', () => {
  const evidence = coveredCallEntryEvidenceFromOpenLots([
    {
      symbol: ' SPCX 260904C00141000 ', quantity: -3, cash_per_unit: 199.02,
      fee_per_unit: 1.30, transaction_id: 'A',
    },
    {
      symbol: 'SPCX260904C00141000', quantity: -2, cash_per_unit: 199.04,
      fee_per_unit: 1.30, transaction_id: 'B',
    },
  ], spcx.optionPosition);
  assert.deepEqual(evidence, {
    verified: true,
    source: 'SCHWAB_LEDGER_OPEN_LOTS',
    contracts: 5,
    grossCredit: 1001.64,
    openingFees: 6.5,
    netCredit: 995.14,
    transactionIds: ['A', 'B'],
  });
});

test('live CBRS opening lot preserves the broker gross credit and all four dollars of fees', () => {
  const evidence = coveredCallEntryEvidenceFromOpenLots([{
    symbol: 'CBRS260904C00200000',
    quantity: -6,
    cash_per_unit: 69.333333,
    fee_per_unit: 0.666667,
    transaction_id: '129732444954',
  }], {
    symbol: 'CBRS260904C00200000',
    quantity: -6,
  });
  assert.deepEqual(evidence, {
    verified: true,
    source: 'SCHWAB_LEDGER_OPEN_LOTS',
    contracts: 6,
    grossCredit: 420,
    openingFees: 4,
    netCredit: 416,
    transactionIds: ['129732444954'],
  });
});
