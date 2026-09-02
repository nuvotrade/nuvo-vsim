import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';

let mf;
before(async () => {
  const coordinatorMutations = {
    ARM_CLEARS_POSITION: ["stage='OPEN_SHORT',position_side='SHORT',updated_at=?",
      "stage='FLAT',position_side='FLAT',updated_at=?"],
    DIFFERING_RECOVERY_IDENTITY_IS_NOOP: ['if (sameLane1FillIdentity(state.entryIdentity.identity, identity)) {',
      'if (true || sameLane1FillIdentity(state.entryIdentity.identity, identity)) {'],
    ARM_EXISTING_PERMITS_WRONG_EXIT: ['      || seal?.brokerInstruction !== expectedInstruction) {', ') {'],
  };
  const selectedMutation = coordinatorMutations[process.env.LANE1_COORDINATOR_MUTATION];
  const plugins = selectedMutation ? [{ name: 'lane1-in-memory-coordinator-mutation',
    setup(builder) { builder.onLoad({ filter: /cloudflare\/platform\.js$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      assert.equal(source.split(selectedMutation[0]).length, 2,
        'coordinator mutation anchor must be unique');
      process.stderr.write('COORDINATOR_MUTATION_APPLIED\n');
      return { contents: source.replace(selectedMutation[0], selectedMutation[1]), loader: 'js' };
    }); } }] : [];
  const built = await build({ stdin: { contents: `
    import { VsimAccountCoordinator } from './cloudflare/platform.js';
    export { VsimAccountCoordinator };
    export default { async fetch(request, env) {
      const input = await request.json();
      const stub = env.ACCOUNT_COORDINATOR.getByName(input.owner);
      try { return Response.json({ok:true, result:await stub[input.method](input.args)}); }
      catch (error) { return Response.json({ok:false, error:String(error?.message ?? error)}, {status:422}); }
    }};`, resolveDir: process.cwd(), sourcefile: 'lane1-coordinator-test.js' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', plugins,
  external: ['cloudflare:workers', 'node:*'] });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: built.outputFiles[0].text, compatibilityDate: '2026-08-26',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { ACCOUNT_COORDINATOR: {
      className: 'VsimAccountCoordinator', useSQLite: true,
    } } }));
});
after(async () => { await mf?.dispose(); });

const hash = (digit = 'a') => digit.repeat(64);
const capture = (id) => ({ schema: 'LANE_1_FILL_RAW_RESPONSE_V1', complete: true,
  captureId: id, source: 'BROKER_LEDGER_RECONSTRUCTION',
  bodyKey: `owners/x/${id}/original.encrypted.json`, originalSha256: hash('b'),
  receivedAt: '2026-09-01T13:35:04.100Z', brokerOrderId: 'ORDER-1',
  clientOrderId: 'CLIENT-1', instruction: 'SELL_SHORT' });
const identity = (overrides = {}) => ({ accountHash: 'ACCOUNT-HASH', brokerOrderId: 'ORDER-1',
  clientOrderId: 'CLIENT-1', executionActivityId: 'EXECUTION-1', instruction: 'SELL_SHORT',
  occurredAt: '2026-09-01T13:35:04.000Z', priceUsdPerShare: 761.98,
  quantityShares: 1, symbol: 'SPY', transactionActivityId: 'TRANSACTION-1',
  tvBodyBindingSha256: hash(), ...overrides });
const evidence = () => ({ order: capture('RECOVERY-ORDER'),
  transaction: capture('RECOVERY-TRANSACTION') });
const unit = () => ({ state: 'OPEN_SHORT', symbol: 'SPY', quantity: 1, positionSide: 'SHORT',
  openingFillId: 'EXECUTION-1', openingFeeCents: -2, updatedAt: '2026-09-01T13:35:05.000Z',
  manifestHash: hash('c'), events: [{ eventType: 'EQUITY_FILL', fillId: 'EXECUTION-1',
    brokerOrderId: 'ORDER-1', clientOrderId: 'CLIENT-1', side: 'SELL_SHORT', symbol: 'SPY',
    quantityShares: 1, executionPriceUsdPerShare: 761.98, feeCents: -2,
    brokerOccurredAt: '2026-09-01T13:35:04.000Z' }] });

async function rpc(owner, method, args = {}) {
  const response = await mf.dispatchFetch('http://local.test/rpc', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner, method, args }) });
  return { status: response.status, ...(await response.json()) };
}

async function faultedShortDispatch(owner, { fault = true } = {}) {
  const now = Date.now();
  const armedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 86_400_000).toISOString();
  const seal = { brokerInstruction: 'SELL_SHORT', quantityShares: 1,
    clientOrderId: 'CLIENT-1', tvBodyBindingSha256: hash(), proposalHash: hash('d') };
  const initialArm = await rpc(owner, 'laneV2PrincipalArm', {
    reason: 'PRINCIPAL_DASHBOARD_ARM', armedAt, expiresAt });
  assert.equal(initialArm.status, 200, JSON.stringify(initialArm));
  assert.equal(initialArm.result.stage, 'FLAT');
  assert.equal((await rpc(owner, 'laneV2Claim', { signal: 'SHORT', seal })).result.claimed, true);
  await rpc(owner, 'laneV2RecordAccepted', { signal: 'SHORT', brokerOrderId: 'ORDER-1',
    acceptedAt: new Date(now + 1).toISOString() });
  await rpc(owner, 'laneV2RecordPendingFill', { signal: 'SHORT', seal,
    accepted: { brokerOrderId: 'ORDER-1', acceptedAt: new Date(now + 1).toISOString() },
    ownerId: owner, brokerOrderId: 'ORDER-1', clientOrderId: 'CLIENT-1', side: 'SELL_SHORT',
    startedAt: new Date(now + 1).toISOString(), deadlineAt: new Date(now + 120_001).toISOString(),
    pendingReason: 'MISSING_FEE', tvBodyBindingSha256: hash() });
  if (fault) await rpc(owner, 'laneV2RecordFault', { faultCode: 'MISSING_FEE',
    brokerOrderId: 'ORDER-1', at: new Date(now + 2).toISOString() });
  return { seal, armedAt, expiresAt };
}

function wireEvidence() {
  const source = {
    acceptance: 'SCHWAB_ORDER_ACCEPTANCE_RESPONSE',
    order: 'SCHWAB_ORDER_RESPONSE',
    transaction: 'SCHWAB_TRANSACTION_RESPONSE',
  };
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, {
    ...capture(`WIRE-${key.toUpperCase()}`), source: value,
  }]));
}

function snapshot(side = 'SHORT') {
  const now = Date.now();
  return { symbol: 'SPY', positionSide: side, longQuantity: side === 'LONG' ? 1 : 0,
    shortQuantity: side === 'SHORT' ? 1 : 0, netQuantity: side === 'LONG' ? 1 : side === 'SHORT' ? -1 : 0,
    accountHash: 'ACCOUNT-HASH', orderStateSha256: hash('e'),
    orderCheckBound: 'NO_WORKING_SPY_ORDER_IN_60_DAY_QUERY',
    readStartedAt: new Date(now).toISOString(), acquiredAt: new Date(now).toISOString(),
    ordersFrom: new Date(now - 60 * 86_400_000).toISOString(),
    ordersTo: new Date(now + 60_000).toISOString() };
}

test('strict recovery is atomic, idempotent, and a differing identity faults', async () => {
  await faultedShortDispatch('RECOVERY-OWNER');
  const args = { signal: 'SHORT', unit: unit(), identity: identity(),
    evidenceOrigin: 'BROKER_LEDGER_RECONSTRUCTION', captureEvidence: evidence(),
    receiptId: 'RECEIPT-1', brokerSnapshot: snapshot(),
    principalConfirmation: 'RECONCILE_BROKER_LEDGER_OPEN' };
  const first = await rpc('RECOVERY-OWNER', 'laneV2RecoverOpen', args);
  assert.equal(first.status, 200);
  assert.equal(first.result.stage, 'OPEN_SHORT');
  assert.equal(first.result.positionSide, 'SHORT');
  assert.equal(first.result.armed, false);
  assert.equal(first.result.entryIdentity.identity.transactionActivityId, 'TRANSACTION-1');
  assert.equal(first.result.entryIdentity.evidenceOrigin, 'BROKER_LEDGER_RECONSTRUCTION');
  const history = await rpc('RECOVERY-OWNER', 'laneV2History', { limit: 50 });
  const row = history.result.events.find((event) => event.event_type === 'OPEN_FILLED');
  const detail = JSON.parse(row.detail_json);
  assert.equal(detail.instruction, 'SELL_SHORT');
  assert.equal(detail.quantity, 1);
  assert.equal(detail.priceUsdPerShare, 761.98);
  assert.equal(detail.feeCents, -2);
  assert.equal(detail.transactionActivityId, 'TRANSACTION-1');
  assert.equal(detail.evidenceOrigin, 'BROKER_LEDGER_RECONSTRUCTION');

  const repeated = await rpc('RECOVERY-OWNER', 'laneV2RecoverOpen', args);
  assert.equal(repeated.result.changed, false);
  const afterRepeat = await rpc('RECOVERY-OWNER', 'laneV2History', { limit: 50 });
  assert.equal(afterRepeat.result.events.filter((event) => event.event_type === 'OPEN_FILLED').length, 1);

  const conflictArgs = structuredClone(args);
  conflictArgs.identity.transactionActivityId = 'TRANSACTION-DIFFERENT';
  const conflict = await rpc('RECOVERY-OWNER', 'laneV2RecoverOpen', conflictArgs);
  assert.equal(conflict.status, 422);
  assert.match(conflict.error, /RECOVERY_IDENTITY_CONFLICT/u);
  const fault = await rpc('RECOVERY-OWNER', 'laneV2Status');
  assert.equal(fault.result.stage, 'FAULT');
  assert.equal(fault.result.armed, false);
  assert.equal(fault.result.positionSide, 'SHORT');
});

test('normal OPEN_FILLED requires the same strict identity and complete wire capture as recovery', async () => {
  await faultedShortDispatch('NORMAL-OPEN-OWNER', { fault: false });
  const args = { signal: 'SHORT', unit: unit(), identity: identity(),
    evidenceOrigin: 'SCHWAB_WIRE_CAPTURE', captureEvidence: wireEvidence(),
    receiptId: 'RECEIPT-WIRE-1' };
  const incomplete = structuredClone(args);
  delete incomplete.captureEvidence.transaction;
  const refused = await rpc('NORMAL-OPEN-OWNER', 'laneV2RecordOpen', incomplete);
  assert.equal(refused.status, 422);
  assert.match(refused.error, /LANE_1_FILL_CAPTURE_INCOMPLETE/u);

  const recorded = await rpc('NORMAL-OPEN-OWNER', 'laneV2RecordOpen', args);
  assert.equal(recorded.status, 200, JSON.stringify(recorded));
  assert.equal(recorded.result.stage, 'OPEN_SHORT');
  assert.equal(recorded.result.positionSide, 'SHORT');
  assert.equal(recorded.result.entryIdentity.identity.instruction, 'SELL_SHORT');
  assert.equal(recorded.result.entryIdentity.evidenceOrigin, 'SCHWAB_WIRE_CAPTURE');
  const history = await rpc('NORMAL-OPEN-OWNER', 'laneV2History', { limit: 50 });
  const row = history.result.events.find((event) => event.event_type === 'OPEN_FILLED');
  const detail = JSON.parse(row.detail_json);
  assert.equal(detail.instruction, 'SELL_SHORT');
  assert.equal(detail.quantity, 1);
  assert.equal(detail.priceUsdPerShare, 761.98);
  assert.equal(detail.feeCents, -2);
  assert.equal(detail.transactionActivityId, 'TRANSACTION-1');
  assert.equal(detail.evidenceOrigin, 'SCHWAB_WIRE_CAPTURE');
  assert.deepEqual(detail.captureIds.sort(), [
    'WIRE-ACCEPTANCE', 'WIRE-ORDER', 'WIRE-TRANSACTION',
  ].sort());
});

test('arm-existing preserves recovered SHORT and the coordinator admits only BUY_TO_COVER', async () => {
  const timing = await faultedShortDispatch('ARM-EXISTING-OWNER');
  const recovered = await rpc('ARM-EXISTING-OWNER', 'laneV2RecoverOpen', {
    signal: 'SHORT', unit: unit(), identity: identity(), evidenceOrigin: 'BROKER_LEDGER_RECONSTRUCTION',
    captureEvidence: evidence(), receiptId: 'RECEIPT-1', brokerSnapshot: snapshot(),
    principalConfirmation: 'RECONCILE_BROKER_LEDGER_OPEN' });
  assert.equal(recovered.result.stage, 'OPEN_SHORT');
  const armedAt = new Date(Date.now()).toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const armed = await rpc('ARM-EXISTING-OWNER', 'laneV2PrincipalArmExisting', {
    reason: 'PRINCIPAL_DASHBOARD_ARM_EXISTING', principalConfirmation: 'ARM_EXISTING_SHORT_1_SPY',
    armedAt, expiresAt, brokerSnapshot: snapshot() });
  assert.equal(armed.status, 200);
  assert.equal(armed.result.stage, 'OPEN_SHORT');
  assert.equal(armed.result.positionSide, 'SHORT');
  assert.equal(armed.result.latestUnit.openingFillId, 'EXECUTION-1');
  assert.equal(armed.result.entryIdentity.identity.instruction, 'SELL_SHORT');

  for (const [signal, brokerInstruction] of [
    ['LONG', 'BUY'], ['SHORT', 'SELL_SHORT'], ['EXIT', 'SELL'],
  ]) {
    const refused = await rpc('ARM-EXISTING-OWNER', 'laneV2Claim', {
      signal, seal: { ...timing.seal, brokerInstruction } });
    assert.equal(refused.result.claimed, false, brokerInstruction);
    assert.equal(refused.result.refusal, 'LANE_1_CLAIM_INSTRUCTION_STATE_REFUSED');
  }
  const cover = await rpc('ARM-EXISTING-OWNER', 'laneV2Claim', {
    signal: 'EXIT', seal: { ...timing.seal, brokerInstruction: 'BUY_TO_COVER' } });
  assert.equal(cover.result.claimed, true);
  assert.equal(cover.result.state.stage, 'EXIT_SENDING');
  assert.equal(cover.result.state.positionSide, 'SHORT');
});
