import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateCashSecuredPutRows, configuredCashSecuredPutDteTargets,
} from '../cloudflare/cash-secured-put-calculator.js';
import { price } from '../src/math/black_scholes.js';

const NOW = Date.parse('2026-09-02T17:00:00Z');

function history(count = 180) {
  return Array.from({ length: count }, (_, index) => {
    const close = 18 + 0.012 * index + 0.35 * Math.sin(index / 5);
    return {
      t: NOW - (count - index) * 86_400_000,
      o: close - 0.05, h: close + 0.18, l: close - 0.21, c: close,
    };
  });
}

function put({ strike = 17, dte = 14, bid = 0.52, ask = 0.58, iv = 0.34 } = {}) {
  return {
    symbol: `SOFI-P-${strike}-${dte}`, right: 'put', strike, dte,
    expiration: new Date(NOW + dte * 86_400_000).toISOString().slice(0, 10),
    bid, ask, iv, delta: -0.25, openInterest: 10, volume: 2, quoteAsOf: NOW,
  };
}

test('single-ticker CSP calculator exposes every put row and exact one-contract cash math', () => {
  const result = calculateCashSecuredPutRows({
    symbol: 'SOFI', spot: 18, contracts: [
      put({ strike: 18, dte: 14, bid: 0.8, ask: 0.9 }),
      put({ strike: 17, dte: 7, bid: 0.3, ask: 0.36 }),
      { ...put(), right: 'call' },
    ],
    historyBars: history(), now: NOW, alternativeCashRate: 0.035,
    collateralCashRate: 0, alternativeCashRateVerified: true,
    collateralCashRateVerified: true,
    targetBasis: 16.5, seed: 'unit-csp',
  });
  assert.equal(result.ok, true);
  assert.equal(result.symbol, 'SOFI');
  assert.equal(result.contracts, 1);
  assert.equal(result.row_count, 2);
  assert.deepEqual(result.rows.map((row) => [row.dte, row.strike]), [[7, 17], [14, 18]]);
  const row = result.rows[0];
  assert.equal(row.one_contract_economics.gross_credit_at_executable_bid, 30);
  assert.equal(row.one_contract_economics.verified_fees, 0.65);
  assert.equal(row.one_contract_economics.net_credit, 29.35);
  assert.equal(row.one_contract_economics.gross_obligation, 1700);
  assert.equal(row.one_contract_economics.net_tied_cash, 1670.65);
  assert.equal(row.one_contract_economics.net_tied_cash_source,
    'STRIKE_TIMES_100_MINUS_NET_CREDIT');
  assert.equal(row.one_contract_economics.assigned_basis, 16.7065);
  assert.equal(row.one_contract_economics.max_loss_to_zero, 1670.65);
  assert.equal(row.one_contract_economics.target_basis_met, false);
  assert.ok(row.one_contract_economics.cash_carry_cost_0 > 0);
  assert.ok(row.headline_models.primary_cash_adj_nev_0
    < row.headline_models.primary_nev);
  assert.ok(row.warnings.includes('OPEN_INTEREST_BELOW_250'));
  assert.ok(row.warnings.includes('VOLUME_BELOW_50'));
  assert.ok(Number.isFinite(row.models.lognormal.nev));
  assert.ok(Number.isFinite(row.models.lognormal.monte_carlo_standard_error));
  assert.ok(Number.isFinite(result.rows[1].models.studentT.conditional_assignment_severity_per_share));
  assert.ok(Number.isFinite(row.models.jump.conditional_value_at_risk_95));
  assert.ok(Number.isFinite(row.models.bootstrap.model_value));
  assert.ok(Number.isFinite(row.models.volatilityStress.pnl_standard_deviation));
  assert.equal(row.headline_models.primary, 'bootstrap');
  assert.equal(row.headline_models.primary_nev, row.models.bootstrap.nev);
  assert.equal(row.headline_models.stress, 'volatilityStress');
  assert.equal(row.headline_models.stress_veto,
    'NOT_REGISTERED_MATH_ONLY_CALCULATOR_HAS_NO_DECISION');
  assert.equal(result.model_assumptions.primary.drift,
    'ZERO_ARITHMETIC_DRIFT_EXACT_SAMPLE_NORMALIZATION');
  assert.match(result.model_assumptions.jump.caution, /DOUBLE_COUNT_JUMP_VARIANCE/u);
  assert.equal(result.calibration.status, 'UNCALIBRATED');
  assert.equal(result.calibration.n, 0);
  assert.equal(result.sample_count_per_member, 8000);
  for (const model of ['lognormal', 'studentT', 'jump', 'bootstrap', 'volatilityStress']) {
    assert.equal(row.models[model].sample_count, 8000);
  }
  assert.equal(result.mutation_eligible, false);
  assert.equal('risk_neutral_touch_gbm_approximation' in row.market_math, false);
  assert.ok(row.warnings.includes('JUMP_DIAGNOSTIC_UNCALIBRATED_POSSIBLE_DOUBLE_COUNT'));
  assert.equal(result.time_basis,
    'TODAY_DOLLARS_PREMIUM_TODAY_MINUS_DISCOUNTED_TERMINAL_ASSIGNMENT_LIABILITY');
  assert.equal(result.rate_contract.cash_yields_in_risk_neutral_probability, 'NEVER');
  assert.equal(result.model_assumptions.primary.status, 'PROVISIONAL_UNCALIBRATED');
  assert.equal('mixture' in result.model_definitions, false);
  assert.equal(result.governance, 'NOT_CONSULTED');
  assert.equal(result.account_state, 'NOT_READ');
  assert.equal(result.selection, 'NONE_ALL_ROWS_VISIBLE_DEFAULT_SORT_EXPIRY_THEN_STRIKE');
});

test('cash carry uses a separate present-value clock and requires a verified rate pair', () => {
  const common = {
    symbol: 'SOFI', spot: 18, contracts: [put({ strike: 17, dte: 14 })],
    historyBars: history(), now: NOW, samples: 400, seed: 'cash-clock',
    rate: 0.045,
  };
  const altOnly = calculateCashSecuredPutRows({
    ...common, alternativeCashRate: 0.035, collateralCashRate: 0,
    alternativeCashRateVerified: true, collateralCashRateVerified: true,
  });
  const row = altOnly.rows[0];
  const t = 14 / 365;
  const expected = Math.exp(-0.045 * t) * row.one_contract_economics.net_tied_cash
    * (Math.exp(0.035 * t) - 1);
  assert.ok(Math.abs(row.one_contract_economics.cash_carry_cost_0 - expected) < 1e-10);
  assert.ok(Math.abs(row.headline_models.primary_cash_adj_nev_0
    - (row.headline_models.primary_nev - expected)) < 1e-10);

  const equalRates = calculateCashSecuredPutRows({
    ...common, alternativeCashRate: 0.035, collateralCashRate: 0.035,
    alternativeCashRateVerified: true, collateralCashRateVerified: true,
  }).rows[0];
  assert.equal(equalRates.one_contract_economics.cash_carry_cost_0, 0);
  assert.equal(equalRates.headline_models.primary_cash_adj_nev_0,
    equalRates.headline_models.primary_nev);

  const unverified = calculateCashSecuredPutRows({
    ...common, alternativeCashRate: 0.035, collateralCashRate: 0,
    alternativeCashRateVerified: true, collateralCashRateVerified: false,
  }).rows[0];
  assert.equal(unverified.one_contract_economics.cash_carry_cost_0, null);
  assert.equal(unverified.headline_models.primary_cash_adj_nev_0, null);
  assert.equal(unverified.one_contract_economics.cash_adj_status,
    'UNAVAILABLE_RATE_PAIR_UNVERIFIED');

  const differentCashRates = calculateCashSecuredPutRows({
    ...common, alternativeCashRate: 0.20, collateralCashRate: 0.01,
    alternativeCashRateVerified: true, collateralCashRateVerified: true,
  }).rows[0];
  assert.equal(differentCashRates.market_math.risk_neutral_finish_itm_european,
    row.market_math.risk_neutral_finish_itm_european,
    'cash yields y_alt/y_coll must never enter N(d2)');
  assert.equal(differentCashRates.models.bootstrap.raw_nev_0,
    row.models.bootstrap.raw_nev_0,
    'cash yields must not alter RAW_NEV_0');

  const brokerRequirement = calculateCashSecuredPutRows({
    ...common, alternativeCashRate: 0.035, collateralCashRate: 0,
    alternativeCashRateVerified: true, collateralCashRateVerified: true,
    brokerCashRequirement: 1_250, brokerCashRequirementVerified: true,
  }).rows[0];
  assert.equal(brokerRequirement.one_contract_economics.net_tied_cash, 1_250);
  assert.equal(brokerRequirement.one_contract_economics.net_tied_cash_source,
    'VERIFIED_BROKER_REQUIREMENT');
});

test('missing analytics mark only their cells unavailable and do not suppress the quote row', () => {
  const result = calculateCashSecuredPutRows({
    symbol: 'SOFI', spot: 18,
    contracts: [put({ iv: null, ask: null })],
    historyBars: history(20), now: NOW, samples: 200,
  });
  assert.equal(result.ok, true);
  assert.equal(result.row_count, 1);
  assert.equal(result.rows[0].market_math.risk_neutral_finish_itm_european, null);
  assert.equal(result.rows[0].models.lognormal, null);
  assert.ok(result.rows[0].warnings.includes('STRIKE_IV_UNAVAILABLE'));
  assert.ok(result.rows[0].warnings.includes('ASK_UNAVAILABLE_OR_BELOW_BID'));
  assert.ok(result.rows[0].warnings.includes('PRIMARY_BLOCK_BOOTSTRAP_UNAVAILABLE'));
  assert.ok(result.rows[0].warnings.includes('PARAMETRIC_MODEL_VOLATILITY_UNAVAILABLE'));
  assert.ok(result.rows[0].warnings.includes('JUMP_DIAGNOSTIC_UNCALIBRATED_POSSIBLE_DOUBLE_COUNT'));
});

test('target DTE configuration is explicit and validated', () => {
  assert.deepEqual(configuredCashSecuredPutDteTargets(undefined), [7, 14, 21]);
  assert.deepEqual(configuredCashSecuredPutDteTargets('21,7,14,14'), [7, 14, 21]);
  assert.equal(configuredCashSecuredPutDteTargets('7,bad'), null);
});

test('European pricing engine satisfies put-call parity on a controlled unit fixture', () => {
  const spot = 101;
  const strike = 100;
  const t = 30 / 365;
  const rate = 0.045;
  const dividendYield = 0.012;
  const vol = 0.28;
  const call = price({ type: 'call', spot, strike, t, rate, yield: dividendYield, vol });
  const putPrice = price({ type: 'put', spot, strike, t, rate, yield: dividendYield, vol });
  const parity = spot * Math.exp(-dividendYield * t) - strike * Math.exp(-rate * t);
  assert.ok(Math.abs((call - putPrice) - parity) < 1e-10);
});
