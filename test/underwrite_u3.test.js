import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  UNDERWRITE_FORECAST_EVENT,
  UNDERWRITE_PRIMARY,
  UNDERWRITE_SCORE_VERSION,
  calibrationStamp,
  expirationIsMature,
  officialExpirationClose,
  scoreSealedForecast,
  sealedForecastProjection,
} from '../cloudflare/underwrite-calibration.js';
import { UNDERWRITE_SURFACE_MODEL_LOCKS } from '../cloudflare/underwrite-model-version-lock.js';
import { underwriteCalibrationSummary } from '../cloudflare/worker.js';

function projectionFixture({ right = 'put', strike = 100, terminalDte = 36.5 } = {}) {
  const surface = right === 'put' ? 'CSP_SINGLE_TICKER' : 'COVERED_CALL_SINGLE_TICKER';
  const row = {
    strike,
    expiration: '2026-09-18',
    dte: terminalDte,
    one_contract_economics: { net_credit: 250 },
    market_math: {
      model_time_to_expiry_years: 0.1,
      risk_free_rate: 0.045,
      risk_neutral_finish_itm_european: 0.3,
    },
    models: {
      bootstrap: { p_finish_itm: 0.25, raw_nev_0: 40 },
      lognormal: { p_finish_itm: 0.2, raw_nev_0: 50 },
      studentT: { p_finish_itm: 0.4, raw_nev_0: 20 },
      jump: { p_finish_itm: 0.45, raw_nev_0: 5 },
    },
  };
  return sealedForecastProjection({
    surface,
    row,
    result: { rate_assumptions: { risk_free_rate: 0.045 } },
    asof: '2026-08-13T20:00:00.000Z',
  });
}

const verifiedClose = (terminalPrice) => ({
  status: 'VERIFIED', terminal_price: terminalPrice,
  source: 'SCHWAB_PRICE_HISTORY', source_timestamp: '2026-09-18T20:00:00.000Z',
});

test('U3 seals the event, clock, PRIMARY and every displayed model without changing rank', () => {
  const projection = projectionFixture();
  assert.equal(projection.event, UNDERWRITE_FORECAST_EVENT);
  assert.equal(projection.primary_model, UNDERWRITE_PRIMARY);
  assert.equal(projection.primary_is_provisional, true);
  assert.equal(projection.sealed_clock.risk_free_rate, 0.045);
  assert.equal(projection.sealed_clock.time_to_expiry_years, 0.1);
  assert.equal(projection.sealed_clock.time_source,
    'FORECAST_MODEL_DTE_365_SEALED_AT_FORECAST');
  assert.equal(projection.sealed_clock.time_origin, '2026-08-13T20:00:00.000Z');
  assert.equal(projection.sealed_clock.time_destination, '2026-09-18');
  assert.equal(projection.models.bootstrap.probability, 0.25);
  assert.equal(projection.models.lognormal.probability, 0.2);
  assert.equal(projection.models.studentT.probability, 0.4);
  assert.equal(projection.models.jump.diagnostic, undefined);
  assert.equal(projection.models.riskNeutral.label,
    'RISK_NEUTRAL_REFERENCE_NOT_PHYSICAL_PRIMARY');
  assert.equal(projection.mutation_eligible, false);
  assert.equal('rank' in projection, false);
});

test('a row without a PRIMARY probability is not eligible for calibration', () => {
  const projection = sealedForecastProjection({
    surface: 'CSP_SINGLE_TICKER',
    row: { strike: 100, expiration: '2026-09-18', dte: 10,
      one_contract_economics: { net_credit: 200 },
      market_math: { risk_free_rate: 0.045, model_time_to_expiry_years: 10 / 365 } },
    result: {}, asof: '2026-09-08T20:00:00.000Z',
  });
  assert.equal(projection.calibration_eligible, false);
});

test('U3 put outcome is strict S_T < K and equality is OTM', () => {
  const forecast = { projection: projectionFixture({ right: 'put' }) };
  assert.equal(scoreSealedForecast(forecast, verifiedClose(99.99)).outcome, true);
  const equal = scoreSealedForecast(forecast, verifiedClose(100));
  assert.equal(equal.outcome, false);
  assert.equal(equal.equality_classification, 'OTM_FALSE');
});

test('U3 call outcome is strict S_T > K and equality is OTM', () => {
  const forecast = { projection: projectionFixture({ right: 'call' }) };
  assert.equal(scoreSealedForecast(forecast, verifiedClose(100.01)).outcome, true);
  assert.equal(scoreSealedForecast(forecast, verifiedClose(100)).outcome, false);
});

test('realized RAW NEV uses the forecast-sealed r and T, never post-expiry T=0', () => {
  const forecast = { projection: projectionFixture({ right: 'put' }) };
  const result = scoreSealedForecast(forecast, verifiedClose(90));
  const discount = Math.exp(-0.045 * 0.1);
  assert.equal(result.status, 'SETTLED');
  assert.ok(Math.abs(result.discount_factor - discount) < 1e-12);
  assert.ok(Math.abs(result.realized_liability_0 - discount * 10 * 100) < 1e-9);
  assert.ok(Math.abs(result.realized_nev_0 - (250 - discount * 1_000)) < 1e-9);
  assert.equal(result.sealed_rate, 0.045);
  assert.equal(result.sealed_time_to_expiry_years, 0.1);
});

test('Brier is printed for PRIMARY, challengers and RN while jump remains diagnostic', () => {
  const result = scoreSealedForecast(
    { projection: projectionFixture({ right: 'put' }) }, verifiedClose(90));
  const byModel = Object.fromEntries(result.scores.map((row) => [row.model, row]));
  assert.equal(byModel.bootstrap.primary, true);
  assert.ok(Math.abs(byModel.bootstrap.brier_score - 0.5625) < 1e-12);
  assert.ok(Math.abs(byModel.lognormal.brier_score - 0.64) < 1e-12);
  assert.ok(Math.abs(byModel.studentT.brier_score - 0.36) < 1e-12);
  assert.equal(byModel.jump.diagnostic, true);
  assert.equal(byModel.riskNeutral.risk_neutral_reference, true);
  assert.equal(result.score_version, UNDERWRITE_SCORE_VERSION);
  assert.equal(result.mutation_eligible, false);
});

test('early assignment does not define or alter the terminal event', () => {
  const projection = projectionFixture({ right: 'put' });
  projection.early_assignment = true;
  const result = scoreSealedForecast({ projection }, verifiedClose(101));
  assert.equal(result.outcome, false);
  assert.equal(result.event, 'FINISH_ITM_AT_EXPIRY');
});

test('official S_T is exactly the expiration-session close, with source and timestamp', () => {
  const friday = Date.parse('2026-09-18T20:00:00.000Z');
  const monday = Date.parse('2026-09-21T13:30:00.000Z');
  const result = officialExpirationClose({
    expiration: '2026-09-18',
    bars: [{ t: friday, o: 101, h: 103, l: 99, c: 102, v: 10_000 },
      { t: monday, o: 70, h: 75, l: 65, c: 72, v: 20_000 }],
    source: 'SCHWAB_PRICE_HISTORY',
    now: Date.parse('2026-09-21T21:00:00.000Z'),
  });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.terminal_price, 102);
  assert.equal(result.source, 'SCHWAB_PRICE_HISTORY');
  assert.equal(result.source_timestamp, '2026-09-18T20:00:00.000Z');
});

test('missing, ambiguous, or unfinished expiration close never invents an outcome', () => {
  const now = Date.parse('2026-09-18T19:00:00.000Z');
  assert.equal(expirationIsMature('2026-09-18', now), false);
  assert.equal(officialExpirationClose({ expiration: '2026-09-18', bars: [], now }).status,
    'NOT_MATURE');
  const mature = Date.parse('2026-09-18T21:00:00.000Z');
  assert.equal(officialExpirationClose({ expiration: '2026-09-18', bars: [], now: mature }).reason_code,
    'OFFICIAL_EXPIRATION_CLOSE_MISSING');
  const bar = { t: Date.parse('2026-09-18T20:00:00.000Z'), c: 100 };
  assert.equal(officialExpirationClose({ expiration: '2026-09-18', bars: [bar, bar], now: mature }).reason_code,
    'OFFICIAL_CLOSE_AMBIGUOUS');
  assert.equal(scoreSealedForecast({ projection: projectionFixture() }, {
    status: 'OUTCOME_UNAVAILABLE', reason_code: 'OFFICIAL_EXPIRATION_CLOSE_MISSING',
  }).status, 'OUTCOME_UNAVAILABLE');
  assert.equal(scoreSealedForecast({ projection: projectionFixture() }, {
    status: 'VERIFIED', terminal_price: 100, source: '', source_timestamp: null,
  }).reason_code, 'OFFICIAL_CLOSE_PROVENANCE_INCOMPLETE');
  assert.equal(officialExpirationClose({
    expiration: '2026-09-18', bars: [bar], source: '', now: mature,
  }).reason_code, 'OFFICIAL_CLOSE_SOURCE_UNVERIFIED');
});

test('calibration stamps are measurements and DEGRADED is not a registered state', () => {
  assert.equal(calibrationStamp(0), 'UNCALIBRATED');
  assert.equal(calibrationStamp(49), 'UNCALIBRATED');
  assert.equal(calibrationStamp(50), 'PROVISIONAL');
  assert.equal(calibrationStamp(199), 'PROVISIONAL');
  assert.equal(calibrationStamp(200), 'CALIBRATED');
  assert.notEqual(calibrationStamp(10_000), 'DEGRADED');
});

test('U3 persistence is append-only, retry-idempotent, and score-version isolated', async () => {
  const migration = await readFile(new URL('../cloudflare/migrations/0017_underwrite_forecast_outcomes.sql', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE)\b/iu);
  assert.match(migration, /UNIQUE \(owner_id, forecast_id\)/u);
  assert.match(migration,
    /UNIQUE \(owner_id, surface, forecast_id, model_version, model_name\)/u);
  assert.match(worker, /ON CONFLICT\(owner_id,forecast_id\) DO NOTHING/u);
  assert.match(worker,
    /ON CONFLICT\(owner_id,surface,forecast_id,model_version,model_name\) DO NOTHING/u);
  assert.match(worker, /WHERE owner_id=\? AND surface=\? AND model_version=\?/u);
  assert.match(worker, /WHERE o\.owner_id=\? AND f\.surface=\? AND f\.model_version=\?/u);
  assert.match(worker, /mutation_eligible: false/u);
  assert.doesNotMatch(worker, /setInterval\([^)]*settleMaturedUnderwriteForecasts/u);
});

test('every calibration column is locked to its surface and exact model-file hashes', async () => {
  for (const [surface, lock] of Object.entries(UNDERWRITE_SURFACE_MODEL_LOCKS)) {
    const components = [];
    for (const [path, expected] of Object.entries(lock.components)) {
      const bytes = await readFile(new URL(`../${path}`, import.meta.url));
      const actual = createHash('sha256').update(bytes).digest('hex');
      assert.equal(actual, expected, `${surface} component drifted: ${path}`);
      components.push({ path, sha256: actual });
    }
    const aggregate = createHash('sha256')
      .update(JSON.stringify({ surface, components })).digest('hex');
    assert.equal(aggregate, lock.hash, `${surface} aggregate model hash drifted`);
  }
});

test('calibration summary queries and reports one surface plus one model hash only', async () => {
  const calls = [];
  const env = { DB: { prepare(sql) { return { bind(...values) {
    calls.push({ sql, values });
    return {
      async first() {
        if (sql.includes('FROM underwrite_forecasts\n')) return { n: 12 };
        return { settled_rows: 8, unique_contract_expiry: 6,
          unique_symbol_expiry: 3, mean_realized_nev_0: 14.25 };
      },
      async all() { return { results: [
        { model_name: 'bootstrap', n: 8, brier: 0.21, mean_realized_nev_0: 14.25 },
        { model_name: 'riskNeutral', n: 8, brier: 0.24, mean_realized_nev_0: 14.25 },
      ] }; },
    };
  } }; } } };
  const surface = 'CSP_SINGLE_TICKER';
  const lock = UNDERWRITE_SURFACE_MODEL_LOCKS[surface];
  const summary = await underwriteCalibrationSummary(env, 'owner', surface, lock.hash);
  assert.equal(summary.surface, surface);
  assert.equal(summary.model_version, lock.hash);
  assert.deepEqual(summary.n, {
    forecast_rows: 8,
    total_immutable_forecast_rows: 12,
    unique_contract_expiry: 6,
    unique_symbol_expiry: 3,
  });
  assert.equal(summary.brier.bootstrap.value, 0.21);
  assert.equal(summary.status, 'UNCALIBRATED');
  assert.equal(summary.primary_unchanged_by_calibration, true);
  assert.equal(summary.mutation_eligible, false);
  assert.equal(calls.length, 3);
  calls.forEach(({ values }) => assert.deepEqual(values, ['owner', surface, lock.hash]));
});

test('U3 glass prints the three n values and requested Brier columns without a DEGRADED label', async () => {
  const worker = await readFile(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
  for (const key of ['forecastRows', 'contractExpiry', 'symbolExpiry', 'modelVersion', 'primaryBrier',
    'lognormalBrier', 'studentTBrier', 'riskNeutralBrier']) {
    assert.match(worker, new RegExp(`'${key}'`, 'u'));
  }
  assert.match(worker, /NOT_USED_NO_REGISTERED_DEGRADATION_RULE/u);
  assert.doesNotMatch(worker, />DEGRADED</u);
  assert.match(worker, /Calibration labels report evidence only; they never change the model/u);
});

test('covered-call glass prints the complete per-share theta conversion and quote freshness', async () => {
  const worker = await readFile(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /broker_long_theta_per_share_per_calendar_day/u);
  assert.match(worker, /\/share\/day · ×/u);
  assert.match(worker, /broker_theta_equity_multiplier/u);
  assert.match(worker, /broker_theta_contracts/u);
  assert.match(worker, /broker_short_theta_per_day/u);
  assert.match(worker, /result\.classification\.current \? 'CURRENT ' : 'STALE '/u);
  assert.doesNotMatch(worker, /Schwab \$\/contract\/day × contracts; no ×100/u);
});
