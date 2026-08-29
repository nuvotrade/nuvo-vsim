import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildE3SpineTab, E3_SPINE_TAB_FLAG } from '../src/dashboard/e3-spine-tab.js';

test('E3 spine model keeps synthetic fixture economics separate from live marks', () => {
  const cycleSnapshot = {
    observedAt: '2026-08-27T03:26:29.035Z',
    account: { nav: 167242.68, cash: 3467.68, reportedCashBalance: 0 },
    positions: [
      { type: 'EQUITY', symbol: 'CBRS', quantity: 500, multiplier: 1, marketValue: 93520 },
      { type: 'OPTION', symbol: 'CBRS260828C00210000', underlying: 'CBRS',
        quantity: -5, multiplier: 100, marketValue: -212.5 },
      { type: 'EQUITY', symbol: 'SPCX', quantity: 500, multiplier: 1, marketValue: 70100 },
    ],
  };
  const before = JSON.parse(JSON.stringify(cycleSnapshot));
  const model = buildE3SpineTab({ cycleSnapshot });

  assert.equal(E3_SPINE_TAB_FLAG, 'NUVO_E3_SPINE_TAB');
  assert.deepEqual(cycleSnapshot, before);
  assert.equal(model.readOnly, true);
  assert.equal(model.paneA.label, 'FIXTURE');
  assert.equal(model.paneA.putUnit.netCashUsd, -9656.95);
  assert.equal(model.paneA.putUnit.optionRealizedPnlUsd, 348.05);
  assert.equal(model.paneA.putUnit.shares, 200);
  assert.equal(model.paneA.coveredCallUnit.callNetCashUsd, 158.70);
  assert.equal(model.paneA.coveredCallUnit.cumulativeEpisodeCashUsd, -9498.25);
  assert.equal(model.paneA.coveredCallUnit.cumulativeOptionRealizedPnlUsd, 506.75);
  assert.equal(model.paneA.coveredCallUnit.thirdCallOutcome,
    'FAULT:COVERED_CALL_INSUFFICIENT_DELIVERABLE_SHARES');

  assert.equal(model.paneB.label, 'LIVE MARKS · NOT A UNIT');
  assert.equal(model.paneB.notAUnit, true);
  assert.equal(model.paneB.values.nav.value, 167242.68);
  assert.equal(model.paneB.values.cashDerived.value, 3467.68);
  assert.equal(model.paneB.values.cashDerived.source,
    'CYCLE_SNAPSHOT_NAV_MINUS_POSITION_MARKS');
  assert.equal(model.paneB.values.CBRS.value, 187.04);
  assert.equal(model.paneB.values.SPCX.value, 140.2);
});

test('unavailable live marks remain null and never borrow fixture values', () => {
  const model = buildE3SpineTab({ cycleSnapshot: {
    observedAt: '2026-08-28T00:00:00.000Z',
    account: {},
    positions: [{ type: 'EQUITY', symbol: 'CBRS', quantity: 0, marketValue: 0 }],
  } });
  assert.equal(model.paneB.values.nav.value, null);
  assert.equal(model.paneB.values.cashDerived.value, null);
  assert.equal(model.paneB.values.CBRS.value, null);
  assert.equal(model.paneB.values.SPCX.value, null);
  assert.doesNotMatch(JSON.stringify(model), /forecast|calibration/iu);
});
