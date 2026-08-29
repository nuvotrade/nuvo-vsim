import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenLane1ByPrincipal, handlePrincipalFlatten } from '../cloudflare/lane-1-runtime.js';
import { lane1ProposalSeal } from '../src/lane/lane-1-spy.js';

const NOW = Date.parse('2026-08-28T14:30:00.000Z');
const BUY_OCCURRED_AT = '2026-08-28T14:21:39.000Z';

function requestBody(overrides = {}) {
  return {
    buyExecutionActivityId: '129347484620',
    buyOccurredAt: BUY_OCCURRED_AT,
    buyOrderId: '1007749775388',
    buyPrice: 771.785,
    buyTransactionActivityId: '129347484622',
    confirm: 'FLATTEN_1_SPY',
    quantity: 1,
    symbol: 'SPY',
    ...overrides,
  };
}

async function harness() {
  let sequence = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const buySeal = await lane1ProposalSeal({ side: 'BUY', now: Date.parse(BUY_OCCURRED_AT), uuid });
  let state = {
    armed: false, stage: 'FAULT',
    buy: { seal: buySeal, brokerOrderId: '1007749775388', acceptedAt: BUY_OCCURRED_AT },
    sell: null, latestUnit: null,
    fault: { faultCode: 'MISSING_FILL_ID', brokerOrderId: '1007749775388' },
  };
  const units = [];
  const notices = [];
  const brokerCalls = [];
  const writes = [];
  const coordinator = {
    async status() { return structuredClone(state); },
    async recordRecoveredBuy({ unit, buy }) {
      units.push(structuredClone(unit));
      state = { ...state, armed: false, stage: 'FLATTEN_READY',
        buy: { ...state.buy, ...buy }, latestUnit: structuredClone(unit), fault: null };
      return structuredClone(state);
    },
    async claimPrincipalFlatten({ seal }) {
      if (state.stage !== 'FLATTEN_READY') return { claimed: false, state: structuredClone(state) };
      state = { ...state, stage: 'FLATTEN_SENDING', sell: { seal } };
      return { claimed: true, state: structuredClone(state) };
    },
    async recordPrincipalFlattenAccepted({ brokerOrderId, acceptedAt }) {
      state.sell = { ...state.sell, brokerOrderId, acceptedAt };
      return structuredClone(state);
    },
    async recordUnit({ unit }) {
      units.push(structuredClone(unit));
      state = { ...state, armed: false, stage: 'DISARMED', latestUnit: structuredClone(unit) };
      return structuredClone(state);
    },
    async recordFault(detail) {
      state = { ...state, armed: false, stage: 'FAULT', fault: structuredClone(detail) };
      return structuredClone(state);
    },
  };
  const buyFill = {
    fillId: '129347484620', brokerOrderId: '1007749775388',
    clientOrderId: buySeal.clientOrderId, symbol: 'SPY', side: 'BUY', quantityShares: 1,
    executionPriceUsdPerShare: 771.785, feeUsd: 0,
    brokerOccurredAt: BUY_OCCURRED_AT, acquiredAt: '2026-08-28T14:22:00.000Z',
    rawBrokerEvidenceSha256: '11'.repeat(32),
  };
  const client = {
    async lane1FillFromStoredBrokerEvents() { return structuredClone(buyFill); },
    async placeLane1PrincipalFlattenOrder(_ownerId, order, options) {
      brokerCalls.push({ order: structuredClone(order), options: structuredClone(options) });
      return { brokerOrderId: 'SELL-ORDER-1', accountHash: 'ACCOUNT-HASH',
        acceptedAt: '2026-08-28T14:30:01.000Z' };
    },
    async waitForLane1PrincipalFlattenFill(_ownerId, context) {
      return {
        fillId: 'SELL-ACTIVITY-1', brokerOrderId: context.brokerOrderId,
        clientOrderId: context.clientOrderId, symbol: 'SPY', side: 'SELL', quantityShares: 1,
        executionPriceUsdPerShare: 774.305, feeUsd: -0.02,
        brokerOccurredAt: '2026-08-28T14:30:02.000Z', acquiredAt: '2026-08-28T14:30:03.000Z',
        rawBrokerEvidenceSha256: '22'.repeat(32),
      };
    },
  };
  return {
    uuid, coordinator, client, units, notices, brokerCalls, writes,
    dependencies: {
      coordinator, client,
      bundleStore: { async write(emission) {
        writes.push(structuredClone(emission));
        return { objectPrefix: `lane/${emission.manifest.resolvedUnitId}` };
      } },
      notifier: { async send(message) { notices.push(structuredClone(message)); } },
      marketSession: async () => true,
    },
  };
}

test('Principal flatten requires the exact one-shot body and ARMED=OFF before any send', async () => {
  const h = await harness();
  const invalid = await flattenLane1ByPrincipal({
    body: requestBody({ quantity: 2 }), env: { NUVO_LANE_1_SPY_ARMED: 'OFF' },
    ownerId: 'OWNER-1', dependencies: h.dependencies,
  });
  assert.equal(invalid.status, 400);
  assert.equal(h.brokerCalls.length, 0);

  const armed = await flattenLane1ByPrincipal({
    body: requestBody(), env: { NUVO_LANE_1_SPY_ARMED: 'ON' },
    ownerId: 'OWNER-1', dependencies: h.dependencies,
  });
  assert.equal(armed.status, 409);
  assert.equal(h.brokerCalls.length, 0);
});

test('one-shot flatten route is permanently retired before reading credentials or body', async () => {
  const h = await harness();
  for (const supplied of [null, 'wrong']) {
    const headers = { 'content-type': 'application/json' };
    if (supplied) headers['x-nuvo-principal-flatten-token'] = supplied;
    const response = await handlePrincipalFlatten({
      request: new Request('https://vsim.nuvotrade.co/lane/principal-flatten', {
        method: 'POST', headers, body: JSON.stringify(requestBody()),
      }),
      env: { NUVO_LANE_1_SPY_ARMED: 'OFF', LANE_1_PRINCIPAL_FLATTEN_TOKEN: 'one-shot' },
      ownerId: 'OWNER-1', dependencies: h.dependencies,
    });
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), {
      state: 'DISABLED', faultCode: 'LANE_1_FLATTEN_ROUTE_RETIRED',
    });
  }
  assert.equal(h.brokerCalls.length, 0);
});

test('Principal flatten ingests the identified BUY, sends one direct SELL, and disarms', async () => {
  const h = await harness();
  const result = await flattenLane1ByPrincipal({
    body: requestBody(), env: { NUVO_LANE_1_SPY_ARMED: 'OFF' }, ownerId: 'OWNER-1',
    now: () => NOW, uuid: h.uuid, dependencies: h.dependencies,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.state, 'DISARMED');
  assert.equal(result.body.sellActivityId, 'SELL-ACTIVITY-1');
  assert.equal(result.body.realizedPnlCents, 250);
  assert.equal(result.body.realizedPnlUsd, 2.5);
  assert.equal(h.brokerCalls.length, 1);
  assert.deepEqual(h.brokerCalls[0].order, { symbol: 'SPY', side: 'SELL', quantity: 1 });
  assert.equal(h.brokerCalls[0].options.principalToken, 'FLATTEN_1_SPY');
  assert.equal(h.units.length, 2);
  assert.equal(h.units[0].state, 'OPEN_LONG');
  assert.equal(h.units[1].state, 'RESOLVED_FLAT');
  assert.equal(h.writes[1].manifest.schemaVersion, 'E3_RESOLVED_UNIT_BUNDLE_V2_MONEY_CENTS');
  assert.equal(h.writes[1].manifest.moneyContractVersion, 'MONEY_CENTS_V1');
  assert.equal(h.units[0].economicEpisodeId, h.units[1].economicEpisodeId);
  assert.deepEqual(h.notices.map((notice) => notice.type), ['BOUGHT', 'SOLD', 'DISARMED']);
  assert.deepEqual(h.notices[0], {
    type: 'BOUGHT', symbol: 'SPY', quantity: 1,
    fillId: '129347484620', manifestHash: h.units[0].manifestHash,
    priceUsdPerShare: 771.785, feesCents: 0, netCents: -77179,
  });
  assert.deepEqual(h.notices[1], {
    type: 'SOLD', symbol: 'SPY', quantity: 1,
    fillId: 'SELL-ACTIVITY-1', manifestHash: h.units[1].manifestHash,
    priceUsdPerShare: 774.305, feesCents: -2, netCents: 250,
  });
  const soldPnl = h.writes[1].manifest.status === 'RESOLVED_FLAT'
    ? JSON.parse(h.writes[1].bytes['pnl.json']) : null;
  assert.equal(soldPnl.summary.realizedPnlCents, 250);
  assert.equal(soldPnl.summary.roundingRule,
    'NET_EXACT_SUBCENT_THEN_HALF_AWAY_FROM_ZERO_TO_CENT');
  assert.equal(JSON.parse(h.writes[1].bytes['cash.json']).summary.netCashMovementCents, 250);
  assert.doesNotMatch(h.writes[1].bytes['cash.json'], /amountUsd|netCashMovementUsd/u);
  const storedFills = JSON.parse(h.writes[1].bytes['fills.json']).fills;
  assert.deepEqual(storedFills.map((fill) => fill.feeCents), [0, -2]);
  assert.doesNotMatch(h.writes[1].bytes['fills.json'], /feeUsd/u);
});
