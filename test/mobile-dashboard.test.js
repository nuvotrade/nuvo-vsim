import assert from 'node:assert/strict';
import test from 'node:test';
import { fullDashboard, liveDashboardScript } from '../cloudflare/worker.js';

test('phone monitoring layout reaches every live tab and uses dedicated BOT and System cards', async () => {
  const html = await (await fullDashboard(undefined, { e3SpineTab: true })).text();
  for (const view of ['overview', 'underwrite', 'performance', 'decisions', 'bot', 'e3-spine', 'system']) {
    assert.match(html, new RegExp(`data-view="${view}"`, 'u'));
  }
  assert.match(html, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/u);
  assert.match(html, /#bot>\.bot-lane-summary-card\{display:block\}/u);
  assert.match(html, /#system>\.mobile-system-brief\{display:block\}/u);
  assert.match(html, /Principal-confirmed alert configuration; not runtime evidence\./u);
  assert.doesNotMatch(html, /Evidence and measurement notes|lane-summary-details|lane-summary-source/u);
});

test('phone portfolio tables become labeled cards instead of clipped or horizontal tables', async () => {
  const html = await (await fullDashboard()).text();
  assert.match(html, /\.portfolio-ledger \.table-wrap,#overview \.positions-empty \.table-wrap\{margin:0;overflow:visible\}/u);
  assert.match(html, /\.portfolio-ledger tbody tr,#overview \.positions-empty tbody tr\{display:block/u);
  assert.match(html, /content:attr\(data-label\)/u);
  assert.match(html, /\.expiration-row \.risk-track\{grid-column:1\/-1;grid-row:2\}/u);
  const script = liveDashboardScript();
  assert.match(script, /cell\.dataset\.label = labels\[index\] \|\| ''/u);
  assert.match(script, /cell\.dataset\.label = labels\[index\]/u);
});

test('mobile packet remains a rendering change with no new broker endpoint', () => {
  const script = liveDashboardScript();
  assert.doesNotMatch(script, /mobile[^\n]{0,120}\/orders/iu);
  assert.match(script, /qa\('\[data-vsim="lane-summary-matrix-body"\]'\)\.forEach/u);
  assert.match(script, /const systemCards = qa\('\.system-brief'\)/u);
});
