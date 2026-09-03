import assert from 'node:assert/strict';
import test from 'node:test';
import {
  liveDashboardScript, rewriteDesignHtml,
} from '../cloudflare/worker.js';
import { BUNDLED_DESIGN_HTML } from '../cloudflare/design-assets.js';

test('primary dashboard exposes one CSP command surface with exactly three weekly result slots', () => {
  const html = rewriteDesignHtml(BUNDLED_DESIGN_HTML, { cspDefaultSymbol: 'SPY' });
  assert.match(html, /Cash-secured put decision/u);
  assert.match(html, /One engine · one best contract per weekly expiry/u);
  assert.equal((html.match(/data-csp-symbol/gu) ?? []).length, 1);
  assert.equal((html.match(/data-vsim="csp-choices"/gu) ?? []).length, 1);
  assert.doesNotMatch(html, /All computable put rows/u);
  assert.doesNotMatch(html, /csp-math-table/u);
  assert.doesNotMatch(html, /Cash-secured puts<\/button>/u);
  assert.match(html, /data-csp-symbol[^>]*value=""[^>]*placeholder="SPY"/u);
  assert.match(html, /No CSP calculation has been requested/u);
});

test('CSP runs only from the ticker command and consumes the canonical decision endpoint', () => {
  const script = liveDashboardScript();
  assert.doesNotMatch(script, /await runCashSecuredPut\(q\('#csp \[data-csp-calculate\]'\)\)/u);
  assert.doesNotMatch(script, /cspDecisionPromise/u);
  assert.match(script, /if \(cspCalculate\) \{ runCashSecuredPut\(cspCalculate\); return; \}/u);
  assert.match(script, /event\.key === 'Enter' && event\.target\.matches\('\[data-csp-symbol\]'\)/u);
  assert.match(script, /\/api\/cash-secured-put\/calculate/u);
  assert.ok(script.indexOf('const performanceHydration = Promise.all')
    < script.indexOf('let status = await statusRequest'));
  assert.match(script, /Array\.isArray\(result\?\.choices\)/u);
  assert.doesNotMatch(script, /Array\.isArray\(result\.rows\)/u);
  assert.doesNotMatch(script, /csp-candidates/u);
});

test('dashboard navigation follows the wheel and keeps History before Performance', () => {
  const html = rewriteDesignHtml(BUNDLED_DESIGN_HTML, { cspDefaultSymbol: 'SPY' });
  const views = [...html.matchAll(/<button class="nav-button[^>]*data-view="([^"]+)"[^>]*>([^<]+)<\/button>/gu)]
    .map((match) => [match[1], match[2]]);
  assert.deepEqual(views, [
    ['overview', 'Overview'], ['csp', 'CSP'], ['covered-calls', 'Covered Calls'],
    ['positions', 'Position Management'], ['history', 'History'],
    ['performance', 'Performance'], ['bot', 'BOT'], ['system', 'System'],
  ]);
  assert.match(html, /Immutable trade record · learning follows closure/u);
  assert.match(html, /data-vsim="history-trades-body"/u);
  assert.match(html, /Lifetime results and canonical Schwab ledger drill-down/u);
  assert.match(html, /data-vsim="closed-trades-body"/u);
  assert.match(html, /data-vsim="broker-activity-body"/u);
});
