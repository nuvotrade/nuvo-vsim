import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  e3SpineTabEnabled, fullDashboard, liveDashboardScript, rewriteDesignHtml,
} from '../cloudflare/worker.js';
import { BUNDLED_DESIGN_HTML } from '../cloudflare/design-assets.js';

test('E3 spine feature flag is explicit and defaults off', async () => {
  assert.equal(e3SpineTabEnabled({}), false);
  assert.equal(e3SpineTabEnabled({ NUVO_E3_SPINE_TAB: 'OFF' }), false);
  assert.equal(e3SpineTabEnabled({ NUVO_E3_SPINE_TAB: 'false' }), false);
  assert.equal(e3SpineTabEnabled({ NUVO_E3_SPINE_TAB: 'ON' }), true);

  const defaultHtml = rewriteDesignHtml(BUNDLED_DESIGN_HTML);
  assert.doesNotMatch(defaultHtml, /data-view="e3-spine"/u);
  assert.doesNotMatch(defaultHtml, /id="e3-spine"/u);
  assert.doesNotMatch(defaultHtml, /LIVE MARKS · NOT A UNIT/u);
  const defaultResponse = await fullDashboard();
  assert.doesNotMatch(await defaultResponse.text(), /data-view="e3-spine"/u);
});

test('enabled E3 spine injects two read-only panes without changing Overview markup', async () => {
  const defaultHtml = rewriteDesignHtml(BUNDLED_DESIGN_HTML);
  const html = rewriteDesignHtml(BUNDLED_DESIGN_HTML, { e3SpineTab: true });
  const defaultOverviewStart = defaultHtml.indexOf('<section class="view active" id="overview"');
  const defaultOverviewEnd = defaultHtml.indexOf('<section class="view" id="underwrite"');
  const defaultOverview = defaultHtml.slice(defaultOverviewStart, defaultOverviewEnd);
  const rewrittenOverviewStart = html.indexOf('<section class="view active" id="overview"');
  const rewrittenOverviewEnd = html.indexOf('<section class="view" id="underwrite"');
  const rewrittenOverview = html.slice(rewrittenOverviewStart, rewrittenOverviewEnd);

  assert.match(html, /data-view="e3-spine">Engine spine/u);
  assert.match(html, /id="e3-spine"/u);
  assert.match(html, /data-e3-pane="fixture"/u);
  assert.match(html, />FIXTURE</u);
  assert.match(html, /data-e3-pane="live"/u);
  assert.match(html, /LIVE MARKS · NOT A UNIT/u);
  assert.match(html, /data-e3="live-nav"/u);
  assert.match(html, /data-e3="live-cash-derived"/u);
  assert.match(html, /CBRS · LAST PRICE/u);
  assert.match(html, /SPCX · LAST PRICE/u);
  assert.match(html, /data-e3="live-cbrs"/u);
  assert.match(html, /data-e3="live-spcx"/u);
  assert.equal(rewrittenOverview, defaultOverview,
    'enabling the new tab must not alter the existing runtime Overview section');
});

test('live view fetches the E3 read-only model only when the flag is enabled', () => {
  const off = liveDashboardScript();
  const on = liveDashboardScript({ e3SpineTab: true });
  assert.doesNotThrow(() => new Function(off));
  assert.doesNotThrow(() => new Function(on));
  assert.match(off, /const E3_SPINE_ENABLED = false/u);
  assert.match(on, /const E3_SPINE_ENABLED = true/u);
  assert.match(on, /if \(E3_SPINE_ENABLED\) requests\.push\(api\('\/api\/e3-spine'\)\)/u);
  assert.match(on, /function renderE3Spine\(model\)/u);
  assert.doesNotMatch(on, /submitOrder|replaceOrder|cancelOrder/u);
});
