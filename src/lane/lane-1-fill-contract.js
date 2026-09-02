export const LANE_1_FILL_IDENTITY_FIELDS = Object.freeze([
  'accountHash', 'brokerOrderId', 'clientOrderId', 'executionActivityId', 'instruction',
  'occurredAt', 'priceUsdPerShare', 'quantityShares', 'symbol',
  'transactionActivityId', 'tvBodyBindingSha256',
]);
export const LANE_1_FILL_POLL_OFFSETS_MS = Object.freeze(
  [0, 2, 5, 10, 20, 40, 60, 90, 120].map((seconds) => seconds * 1_000),
);

function nonempty(value) { return typeof value === 'string' && value.length > 0; }

export function lane1NextFillPollAt({ startedAt, deadlineAt, now = Date.now() }) {
  const startedMs = Date.parse(startedAt ?? '');
  const deadlineMs = Date.parse(deadlineAt ?? '');
  if (!Number.isFinite(startedMs) || !Number.isFinite(deadlineMs)
    || deadlineMs - startedMs !== 120_000 || !Number.isFinite(now)) {
    throw new Error('LANE_1_FILL_POLL_WINDOW_INVALID');
  }
  const nextOffset = LANE_1_FILL_POLL_OFFSETS_MS.find((offset) => startedMs + offset > now);
  return Math.min(deadlineMs, startedMs + (nextOffset ?? 120_000));
}

export function lane1FillIdentity({ fill, tvBodyBindingSha256 }) {
  const identity = {
    accountHash: fill?.accountHash ?? null,
    brokerOrderId: fill?.brokerOrderId ?? null,
    clientOrderId: fill?.clientOrderId ?? null,
    executionActivityId: fill?.executionActivityId ?? fill?.fillId ?? null,
    instruction: fill?.side ?? null,
    occurredAt: fill?.brokerOccurredAt ?? null,
    priceUsdPerShare: fill?.executionPriceUsdPerShare ?? null,
    quantityShares: fill?.quantityShares ?? null,
    symbol: fill?.symbol ?? null,
    transactionActivityId: fill?.transactionActivityId ?? null,
    tvBodyBindingSha256: tvBodyBindingSha256 ?? null,
  };
  assertLane1FillIdentity(identity);
  return Object.freeze(identity);
}

export function assertLane1FillIdentity(identity) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)
    || JSON.stringify(Object.keys(identity).sort())
      !== JSON.stringify([...LANE_1_FILL_IDENTITY_FIELDS].sort())) {
    throw new Error('LANE_1_FILL_IDENTITY_SHAPE_INVALID');
  }
  for (const field of ['accountHash', 'brokerOrderId', 'clientOrderId',
    'executionActivityId', 'instruction', 'occurredAt', 'symbol',
    'transactionActivityId', 'tvBodyBindingSha256']) {
    if (!nonempty(identity[field])) throw new Error(`LANE_1_FILL_IDENTITY_${field.toUpperCase()}_MISSING`);
  }
  if (!['BUY', 'SELL', 'SELL_SHORT', 'BUY_TO_COVER'].includes(identity.instruction)
    || identity.symbol !== 'SPY' || identity.quantityShares !== 1
    || !(Number(identity.priceUsdPerShare) > 0)
    || !Number.isFinite(Date.parse(identity.occurredAt))
    || !/^[a-f0-9]{64}$/u.test(identity.tvBodyBindingSha256)) {
    throw new Error('LANE_1_FILL_IDENTITY_VALUE_INVALID');
  }
  return identity;
}

export function assertLane1FillEvidence(evidence, origin, identity = null) {
  if (!['SCHWAB_WIRE_CAPTURE', 'BROKER_LEDGER_RECONSTRUCTION'].includes(origin)) {
    throw new Error('LANE_1_FILL_EVIDENCE_ORIGIN_INVALID');
  }
  const captures = origin === 'SCHWAB_WIRE_CAPTURE'
    ? [evidence?.acceptance, evidence?.order, evidence?.transaction]
    : [evidence?.order, evidence?.transaction];
  if (captures.some((capture) => capture?.complete !== true
    || capture?.schema !== 'LANE_1_FILL_RAW_RESPONSE_V1'
    || !nonempty(capture.bodyKey) || !/^[a-f0-9]{64}$/u.test(capture.originalSha256 ?? ''))) {
    throw new Error('LANE_1_FILL_CAPTURE_INCOMPLETE');
  }
  if (new Set(captures.map((capture) => capture.captureId)).size !== captures.length) {
    throw new Error('LANE_1_FILL_CAPTURE_IDENTITY_DUPLICATE');
  }
  if (identity) {
    assertLane1FillIdentity(identity);
    for (const capture of captures) {
      if (capture.clientOrderId !== identity.clientOrderId
        || capture.instruction !== identity.instruction
        || !validTime(capture.receivedAt)) {
        throw new Error('LANE_1_FILL_CAPTURE_BINDING_MISMATCH');
      }
    }
    if (evidence.order.brokerOrderId !== identity.brokerOrderId
      || evidence.transaction.brokerOrderId !== identity.brokerOrderId) {
      throw new Error('LANE_1_FILL_CAPTURE_ORDER_MISMATCH');
    }
    if (origin === 'SCHWAB_WIRE_CAPTURE'
      && (evidence.acceptance.source !== 'SCHWAB_ORDER_ACCEPTANCE_RESPONSE'
        || evidence.order.source !== 'SCHWAB_ORDER_RESPONSE'
        || evidence.transaction.source !== 'SCHWAB_TRANSACTION_RESPONSE')) {
      throw new Error('LANE_1_FILL_CAPTURE_SOURCE_MISMATCH');
    }
    if (origin === 'BROKER_LEDGER_RECONSTRUCTION'
      && captures.some((capture) => capture.source !== 'BROKER_LEDGER_RECONSTRUCTION')) {
      throw new Error('LANE_1_FILL_CAPTURE_SOURCE_MISMATCH');
    }
  }
  return evidence;
}

function validTime(value) { return Number.isFinite(Date.parse(value ?? '')); }

export function sameLane1FillIdentity(left, right) {
  assertLane1FillIdentity(left); assertLane1FillIdentity(right);
  return LANE_1_FILL_IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}
