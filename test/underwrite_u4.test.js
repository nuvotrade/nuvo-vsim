import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { liveDashboardScript } from '../cloudflare/worker.js';

const workerSource = readFileSync(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
const calculatorSource = readFileSync(
  new URL('../cloudflare/covered-call-lifecycle-choices.js', import.meta.url), 'utf8',
);

test('U4 glass is an explicit read-only comparison and never presents a recommendation', () => {
  const source = liveDashboardScript();
  assert.match(source, /COMPARE IN UNDERWRITE/u);
  assert.match(source, /COMMON-CLOCK CHOICE TABLE · READ ONLY/u);
  assert.match(source, /snapshot skew/u);
  assert.match(source, /Path NEV₀ ± SE/u);
  assert.match(source, /vs HOLD ± SE/u);
  assert.match(source, /MODELED · PROVISIONAL · U4 calibration n=0/u);
  assert.match(source, /roll targets/u);
  assert.match(source, /Unavailable listed rows/u);
  assert.match(source, /This table does not recommend or transmit a trade/u);
  assert.match(source, /U4 compares option-overlay math only; it never chooses an action/u);
  assert.doesNotMatch(source, /data-lifecycle-choice-option[^]*APPROVE/u);
});

test('U4 route is GET-only, non-mutating, and verifies the option session without unrelated VIX or SPY reads', () => {
  const route = workerSource.slice(workerSource.indexOf("'/api/covered-call/lifecycle-choices'"),
    workerSource.indexOf("'/api/performance/calendar'"));
  assert.match(route, /request\.method === 'GET'/u);
  const handler = workerSource.slice(
    workerSource.indexOf('export async function coveredCallLifecycleChoicesDashboard'),
    workerSource.indexOf('async function cashSecuredPutDashboard'),
  );
  assert.match(handler, /markets: \['option'\]/u);
  assert.doesNotMatch(handler, /marketState\(/u);
  assert.doesNotMatch(handler, /\$VIX|history\('SPY'/u);
  assert.doesNotMatch(handler, /\b(?:INSERT|UPDATE|DELETE)\b/iu);
  assert.doesNotMatch(handler, /sendOrder|placeOrder|createOrder|orderPlace/iu);
  assert.match(handler, /mutation_eligible: false/u);
  assert.match(handler, /READ_ONLY_CALCULATION_NO_ORDER_ROUTE/u);
});

test('U4 equations preserve U1 model locks and use only executable ask-to-close and bid-to-open', () => {
  assert.match(calculatorSource, /UNDERWRITE_PRIMARY_MODEL/u);
  assert.match(calculatorSource, /buildUnderwriteModelSet/u);
  assert.match(calculatorSource, /samples = 8_000/u);
  assert.match(calculatorSource, /currentAsk \* coveredShares/u);
  assert.match(calculatorSource, /bid \* multiplier/u);
  assert.match(calculatorSource, /max_of_models: 'REMOVED'/u);
  assert.match(calculatorSource, /mixture: 'NONE'/u);
  assert.match(calculatorSource, /recommendation: 'NONE'/u);
  assert.match(calculatorSource, /order_route: 'NONE'/u);
  assert.doesNotMatch(calculatorSource, /governor|policy_block|approve|transmit/iu);
});

test('U4 does not expose a POST handler or any order-action button', () => {
  const route = workerSource.slice(workerSource.indexOf("'/api/covered-call/lifecycle-choices'"),
    workerSource.indexOf("'/api/performance/calendar'"));
  assert.doesNotMatch(route, /request\.method === 'POST'/u);
  const source = liveDashboardScript();
  assert.doesNotMatch(source, /data-lifecycle-(?:approve|send|order|roll-action)/u);
});
