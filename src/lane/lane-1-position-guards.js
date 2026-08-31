// Internal broker-state guards only. This module does not interpret TV messages.
const SIDES = Object.freeze(['FLAT', 'LONG', 'SHORT']);
const TRANSITIONS = Object.freeze({
  BUY: Object.freeze({ from: 'FLAT', to: 'LONG', refusal: 'LANE_1_BUY_REQUIRES_FLAT' }),
  SELL: Object.freeze({ from: 'LONG', to: 'FLAT', refusal: 'LANE_1_SELL_REQUIRES_LONG' }),
  SELL_SHORT: Object.freeze({ from: 'FLAT', to: 'SHORT', refusal: 'LANE_1_SELL_SHORT_REQUIRES_FLAT' }),
  BUY_TO_COVER: Object.freeze({ from: 'SHORT', to: 'FLAT', refusal: 'LANE_1_BUY_TO_COVER_REQUIRES_SHORT' }),
});

function drift(reason) {
  throw new Error(`LANE_1_POSITION_STATE_DRIFT:${reason}`);
}

export function readLane1SpyPosition(packet) {
  const positions = packet?.securitiesAccount?.positions;
  if (!Array.isArray(positions)) drift('BROKER_POSITION_UNKNOWN:positions');
  let longQuantity = 0;
  let shortQuantity = 0;
  for (const row of positions) {
    const symbol = row?.instrument?.symbol;
    // An unidentified row cannot be assumed not to be SPY.
    if (typeof symbol !== 'string' || !symbol.trim()) drift('BROKER_POSITION_UNKNOWN:symbol');
    if (symbol.trim().toUpperCase() !== 'SPY') continue;
    for (const field of ['longQuantity', 'shortQuantity']) {
      if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0) {
        drift(`BROKER_POSITION_UNKNOWN:${field}`);
      }
    }
    longQuantity += row.longQuantity;
    shortQuantity += row.shortQuantity;
  }
  // Gross exposure matters: +2/-1 is not the permitted one-share long.
  if (!Number.isInteger(longQuantity) || !Number.isInteger(shortQuantity)
    || longQuantity + shortQuantity > 1) throw new Error('LANE_1_POSITION_LIMIT_FAULT');
  const netQuantity = longQuantity - shortQuantity;
  return { symbol: 'SPY', longQuantity, shortQuantity, netQuantity,
    positionSide: netQuantity === 1 ? 'LONG' : netQuantity === -1 ? 'SHORT' : 'FLAT' };
}

export function assertLane1PositionAgreement(durableSide, position) {
  if (!SIDES.includes(position?.positionSide) || position?.symbol !== 'SPY') {
    drift('BROKER_POSITION_UNKNOWN');
  }
  const expectedLong = position.positionSide === 'LONG' ? 1 : 0;
  const expectedShort = position.positionSide === 'SHORT' ? 1 : 0;
  if (position.longQuantity !== expectedLong || position.shortQuantity !== expectedShort
    || position.netQuantity !== expectedLong - expectedShort) drift('BROKER_POSITION_UNKNOWN:quantities');
  if (!SIDES.includes(durableSide)) drift('COORDINATOR_POSITION_UNKNOWN');
  if (durableSide !== position.positionSide) drift('COORDINATOR_BROKER_DISAGREEMENT');
}

export function assertLane1InstructionState({ instruction, positionSide, quantity }) {
  if (!SIDES.includes(positionSide)) drift('POSITION_UNKNOWN');
  if (quantity !== 1) throw new Error('LANE_1_QUANTITY_MUST_BE_ONE');
  if (!Object.hasOwn(TRANSITIONS, instruction)) throw new Error('LANE_1_INSTRUCTION_UNKNOWN');
  const transition = TRANSITIONS[instruction];
  if (positionSide !== transition.from) throw new Error(transition.refusal);
  return transition.to;
}

const TERMINAL = Object.freeze(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED']);
const PENDING = Object.freeze(['AWAITING_PARENT_ORDER', 'AWAITING_CONDITION',
  'AWAITING_STOP_CONDITION', 'AWAITING_MANUAL_REVIEW', 'ACCEPTED', 'AWAITING_UR_OUT',
  'PENDING_ACTIVATION', 'QUEUED', 'WORKING', 'PENDING_CANCEL', 'PENDING_REPLACE',
  'PENDING_ACKNOWLEDGEMENT', 'PENDING_RECALL', 'NEW', 'PARTIALLY_FILLED']);

// A terminal parent does not make its children terminal. Inspect every leg and
// child; malformed/unknown orders are not silently treated as an empty list.
export function lane1OrderState(orders) {
  if (!Array.isArray(orders)) throw new Error('LANE_1_WORKING_ORDER_STATE_UNKNOWN');
  if (orders.length >= 3000) throw new Error('LANE_1_ORDER_READ_LIMIT_REACHED');
  const rows = [];
  function visit(order, depth = 0) {
    if (depth > 16 || !order || typeof order !== 'object'
      || ![...TERMINAL, ...PENDING].includes(order.status)) {
      throw new Error('LANE_1_WORKING_ORDER_STATE_UNKNOWN');
    }
    const children = order.childOrderStrategies;
    if (children !== undefined && !Array.isArray(children)) {
      throw new Error('LANE_1_WORKING_ORDER_STATE_UNKNOWN');
    }
    const legs = order.orderLegCollection;
    // OCO wrappers may have children and no legs of their own.
    if ((!Array.isArray(legs) || legs.length === 0)
      && !(order.orderStrategyType === 'OCO' && children?.length > 0 && legs === undefined)) {
      throw new Error('LANE_1_WORKING_ORDER_STATE_UNKNOWN');
    }
    let spy = false;
    for (const leg of legs ?? []) {
      const symbol = leg?.instrument?.symbol;
      if (typeof symbol !== 'string' || !symbol.trim()) throw new Error('LANE_1_WORKING_ORDER_STATE_UNKNOWN');
      if (symbol.trim().toUpperCase() === 'SPY'
        || leg.instrument.underlyingSymbol === 'SPY') spy = true;
    }
    if (spy) {
      if (!TERMINAL.includes(order.status)) throw new Error('LANE_1_WORKING_ORDER_PRESENT');
      if (!['string', 'number'].includes(typeof order.orderId) || !String(order.orderId).trim()) {
        throw new Error('LANE_1_WORKING_ORDER_STATE_UNKNOWN');
      }
      // Retain terminal identities too: a newly filled external round trip may
      // leave position quantity unchanged but must still invalidate the read.
      rows.push({ orderId: String(order.orderId), status: order.status });
    }
    for (const child of children ?? []) visit(child, depth + 1);
  }
  for (const order of orders) visit(order);
  return rows.sort((a, b) => a.orderId.localeCompare(b.orderId) || a.status.localeCompare(b.status));
}

export function assertLane1SendSnapshot(snapshot) {
  assertLane1PositionAgreement(snapshot?.positionSide, snapshot);
  if (typeof snapshot.accountHash !== 'string' || !snapshot.accountHash
    || snapshot.orderCheckBound !== 'NO_WORKING_SPY_ORDER_IN_60_DAY_QUERY'
    || typeof snapshot.orderStateSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(snapshot.orderStateSha256)
    || !Number.isFinite(Date.parse(snapshot.readStartedAt))
    || !Number.isFinite(Date.parse(snapshot.acquiredAt))
    || !Number.isFinite(Date.parse(snapshot.ordersFrom)) || !Number.isFinite(Date.parse(snapshot.ordersTo))) {
    throw new Error('LANE_1_SEND_SNAPSHOT_REQUIRED');
  }
}

export function assertLane1SnapshotUnchanged(expected, current, now = Date.now()) {
  assertLane1SendSnapshot(expected);
  assertLane1SendSnapshot(current);
  if (expected.accountHash !== current.accountHash) drift('ACCOUNT_CHANGED');
  if (expected.positionSide !== current.positionSide
    || expected.longQuantity !== current.longQuantity || expected.shortQuantity !== current.shortQuantity) {
    drift('PRE_DISPATCH_POSITION_CHANGED');
  }
  if (expected.ordersFrom !== current.ordersFrom || expected.orderStateSha256 !== current.orderStateSha256) {
    throw new Error('LANE_1_PRE_DISPATCH_ORDER_STATE_CHANGED');
  }
  const age = now - Date.parse(current.readStartedAt);
  const end = Date.parse(current.acquiredAt);
  if (!Number.isFinite(now) || age < 0 || age > 5000 || end > now
    || end < Date.parse(current.readStartedAt)) throw new Error('LANE_1_PRE_DISPATCH_READ_STALE');
}

export function assertLane1DispatchCoordinator(state, { instruction, clientOrderId, positionSide }, now = Date.now()) {
  if (state?.armed !== true) throw new Error('LANE_1_DISARMED');
  if (!Number.isFinite(Date.parse(state.expiresAt)) || Date.parse(state.expiresAt) <= now) {
    throw new Error('LANE_1_ARM_WINDOW_EXPIRED');
  }
  if (!SIDES.includes(state.positionSide) || state.positionSide !== positionSide) {
    drift('PRE_DISPATCH_COORDINATOR_CHANGED');
  }
  assertLane1InstructionState({ instruction, positionSide, quantity: 1 });
  const signal = instruction === 'BUY' ? 'LONG' : instruction === 'SELL_SHORT' ? 'SHORT' : 'EXIT';
  const pending = signal === 'EXIT' ? state.exit : state.open;
  if (typeof clientOrderId !== 'string' || !clientOrderId || state.stage !== `${signal}_SENDING`
    || pending?.seal?.clientOrderId !== clientOrderId
    || pending?.seal?.brokerInstruction !== instruction || pending?.brokerOrderId) {
    throw new Error('LANE_1_DISPATCH_CLAIM_CHANGED');
  }
}
