import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildE3SpineTab } from '../src/dashboard/e3-spine-tab.js';
import {
  rewriteDesignHtml, liveDashboardScript, resolveLaneControlOutcome,
} from '../cloudflare/worker.js';

test('pane C shows the durable LANE_1_SPY diary unit and never calls it a fixture', () => {
  const model = buildE3SpineTab({
    cycleSnapshot: null,
    laneUnit: {
      label: 'LANE_1_SPY',
      state: 'AWAITING_SELL',
      symbol: 'SPY',
      quantity: 1,
      buyFillId: 'FILL-BUY-1',
      sellFillId: null,
      manifestHash: 'ab'.repeat(32),
      realizedPnlUsd: null,
      updatedAt: '2026-08-28T14:00:00.000Z',
    },
  });
  assert.equal(model.paneC.label, 'LANE_1_SPY');
  assert.equal(model.paneC.fixture, false);
  assert.equal(model.paneC.symbol, 'SPY');
  assert.equal(model.paneC.quantity, 1);
  assert.equal(model.paneC.buyFillId, 'FILL-BUY-1');
});

test('pane C derives dollars from canonical integer cents and prefers them over legacy dollars', () => {
  const model = buildE3SpineTab({ laneUnit: {
    stage: 'DISARMED',
    latestUnit: { realizedPnlCents: 250, realizedPnlUsd: 2.51 },
  } });
  assert.equal(model.paneC.realizedPnlUsd, 2.5);
});

test('pane C exposes only a persisted replayable TV ingress and keeps old rows dead', () => {
  const model = buildE3SpineTab({ laneUnit: { armed: false, stage: 'DISARMED' },
    lanePreviewSource: { replayEligible: true, ingressId: 'INGRESS-1',
      receivedAt: '2026-08-28T23:47:37.284Z', ticker: 'SPY', side: 'BUY', qty: 1,
      tvBodyBindingSha256: 'ab'.repeat(32) } });
  assert.deepEqual(model.paneC.previewSource, { ingressId: 'INGRESS-1',
    receivedAt: '2026-08-28T23:47:37.284Z', ticker: 'SPY', side: 'BUY', qty: 1,
    tvBodyBindingSha256: 'ab'.repeat(32) });
  assert.equal(buildE3SpineTab({ lanePreviewSource: { replayEligible: false } })
    .paneC.previewSource, null);
});

test('pane C is confined to Engine spine and Overview source remains untouched', () => {
  const marker = '<section class="view active" id="overview"><p>OVERVIEW-SENTINEL</p></section>';
  const source = `<html><head><title>NUVO VSIM v5 — Shadow Preview</title><link href="styles.css"></head><body><nav><button class="nav-button" data-view="system">System</button></nav><main>${marker}</main><script src="app.js"></script></body></html>`;
  const rendered = rewriteDesignHtml(source, { e3SpineTab: true });
  assert.ok(rendered.includes(marker), 'Overview bytes must remain exactly present');
  assert.match(rendered, /data-e3-pane="lane"/u);
  assert.match(rendered, /LANE_1_SPY/u);
  assert.doesNotMatch(marker, /LANE_1_SPY/u);

  const script = liveDashboardScript({ e3SpineTab: true });
  assert.match(script, /renderE3Spine/u);
  assert.match(script, /lane-state/u);
  assert.match(rendered, /data-action="laneArm">ARM LANE_1_SPY/u);
  assert.match(rendered, /data-action="laneDisarm">DISARM LANE_1_SPY/u);
  assert.match(rendered, /data-action="lanePreview" disabled>VALIDATE ORDER/u);
  assert.doesNotMatch(rendered, /name="(?:ticker|side|qty)"/u);
  assert.match(script, /\/api\/lane-1-spy\/arm/u);
  assert.match(script, /\/api\/lane-1-spy\/disarm/u);
  assert.match(script, /\/api\/lane-1-spy\/preview-ingress/u);
  assert.match(script, /JSON\.stringify\(\{ ingressId \}\)/u);
  assert.match(script, /Historical rows without a stored body cannot be invented/u);
  const workerSource = readFileSync(new URL('../cloudflare/worker.js', import.meta.url), 'utf8');
  assert.match(workerSource,
    /url\.pathname === '\/api\/lane-1-spy\/validate-market'[\s\S]{0,180}LANE_1_PREVIEW_GATE_RETIRED[\s\S]{0,80}410/u);
  assert.match(rendered, /class="readonly-tag lane-arm-state"/u);
  assert.match(rendered, /data-e3="lane-error" role="alert" hidden/u);
  assert.match(rendered, /lane-arm-state\[data-state="armed"\]/u);
  assert.match(rendered, /lane-arm-state\[data-state="disarmed"\]/u);

  const laneStart = script.indexOf("if (action === 'laneArm' || action === 'laneDisarm')");
  const laneEnd = script.indexOf("if (['pause','resume','kill','clearKill']", laneStart);
  assert.ok(laneStart > 0 && laneEnd > laneStart);
  const laneBranch = script.slice(laneStart, laneEnd);
  assert.doesNotMatch(laneBranch, /confirm|alert|scroll|location|hash/u);
  assert.doesNotMatch(script, /Arm LANE_1_SPY until you click DISARM/u);
  assert.doesNotMatch(script, /Disarm LANE_1_SPY now/u);
});

test('lane UI reducer updates only accepted success and preserves prior state on failure', () => {
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneArm', previousArmed: false,
    result: { armed: true, state: 'FLAT', reason: 'PRINCIPAL_DASHBOARD_ARM' },
  }), { armed: true, error: null });
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneDisarm', previousArmed: true,
    result: { armed: false, state: 'DISARMED', reason: 'PRINCIPAL_DASHBOARD_DISARM' },
  }), { armed: false, error: null });
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneArm', previousArmed: true,
    error: new Error('LANE_1_ARM_STATE_NOT_CLEAN'),
  }), { armed: true, error: 'ARM failed: LANE_1_ARM_STATE_NOT_CLEAN' });
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneDisarm', previousArmed: false,
    result: { faultCode: 'LANE_1_TEST_DISARM_REJECTED' },
  }), { armed: false, error: 'DISARM failed: LANE_1_TEST_DISARM_REJECTED' });
});
