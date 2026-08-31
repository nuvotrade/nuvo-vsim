import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveDerivedPreviewOrder } from './helpers/schwab-preview-order.js';
import {
  buildLane1SchwabBracket, buildLane1SchwabExit, buildLane1SchwabMarketOrder, buildLane1SchwabOrder,
  extractLane1BracketStop, extractLane1SchwabFill, fetchLane1PreviewOnly, SchwabD1Client,
  schwabOrderIdFromLocation,
} from '../cloudflare/schwab-client.js';
import { armLane1FromDashboard, disarmLane1FromDashboard } from '../cloudflare/lane-1-runtime.js';
import { createLane1DiscordNotifier } from '../cloudflare/lane-1-runtime.js';

test('Schwab order builder admits only one SPY equity share in NORMAL DAY session', () => {
  assert.deepEqual(buildLane1SchwabOrder({ symbol: 'SPY', side: 'BUY', quantity: 1 }), {
    orderType: 'MARKET',
    session: 'NORMAL',
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    orderLegCollection: [{
      instruction: 'BUY',
      quantity: 1,
      instrument: { symbol: 'SPY', assetType: 'EQUITY' },
    }],
  });
  for (const bad of [
    { symbol: 'QQQ', side: 'BUY', quantity: 1 },
    { symbol: 'SPY', side: 'BUY', quantity: 2 },
    { symbol: 'SPY', side: 'SELL_SHORT', quantity: 1 },
  ]) assert.throws(() => buildLane1SchwabOrder(bad), /LANE_1_ORDER_REFUSED/u);
});

test('Schwab location and fill derive a unique broker identity and require fee evidence', () => {
  assert.equal(schwabOrderIdFromLocation(
    'https://api.schwabapi.com/trader/v1/accounts/hash/orders/123456789',
  ), '123456789');
  assert.throws(() => schwabOrderIdFromLocation(null), /MISSING_ORDER_ID/u);

  const order = {
    status: 'FILLED',
    orderId: '123456789',
    orderActivityCollection: [{
      activityType: 'EXECUTION',
      activityId: 'ACTIVITY-SPY-1',
      executionLegs: [{
        fillId: 'FILL-SPY-1', quantity: 1, price: 550.25, fee: 0,
        time: '2026-08-28T14:00:00.000Z',
      }],
    }],
  };
  assert.equal(extractLane1SchwabFill(order, {
    brokerOrderId: '123456789', clientOrderId: 'LANE1-SPY-1', side: 'BUY',
    acquiredAt: '2026-08-28T14:00:00.100Z', rawBrokerEvidenceSha256: 'ab'.repeat(32),
  }).fillId, 'FILL-SPY-1');

  const missingId = structuredClone(order);
  delete missingId.orderActivityCollection[0].executionLegs[0].fillId;
  assert.equal(extractLane1SchwabFill(missingId, {
    brokerOrderId: '123456789', clientOrderId: 'LANE1-SPY-1', side: 'BUY',
    acquiredAt: '2026-08-28T14:00:00.100Z', rawBrokerEvidenceSha256: 'ab'.repeat(32),
  }).fillId, 'ACTIVITY-SPY-1');
  delete missingId.orderActivityCollection[0].activityId;
  delete missingId.orderActivityCollection[0].executionLegs[0].time;
  assert.throws(() => extractLane1SchwabFill(missingId, {}), /MISSING_FILL_ID/u);
  const missingFee = structuredClone(order);
  delete missingFee.orderActivityCollection[0].executionLegs[0].fee;
  assert.throws(() => extractLane1SchwabFill(missingFee, {}), /MISSING_FEE/u);
});

test('V2 LONG and SHORT are atomic trigger brackets with an exact two-dollar GTC stop', () => {
  for (const [signal, opening, stopInstruction, offset] of [
    ['LONG', 'BUY', 'SELL', -2], ['SHORT', 'SELL_SHORT', 'BUY_TO_COVER', 2],
  ]) {
    const bracket = buildLane1SchwabBracket({ signal });
    assert.equal(bracket.orderStrategyType, 'TRIGGER');
    assert.equal(bracket.orderLegCollection[0].instruction, opening);
    assert.deepEqual(bracket.childOrderStrategies, [{
      orderType: 'STOP', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL',
      orderStrategyType: 'SINGLE', stopPriceLinkBasis: 'TRIGGER',
      stopPriceLinkType: 'VALUE', stopPriceOffset: offset,
      orderLegCollection: [{ instruction: stopInstruction, quantity: 1,
        instrument: { symbol: 'SPY', assetType: 'EQUITY' } }],
    }]);
    assert.deepEqual(extractLane1BracketStop({ childOrderStrategies: [{
      ...bracket.childOrderStrategies[0], orderId: `STOP-${signal}`, status: 'WORKING',
    }] }, signal), {
      orderId: `STOP-${signal}`, status: 'WORKING', instruction: stopInstruction,
      stopPriceLinkBasis: 'TRIGGER', stopPriceLinkType: 'VALUE', stopPriceOffset: offset,
      duration: 'GOOD_TILL_CANCEL',
    });
  }
  assert.equal(buildLane1SchwabExit({ positionSide: 'LONG' }).orderLegCollection[0].instruction, 'SELL');
  assert.equal(buildLane1SchwabExit({ positionSide: 'SHORT' }).orderLegCollection[0].instruction,
    'BUY_TO_COVER');
  assert.throws(() => buildLane1SchwabBracket({ signal: 'LONG', quantity: 2 }),
    /LANE_1_BRACKET_REFUSED/u);
  assert.throws(() => extractLane1BracketStop({ childOrderStrategies: [] }, 'LONG'),
    /LANE_1_BRACKET_CHILD_COUNT_INVALID/u);
});

test('V2.1 market builder distinguishes open short from SELL flatten', () => {
  assert.equal(buildLane1SchwabMarketOrder({ instruction: 'BUY' })
    .orderLegCollection[0].instruction, 'BUY');
  assert.equal(buildLane1SchwabMarketOrder({ instruction: 'SELL' })
    .orderLegCollection[0].instruction, 'SELL');
  assert.equal(buildLane1SchwabMarketOrder({ instruction: 'SELL_SHORT' })
    .orderLegCollection[0].instruction, 'SELL_SHORT');
  assert.equal(buildLane1SchwabMarketOrder({ instruction: 'BUY_TO_COVER' })
    .orderLegCollection[0].instruction, 'BUY_TO_COVER');
  assert.throws(() => buildLane1SchwabMarketOrder({ instruction: 'SELL', quantity: 2 }),
    /LANE_1_MARKET_ORDER_REFUSED/u);
});

test('preview-only transport rejects /orders before any network activity', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return new Response(); };
  await assert.rejects(() => fetchLane1PreviewOnly(
    'https://api.schwabapi.com/trader/v1/accounts/ACCOUNT-HASH/orders',
    { method: 'POST' }, fetcher,
  ), /LANE_1_PREVIEW_DESTINATION_REFUSED/u);
  assert.equal(calls, 0);
});

test('durable dashboard ARM authorizes fill observation while env stays OFF', async () => {
  const client = new SchwabD1Client({ NUVO_LANE_1_SPY_ARMED: 'OFF' });
  let calls = 0;
  client._waitForLane1Fill = async (_ownerId, context) => {
    calls += 1;
    return { fillId: 'FILL-1', ...context };
  };
  const context = { brokerOrderId: 'ORDER-1', clientOrderId: 'CLIENT-1', side: 'BUY',
    accountHash: 'ACCOUNT-HASH', attempts: 1, pollMs: 0 };
  await assert.rejects(() => client.waitForLane1EquityFill('OWNER', context), /LANE_1_DISARMED/u);
  const fill = await client.waitForLane1EquityFill('OWNER', { ...context, durableArm: true });
  assert.equal(fill.fillId, 'FILL-1');
  assert.equal(calls, 1);
});

test('durable dashboard ARM authorizes only the V2.1 lane market send while env stays OFF', async () => {
  const originalFetch = globalThis.fetch; const requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Response(null, { status: 201,
        headers: { location: 'https://api.schwabapi.com/trader/v1/accounts/hash/orders/ORDER-1' } });
    };
    const client = new SchwabD1Client({ NUVO_LANE_1_SPY_ARMED: 'OFF' });
    client.configured = () => true;
    client._laneAccountHash = async () => ({ accountHash: 'ACCOUNT-HASH', token: 'token' });

    await assert.rejects(() => client.placeLane1V21Market('OWNER', { instruction: 'BUY' }),
      /LANE_1_DISARMED/u);
    assert.equal(requests.length, 0);

    const accepted = await client.placeLane1V21Market('OWNER', { instruction: 'BUY' },
      { durableArm: true });
    assert.equal(accepted.brokerOrderId, 'ORDER-1');
    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.endsWith('/accounts/ACCOUNT-HASH/orders'));
    assert.deepEqual(requests[0].body, buildLane1SchwabMarketOrder({ instruction: 'BUY' }));

    await assert.rejects(() => client.placeLane1EquityOrder('OWNER',
      { symbol: 'SPY', side: 'BUY', quantity: 1 }, { durableArm: true }), /LANE_1_DISARMED/u);
    assert.equal(requests.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('market preview clears BUY and disables only SHORT on a SELL_SHORT failure while OFF', async () => {
  const originalFetch = globalThis.fetch; const requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      const orderStrategy = JSON.parse(init.body); requests.push({ url, orderStrategy });
      if (orderStrategy.orderLegCollection[0].instruction === 'SELL_SHORT') {
        return new Response(JSON.stringify({ error: 'SHORT_NOT_SUPPORTED' }), { status: 500 });
      }
      return new Response(JSON.stringify({ orderValidationResult: {
        rejects: [], reviews: [], warns: [], alerts: [],
      }, orderStrategy: liveDerivedPreviewOrder(orderStrategy.orderLegCollection[0].instruction) }), { status: 200 });
    };
    const client = new SchwabD1Client({ NUVO_LANE_1_SPY_ARMED: 'OFF' });
    client.configured = () => true;
    client._laneAccountHash = async () => ({ accountHash: 'ACCOUNT-HASH', token: 'token',
      accountMask: '•4315' });
    const result = await client.previewLane1V21Markets('OWNER');
    assert.deepEqual(result.previews.map((row) => row.signal), ['LONG', 'SHORT']);
    assert.equal(result.longEnabled, true); assert.equal(result.shortEnabled, false);
    assert.deepEqual(result.previews.map((row) => row.status), ['CLEAR', 'DISABLED']);
    assert.equal(result.previews[1].faultCode, 'SCHWAB_LANE_MARKET_PREVIEW_SHORT_500');
    assert.equal(result.previews[1].rawResponseBody, '{"error":"SHORT_NOT_SUPPORTED"}');
    assert.match(result.previews[1].rawResponseSha256, /^[a-f0-9]{64}$/u);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((row) => row.url.endsWith('/accounts/ACCOUNT-HASH/previewOrder')));
    assert.deepEqual(requests.map((row) => row.orderStrategy.orderLegCollection[0].instruction),
      ['BUY', 'SELL_SHORT']);
    assert.ok(requests.every((row) => row.orderStrategy.orderType === 'MARKET'
      && row.orderStrategy.orderStrategyType === 'SINGLE'
      && row.orderStrategy.childOrderStrategies === undefined));

    let calls = 0; globalThis.fetch = async () => { calls += 1; return new Response(); };
    const armed = new SchwabD1Client({ NUVO_LANE_1_SPY_ARMED: 'ON' });
    await assert.rejects(() => armed.previewLane1V21Markets('OWNER'),
      /LANE_1_MARKET_PREVIEW_REQUIRES_ARMED_OFF/u);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('market preview retains SHORT only when BUY and SELL_SHORT both clear exactly', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      const orderStrategy = JSON.parse(init.body);
      return new Response(JSON.stringify({ orderValidationResult: {
        rejects: [], reviews: [], warns: [], alerts: [],
      }, orderStrategy: liveDerivedPreviewOrder(orderStrategy.orderLegCollection[0].instruction) }), { status: 200 });
    };
    const client = new SchwabD1Client({ NUVO_LANE_1_SPY_ARMED: 'OFF' });
    client.configured = () => true;
    client._laneAccountHash = async () => ({ accountHash: 'ACCOUNT-HASH', token: 'token',
      accountMask: '•4315' });
    const result = await client.previewLane1V21Markets('OWNER');
    assert.equal(result.longEnabled, true); assert.equal(result.shortEnabled, true);
    assert.deepEqual(result.previews.map((row) => [row.signal, row.instruction, row.status]), [
      ['LONG', 'BUY', 'CLEAR'], ['SHORT', 'SELL_SHORT', 'CLEAR'],
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test('dashboard ARM directly enables the durable lane without preview or order', async () => {
  const calls = [];
  const stub = {
    async laneV2PrincipalArm(value) {
      calls.push(value);
      return { armed: true, stage: 'FLAT', expiresAt: value.expiresAt };
    },
  };
  const result = await armLane1FromDashboard({
    env: { ACCOUNT_COORDINATOR: { getByName: (owner) => {
      assert.equal(owner, 'OWNER'); return stub;
    } } }, ownerId: 'OWNER', now: () => Date.parse('2026-08-28T18:55:00.000Z'),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { armed: true, state: 'FLAT',
    reason: 'PRINCIPAL_DASHBOARD_ARM',
    expiresAt: '2026-08-29T18:55:00.000Z' });
  assert.deepEqual(calls, [{ reason: 'PRINCIPAL_DASHBOARD_ARM',
    armedAt: '2026-08-28T18:55:00.000Z', expiresAt: '2026-08-29T18:55:00.000Z' }]);
});

test('dashboard DISARM persists directly without invoking the Discord notifier', async () => {
  const calls = [];
  const stub = {
    async laneV2Disarm(value) {
      calls.push(value);
      return { armed: false, stage: 'DISARMED' };
    },
  };
  const result = await disarmLane1FromDashboard({
    env: { ACCOUNT_COORDINATOR: { getByName: () => stub } }, ownerId: 'OWNER',
    now: () => Date.parse('2026-08-28T19:00:00.000Z'),
  });
  assert.deepEqual(result, { status: 200, body: { armed: false, state: 'DISARMED',
    reason: 'PRINCIPAL_DASHBOARD_DISARM' } });
  assert.deepEqual(calls, [{ reason: 'PRINCIPAL_DASHBOARD_DISARM',
    at: '2026-08-28T19:00:00.000Z' }]);
});

test('dashboard DISARM returns the Durable Object rejection reason fail-closed', async () => {
  const result = await disarmLane1FromDashboard({
    env: { ACCOUNT_COORDINATOR: { getByName: () => ({
      laneV2Disarm: async () => { throw new Error('LANE_1_TEST_DISARM_REJECTED: detail'); },
    }) } }, ownerId: 'OWNER', now: () => Date.parse('2026-08-28T19:00:00.000Z'),
  });
  assert.deepEqual(result, { status: 422, body: {
    faultCode: 'LANE_1_TEST_DISARM_REJECTED' } });
});

test('Discord notifier is locked to NUVO VSIM #test and requires complete trade economics', async () => {
  const calls = [];
  const notifier = createLane1DiscordNotifier({
    webhookUrl: 'https://discord.com/api/webhooks/test-only',
    server: 'NUVO VSIM', channel: 'test',
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
  });
  await notifier.send({ type: 'ARMED' });
  await notifier.send({ type: 'BOUGHT', fillId: '129347484620', symbol: 'SPY', quantity: 1,
    priceUsdPerShare: 771.785, feesCents: 0, netCents: -77179 });
  await notifier.send({ type: 'SOLD', fillId: '129366600925', symbol: 'SPY', quantity: 1,
    priceUsdPerShare: 774.305, feesCents: -2, netCents: 250 });
  await notifier.send({ type: 'FAULT', faultCode: 'TEST_FAULT' });
  await notifier.send({ type: 'DISARMED', reason: 'ROUND_TRIP_COMPLETE' });
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => call.url === 'https://discord.com/api/webhooks/test-only'));
  assert.deepEqual(calls.map((call) => JSON.parse(call.init.body).content.split(' · ')[1]),
    ['ARMED', 'BOUGHT', 'SOLD', 'FAULT', 'DISARMED']);
  assert.equal(JSON.parse(calls[1].init.body).content,
    'LANE_1_SPY · BOUGHT · fill=129347484620 · price=$771.785 · qty=1 · fees=$0.00 · net=-$771.79');
  assert.equal(JSON.parse(calls[2].init.body).content,
    'LANE_1_SPY · SOLD · fill=129366600925 · price=$774.305 · qty=1 · fees=$0.02 · net=$2.50');

  await notifier.send({ type: 'OPENED', side: 'SHORT', fillId: 'OPEN-1', symbol: 'SPY',
    quantity: 1, priceUsdPerShare: 774.305, feesCents: 0, netCents: 77431,
    brokerOrderId: 'TV-ORDER-SHORT', tvBodyBindingSha256: 'cd'.repeat(32),
    stop: { orderId: 'STOP-1', status: 'WORKING', stopPriceOffset: 2,
      stopPriceLinkBasis: 'TRIGGER' } });
  assert.equal(JSON.parse(calls.at(-1).init.body).content,
    'LANE_1_SPY · OPENED · fill=OPEN-1 · price=$774.305 · qty=1 · fees=$0.00 · net=$774.31 · side=SHORT · order=TV-ORDER-SHORT · tv=cdcdcdcdcdcd · stop=fill+$2.00 · stopStatus=WORKING · stopOrder=STOP-1');

  await assert.rejects(() => notifier.send({ type: 'SOLD', fillId: 'missing-economics' }),
    /LANE_1_DISCORD_ECONOMICS_REQUIRED/u);
  await assert.rejects(() => notifier.send({ type: 'FILLED' }),
    /LANE_1_DISCORD_MESSAGE_REFUSED/u);
  await notifier.send({ type: 'OPENED', side: 'LONG', fillId: 'x',
    symbol: 'SPY', quantity: 1, priceUsdPerShare: 1, feesCents: 0, netCents: -100,
    brokerOrderId: 'TV-ORDER-1', tvBodyBindingSha256: 'ab'.repeat(32) });
  assert.equal(JSON.parse(calls.at(-1).init.body).content,
    'LANE_1_SPY · OPENED · fill=x · price=$1.000 · qty=1 · fees=$0.00 · net=-$1.00 · side=LONG · order=TV-ORDER-1 · tv=abababababab');

  await notifier.send({ type: 'EXITED', side: 'FLAT', fromSide: 'LONG', fillId: 'y',
    symbol: 'SPY', quantity: 1, priceUsdPerShare: 2, feesCents: -2, netCents: 98,
    brokerOrderId: 'TV-ORDER-2', tvBodyBindingSha256: 'ef'.repeat(32) });
  assert.equal(JSON.parse(calls.at(-1).init.body).content,
    'LANE_1_SPY · EXITED · fill=y · price=$2.000 · qty=1 · fees=$0.02 · net=$0.98 · side=FLAT · from=LONG · order=TV-ORDER-2 · tv=efefefefefef');

  assert.throws(() => createLane1DiscordNotifier({
    webhookUrl: 'https://discord.com/api/webhooks/wrong', server: 'NUVO VSIM', channel: 'general',
  }), /DISCORD_DESTINATION_REFUSED/u);
});

test('Discord trade delivery retries twice before succeeding', async () => {
  let attempts = 0;
  const notifier = createLane1DiscordNotifier({
    webhookUrl: 'https://discord.com/api/webhooks/test-only', server: 'NUVO VSIM', channel: 'test',
    fetcher: async () => {
      attempts += 1;
      return new Response(null, { status: attempts < 3 ? 503 : 204 });
    },
  });
  await notifier.send({ type: 'OPENED', side: 'LONG', fillId: 'FILL-1', symbol: 'SPY',
    quantity: 1, priceUsdPerShare: 771.785, feesCents: 0, netCents: -77179,
    brokerOrderId: 'ORDER-1', tvBodyBindingSha256: 'ab'.repeat(32) });
  assert.equal(attempts, 3);
});
