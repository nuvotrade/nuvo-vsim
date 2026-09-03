import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  coveredCallDisplayState, liveDashboardScript, recordUnderwriteForecastRows,
} from '../cloudflare/worker.js';

test('portfolio-review UI polls the exact asynchronous cycle until a terminal state', () => {
  const source = liveDashboardScript();
  assert.match(source, /\/api\/cycle\/.*encodeURIComponent\(cycleId\)/u);
  assert.match(source, /waiting for this exact portfolio review/u);
  assert.match(source, /new Set\(\['SHADOW_RECORDED', 'REFUSED', 'QUARANTINED'/u);
  assert.match(source, /review\?\.per_symbol/u);
  assert.match(source, /Named reason/u);
  assert.match(source, /Run fresh portfolio review/u);
  assert.match(source, /A weak symbol cannot erase its peers/u);
  const display = coveredCallDisplayState({
    ok: false, reason_code: 'TRUTH/SESSION_NOT_RTH', outcome: 'NOT_EVALUATED', symbol: 'SOFI',
  });
  assert.equal(display.state, 'NOT_EVALUATED');
  assert.equal(display.outcome, 'NOT_EVALUATED');
  assert.doesNotMatch(JSON.stringify(display), /NO_ELIGIBLE/u);
});

test('forecast writer is append-only and records every computed CSP row', async () => {
  const writes = [];
  const env = { DB: { prepare(sql) { return { bind(...values) { return {
    async run() { writes.push({ sql, values }); return { success: true }; },
  }; } }; } } };
  const result = await recordUnderwriteForecastRows(env, 'OWNER', {
    surface: 'CSP_SINGLE_TICKER', symbol: 'SOFI', asof: '2026-09-02T17:00:00.000Z',
    result: { ok: true, calibration: { status: 'UNCALIBRATED', n: 0 }, rows: [
      { symbol: 'SOFI-P-17', strike: 17, expiration: '2026-09-11', dte: 7 },
      { symbol: 'SOFI-P-16', strike: 16, expiration: '2026-09-18', dte: 14 },
    ] },
  });
  assert.equal(result.status, 'APPEND_ONLY_WRITTEN');
  assert.equal(result.rows, 2);
  assert.equal(writes.length, 2);
  assert.ok(writes.every((write) => /ON CONFLICT\(owner_id,forecast_id\) DO NOTHING/u.test(write.sql)));
  assert.ok(writes.every((write) => write.values[3] === 'CSP_SINGLE_TICKER'));
  assert.ok(writes.every((write) => write.values[4] === 'SOFI'));
});

test('forecast migration contains no update or delete path', () => {
  const sql = readFileSync(new URL('../cloudflare/migrations/0016_underwrite_forecasts.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS underwrite_forecasts/u);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE)\b/iu);
});

test('the compatibility preflight admits partial coverage for per-symbol adjudication', () => {
  const source = readFileSync(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
  assert.match(source, /ok: !marketState\.error && verifiedCount > 0/u);
  assert.match(source, /coverage: verifiedCount === rows\.length \? 'COMPLETE'/u);
  assert.match(source, /mutationEligible: false/u);
  assert.match(source, /mutation_eligible: false/u);
  assert.match(source, /READ_ONLY_CALCULATION_NO_ORDER_ROUTE/u);
  assert.match(source, /READ_ONLY_MATH_NO_ORDER_ROUTE/u);
});
