import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildE3SpineTab } from '../src/dashboard/e3-spine-tab.js';
import {
  armLaneContract, rewriteDesignHtml, liveDashboardScript, resolveLaneControlOutcome,
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

test('Engine spine consumes the shared projection and never defaults a faulted coordinator to FLAT', () => {
  const model = buildE3SpineTab({ laneUnit: { armed: false, stage: 'FAULT', positionSide: 'FLAT' },
    positionProjection: { status: 'UNVERIFIED', positionSide: 'UNKNOWN',
      coordinator: { positionSide: 'FLAT', stage: 'FAULT', updatedAt: '2026-09-01T13:35:05.000Z' },
      broker: null, brokerRead: { ok: false, error: 'BROKER_UNREACHABLE' } } });
  assert.equal(model.paneC.positionSide, 'UNKNOWN');
  assert.equal(model.paneC.positionProjection.status, 'UNVERIFIED');
  assert.notEqual(model.paneC.positionSide, 'FLAT');
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
  assert.equal((laneBranch.match(/window\.confirm\(/gu) || []).length, 1,
    'ARM confirms once while DISARM starts immediately');
  assert.match(laneBranch, /if \(action === 'laneArm'\)[\s\S]{0,900}if \(!window\.confirm/u);
  assert.doesNotMatch(laneBranch, /action === 'laneDisarm'[^\n]{0,160}window\.confirm/u);
  assert.doesNotMatch(laneBranch, /window\.alert|scroll|location|hash/u);
  assert.doesNotMatch(script, /Arm LANE_1_SPY until you click DISARM/u);
  assert.doesNotMatch(script, /Disarm LANE_1_SPY now/u);
});

test('lane UI reducer updates only accepted success and preserves prior state on failure', () => {
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneArm', previousArmed: false,
    result: { armed: true, state: 'FLAT', reason: 'PRINCIPAL_DASHBOARD_ARM' },
    readback: { armed: true, state: 'FLAT', positionSide: 'FLAT' },
  }), { armed: true, error: null });
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneArm', previousArmed: false,
    result: { armed: true, state: 'OPEN_SHORT', positionSide: 'SHORT' },
    readback: { armed: true, state: 'OPEN_SHORT', positionSide: 'SHORT' },
  }), { armed: true, error: null });
  assert.match(resolveLaneControlOutcome({
    action: 'laneArm', previousArmed: false,
    readback: { armed: true, state: 'OPEN_SHORT', positionSide: 'FLAT' },
  }).error, /LANE_1_PRINCIPAL_ARM_STATE_MISMATCH/u);
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneDisarm', previousArmed: true,
    result: { armed: false, state: 'DISARMED', reason: 'PRINCIPAL_DASHBOARD_DISARM' },
    readback: { armed: false, state: 'DISARMED' },
  }), { armed: false, error: null });
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneArm', previousArmed: true,
    error: new Error('LANE_1_ARM_STATE_NOT_CLEAN'),
  }), { armed: true,
    error: 'ARM UNCONFIRMED — the lane remains in its prior state. (LANE_1_ARM_STATE_NOT_CLEAN)' });
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneDisarm', previousArmed: true,
    result: { armed: false, state: 'DISARMED' },
    readback: { armed: true, state: 'DISARMED' },
  }), { armed: true,
    error: 'DISARM UNCONFIRMED — the lane may still be armed. Cancel any in-flight order at Schwab directly. (LANE_1_PRINCIPAL_DISARM_STATE_MISMATCH)' });
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneDisarm', previousArmed: true,
    error: new Error('LANE_1_CONTROL_RESPONSE_TIMEOUT'),
    readback: { armed: false, state: 'DISARMED' },
  }), { armed: false, error: null });
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneDisarm', previousArmed: true,
    readbackError: new Error('LANE_1_PRINCIPAL_DISARM_READBACK_TIMEOUT'),
  }), { armed: true,
    error: 'DISARM UNCONFIRMED — the lane may still be armed. Cancel any in-flight order at Schwab directly. (LANE_1_PRINCIPAL_DISARM_READBACK_TIMEOUT)' });
  assert.deepEqual(resolveLaneControlOutcome({
    action: 'laneDisarm', previousArmed: false,
    readbackError: new Error('ACCOUNT_COORDINATOR_UNAVAILABLE'),
  }), { armed: false,
    error: 'DISARM UNCONFIRMED — the lane may still be armed. Cancel any in-flight order at Schwab directly. (ACCOUNT_COORDINATOR_UNAVAILABLE)' });
});

test('recovery UI accepts either exact one-share open side and never assumes SHORT', () => {
  const script = liveDashboardScript({ e3SpineTab: true });
  const start = script.indexOf("if (action === 'laneRecover')");
  const end = script.indexOf('const confirmations =', start);
  const branch = script.slice(start, end);
  assert.match(branch, /\['LONG', 'SHORT'\]\.includes\(result\.positionSide\)/u);
  assert.match(branch, /result\.state !== 'OPEN_' \+ result\.positionSide/u);
  assert.doesNotMatch(branch, /result\.state !== 'OPEN_SHORT'/u);
});

test('ARM panel contract follows live coordinator stage and names illegal states', () => {
  assert.deepEqual(armLaneContract({ state: 'OPEN_SHORT', positionSide: 'SHORT' }), {
    permitted: true, transition: 'ARM_EXISTING_SHORT',
    text: 'ARM · OPEN_SHORT · only BUY_TO_COVER permitted',
  });
  assert.deepEqual(armLaneContract({ state: 'OPEN_LONG', positionSide: 'LONG' }), {
    permitted: true, transition: 'ARM_EXISTING_LONG',
    text: 'ARM · OPEN_LONG · only SELL permitted',
  });
  assert.equal(armLaneContract({ state: 'FLAT', positionSide: 'FLAT' }).transition,
    'FLAT_ONLY');
  assert.deepEqual(armLaneContract({ state: 'FAULT', positionSide: 'FLAT',
    faultCode: 'LANE_1_EXIT_PENDING_STATE_REQUIRED' }), {
    permitted: true, transition: 'RESOLVE_COMPLETED_EXIT_AND_ARM',
    text: 'ARM · FLAT · verify completed exit, clear stale fault, and arm',
  });
  assert.equal(armLaneContract({ state: 'FAULT', positionSide: 'SHORT',
    faultCode: 'TEST' }).faultCode, 'LANE_1_ARM_FAULT_PRESENT');
  assert.equal(armLaneContract({ state: 'FILL_PENDING_FEE', positionSide: 'SHORT',
    pendingFill: true }).faultCode, 'LANE_1_ARM_FILL_PENDING');
  const script = liveDashboardScript({ e3SpineTab: true });
  assert.match(script, /ARM_LANE_1_CURRENT_STATE/u);
  assert.match(script, /ARM · OPEN_SHORT · only BUY_TO_COVER permitted/u);
  assert.match(script, /liveArmState = await bounded\(operations\.laneState\(\)/u);
});

test('lane control is single-flight and always releases after failure', () => {
  const script = liveDashboardScript({ e3SpineTab: true });
  const branchStart = script.indexOf("if (action === 'laneArm' || action === 'laneDisarm')");
  const branchEnd = script.indexOf("if (action === 'lanePreview')", branchStart);
  const branch = script.slice(branchStart, branchEnd);
  assert.match(branch, /if \(laneControlInFlight\) return;/u);
  assert.match(branch, /laneControlInFlight = true;/u);
  assert.match(branch, /finally \{\s*laneControlInFlight = false;/u);
  assert.match(branch, /if \(action === 'laneArm'\)[\s\S]{0,900}if \(!window\.confirm/u);
  assert.doesNotMatch(branch, /action === 'laneDisarm'[^\n]{0,160}window\.confirm/u);
  assert.ok(branch.indexOf('if (laneControlInFlight) return;')
    < branch.indexOf('operations[action]()'), 'guard precedes the write');
  assert.ok(branch.indexOf('laneControlInFlight = false;')
    > branch.indexOf('catch (error)'), 'release occurs after the failure path');
});
