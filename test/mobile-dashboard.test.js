import assert from 'node:assert/strict';
import test from 'node:test';
import { fullDashboard, liveDashboardScript } from '../cloudflare/worker.js';

test('phone monitoring layout reaches every live tab and uses dedicated BOT and System cards', async () => {
  const html = await (await fullDashboard(undefined, { e3SpineTab: true })).text();
  for (const view of ['overview', 'underwrite', 'performance', 'decisions', 'bot', 'e3-spine', 'system']) {
    assert.match(html, new RegExp(`data-view="${view}"`, 'u'));
  }
  assert.match(html, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/u);
  assert.match(html, /#bot>\.bot-disarm-strip,#bot>\.bot-lane-summary-card\{display:grid\}/u);
  assert.match(html, /#system>\.mobile-system-brief\{display:block\}/u);
  assert.match(html, /Principal-confirmed alert configuration; not runtime evidence\./u);
  assert.doesNotMatch(html, /Evidence and measurement notes|lane-summary-details|lane-summary-source/u);
});

test('BOT emergency DISARM is the first phone surface and reports coordinator truth', async () => {
  const html = await (await fullDashboard(undefined, { e3SpineTab: true })).text();
  const botStart = html.indexOf('<section class="view" id="bot"');
  const stripStart = html.indexOf('class="panel bot-disarm-strip"', botStart);
  const headingStart = html.indexOf('class="page-heading"', botStart);
  assert.ok(botStart >= 0 && stripStart > botStart && stripStart < headingStart,
    'DISARM surface is the first BOT child');
  assert.match(html, /data-action="laneDisarm">DISARM<\/button>/u);
  assert.match(html, /Stops new orders — does not cancel or flatten/u);
  assert.match(html, /data-vsim="bot-disarm-state"[^>]+role="status"[^>]*>DISARMED/u);
  assert.match(html, /data-vsim="bot-disarm-error" role="alert" aria-live="assertive" hidden/u);

  const script = liveDashboardScript({ e3SpineTab: true });
  assert.match(script, /qa\('\[data-e3="lane-state"\], \[data-vsim="bot-disarm-state"\]'\)/u);
  assert.match(script, /qa\('\[data-e3="lane-error"\], \[data-vsim="bot-disarm-error"\]'\)/u);
  assert.match(script, /laneState: \(\) => api\('\/api\/lane-1-spy\/state'\)/u);
  assert.match(script, /bounded\(operations\[action\]\(\), 5_000/u);
  assert.match(script, /bounded\(operations\.laneState\(\), 5_000/u);
  assert.match(script, /LANE_1_PRINCIPAL_DISARM_READBACK_TIMEOUT/u);
  assert.match(script, /DISARM UNCONFIRMED/u);
  assert.match(script, /DISARM UNCONFIRMED — the lane may still be armed\. Cancel any in-flight order at Schwab directly\./u);
  assert.match(script, /function setLaneUnconfirmed\(\)[\s\S]{0,260}text\(node, 'UNCONFIRMED'\)/u);
  assert.match(script, /if \(laneControlInFlight\) return;/u);
  assert.match(script, /finally \{\s*laneControlInFlight = false;/u);
  assert.doesNotMatch(script, /bot-disarm-state[^\n]{0,180}(?:fetch|api\()/u);
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
