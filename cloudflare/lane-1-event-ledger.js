const SOURCE_EVENT_TYPES = Object.freeze([
  'LANE_1_TV_INGRESS',
  'LANE_1_TV_SIGNAL_REFUSED',
  'LANE_1_ORDER_PREVIEW',
  'LANE_1_ORDER_PREVIEW_REFUSED',
  'LANE_1_FILL_RECEIPT',
]);

const LANE_1_INSTRUCTIONS = Object.freeze(['BUY', 'SELL', 'SELL_SHORT', 'BUY_TO_COVER']);
const ALERT_CONFIRMATIONS = Object.freeze(Object.fromEntries(LANE_1_INSTRUCTIONS.map((instruction) => [
  instruction, Object.freeze({ status: 'CONFIRMED', source: 'PRINCIPAL_CONFIRMED · SPY 5m' }),
])));
const PREVIEW_ATTESTATIONS = Object.freeze({
  'ba07b4da-db6f-4043-909b-a920dae80462': Object.freeze({
    outcome: 'REFUSED_NO_POSITION', source: 'PRINCIPAL_CONFIRMED_DECRYPT_REPORT',
  }),
  'e96f65da-dc0f-4217-96db-ffed666bc2d1': Object.freeze({
    outcome: 'REFUSED_NO_POSITION', source: 'PRINCIPAL_CONFIRMED_DECRYPT_REPORT',
  }),
});

function parseDetail(value) {
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function ownScalar(object, key) {
  if (!object || !Object.prototype.hasOwnProperty.call(object, key)) return null;
  const value = object[key];
  return value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
}

function newYorkDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function exactFillInstructions(events) {
  const result = new Map();
  for (const event of events) {
    if (event.event !== 'FILL' || event.qualifiedStage0Fill !== true
      || !LANE_1_INSTRUCTIONS.includes(event.instruction) || !event.fillId) continue;
    result.set(event.instruction, { status: 'FILLED', fillId: event.fillId,
      source: event.sourceEventType });
  }
  return result;
}

export function buildLane1BotSummary(events, coordinatorState, {
  now = Date.now(), positionProjection = null,
} = {}) {
  const historyAvailable = Array.isArray(events);
  const stateAvailable = coordinatorState && typeof coordinatorState === 'object';
  const rows = historyAvailable ? events : [];
  const today = newYorkDate(now);
  const fillEvents = rows.filter((event) => event.event === 'FILL'
    && event.qualifiedStage0Fill === true);
  const todayFills = fillEvents.filter((event) => newYorkDate(event.timestamp) === today);
  const exits = rows.filter((event) => event.sourceEventType === 'LANE_1_FILL_RECEIPT'
    && event.fillType === 'EXIT_FILLED' && event.qualifiedStage0Fill === true);
  const todayExits = exits.filter((event) => newYorkDate(event.timestamp) === today);
  const exactFills = exactFillInstructions(rows);
  const matrix = {};
  for (const instruction of LANE_1_INSTRUCTIONS) {
    const preview = [...rows].reverse().find((event) => event.instruction === instruction
      && ['LANE_1_ORDER_PREVIEW', 'LANE_1_ORDER_PREVIEW_REFUSED'].includes(event.sourceEventType));
    const attestation = preview ? PREVIEW_ATTESTATIONS[preview.recordId] : null;
    const fill = exactFills.get(instruction);
    const recovered = [...rows].reverse().find((event) => event.event === 'FILL'
      && event.instruction === instruction
      && event.evidenceOrigin === 'BROKER_LEDGER_RECONSTRUCTION');
    matrix[instruction] = {
      alert: ALERT_CONFIRMATIONS[instruction],
      preview: !preview ? { status: 'NOT_MEASURED', reason: 'NO_PREVIEW_RECEIPT' }
        : preview.sourceEventType === 'LANE_1_ORDER_PREVIEW'
          ? { status: 'COMPLETE · CLEAR', receiptId: preview.recordId, source: 'D1_OPERATIONAL_AUDIT' }
          : { status: `COMPLETE · ${attestation?.outcome ?? 'REFUSED'}`,
            reason: preview.reasonCode, receiptId: preview.recordId,
            source: attestation?.source ?? 'D1_OPERATIONAL_AUDIT' },
      fill: fill ?? (recovered ? { status: 'RECOVERED · NOT_QUALIFIED',
        fillId: recovered.fillId, source: 'BROKER_LEDGER_RECONSTRUCTION' }
        : fillEvents.length === 0
        ? { status: '0 · NEVER_ARMED', source: 'ACCOUNT_COORDINATOR_HISTORY' }
        : { status: 'NOT_MEASURED', reason: 'EXACT_INSTRUCTION_NOT_RECORDED_IN_HISTORY' }),
    };
  }

  const projectionStatus = positionProjection?.status ?? 'UNVERIFIED';
  const side = projectionStatus === 'AGREE' ? positionProjection.positionSide : null;
  const unit = coordinatorState?.latestUnit ?? null;
  const coordinatorSide = positionProjection?.coordinator?.positionSide
    ?? coordinatorState?.positionSide ?? 'UNKNOWN';
  const brokerSide = positionProjection?.broker?.positionSide ?? 'UNKNOWN';
  const position = projectionStatus === 'POSITION_DRIFT'
    ? { value: 'POSITION_DRIFT', coordinatorPositionSide: coordinatorSide,
      brokerPositionSide: brokerSide, coordinatorUpdatedAt: positionProjection.coordinator?.updatedAt,
      brokerAcquiredAt: positionProjection.broker?.acquiredAt, source: 'BROKER_FIRST_PROJECTION' }
    : projectionStatus === 'UNVERIFIED'
      ? { value: positionProjection?.positionSide === 'UNKNOWN' ? 'NOT_MEASURED'
        : positionProjection?.positionSide ?? 'NOT_MEASURED',
        verified: false, reason: positionProjection?.brokerRead?.error
          ?? 'BROKER_SNAPSHOT_UNAVAILABLE', source: 'ACCOUNT_COORDINATOR_UNVERIFIED' }
      : !stateAvailable ? { value: 'NOT_MEASURED', reason: 'COORDINATOR_STATE_UNAVAILABLE' }
        : side === 'FLAT' ? { value: 'FLAT', source: 'BROKER_FIRST_PROJECTION' }
      : ['LONG', 'SHORT'].includes(side) && unit?.symbol === 'SPY' && unit?.quantity === 1
        && unit.positionSide === side
        ? { value: `${side} 1 SPY`, source: 'BROKER_FIRST_PROJECTION + ACCOUNT_COORDINATOR_LATEST_UNIT' }
        : { value: 'NOT_MEASURED', reason: 'OPEN_POSITION_FILL_IDENTITY_INCOMPLETE' };

  const openFill = side === 'FLAT' || side === null ? null : [...rows].reverse().find((event) =>
    event.sourceEventType === 'OPEN_FILLED' && event.signal === side
      && (!unit?.openingFillId || event.fillId === unit.openingFillId));
  const proposal = unit?.events?.find((event) => event?.eventType === 'PROPOSAL_SEALED'
    && ['BUY', 'SELL_SHORT'].includes(event.side));
  const sourceSignal = proposal?.proposal?.tvBodyBindingSha256
    ? [...rows].reverse().find((event) => event.sourceEventType === 'LANE_1_TV_INGRESS'
      && event.bindingSha256 === proposal.proposal.tvBodyBindingSha256) : null;
  const lastSignal = [...rows].reverse().find((event) => ['LANE_1_TV_INGRESS',
    'LANE_1_TV_SIGNAL_REFUSED'].includes(event.sourceEventType));
  const lastSignalPreview = lastSignal ? [...rows].reverse().find((event) =>
    event.sourceIngressId === lastSignal.recordId
      && ['LANE_1_ORDER_PREVIEW', 'LANE_1_ORDER_PREVIEW_REFUSED']
        .includes(event.sourceEventType)) : null;
  const lastSignalPreviewAttestation = lastSignalPreview
    ? PREVIEW_ATTESTATIONS[lastSignalPreview.recordId] : null;
  const realizedComplete = todayExits.length > 0
    && todayExits.every((event) => Number.isSafeInteger(event.realizedPnlCents));
  const realizedCents = realizedComplete
    ? todayExits.reduce((sum, event) => sum + event.realizedPnlCents, 0) : null;
  const faultCode = coordinatorState?.fault?.faultCode ?? null;
  const acceptedContractEvent = [...rows].reverse().find((event) =>
    LANE_1_INSTRUCTIONS.includes(event.instruction)
      && typeof event.rawTicker === 'string' && Number.isSafeInteger(event.quantity));
  const configuredTicker = typeof unit?.symbol === 'string' ? unit.symbol
    : acceptedContractEvent?.rawTicker ?? null;
  const configuredQuantity = Number.isSafeInteger(unit?.quantity) ? unit.quantity
    : acceptedContractEvent?.quantity ?? null;
  const openFillEvent = ['LONG', 'SHORT'].includes(side)
    ? unit?.events?.find((event) => event?.eventType === 'EQUITY_FILL'
      && event.fillId === unit.openingFillId) ?? null : null;
  const openPosition = ['LONG', 'SHORT'].includes(side)
    && configuredTicker && Number.isSafeInteger(configuredQuantity)
    && configuredQuantity > 0 && Number(unit?.openingPriceUsdPerShare) > 0
    && Number.isSafeInteger(unit?.openingFeeCents)
    && openFillEvent?.symbol === configuredTicker
    && openFillEvent?.quantityShares === configuredQuantity
      ? { side, ticker: configuredTicker, quantityShares: configuredQuantity,
        openingPriceUsdPerShare: Number(unit.openingPriceUsdPerShare),
        openingFeeCents: unit.openingFeeCents, openingFillId: unit.openingFillId,
        source: 'ACCOUNT_COORDINATOR_LATEST_UNIT' }
      : null;

  return {
    contract: 'LANE_1 · SPY 1 SHARE',
    instrument: configuredTicker && Number.isSafeInteger(configuredQuantity)
      ? { broker: 'Schwab', ticker: configuredTicker, quantityShares: configuredQuantity,
        source: unit ? 'ACCOUNT_COORDINATOR_LATEST_UNIT' : 'ACCEPTED_LANE_1_INGRESS' }
      : { status: 'NOT_MEASURED', reason: 'LANE_CONTRACT_SOURCE_UNAVAILABLE' },
    arm: stateAvailable
      ? { value: coordinatorState.armed === true ? 'ON' : 'OFF', stage: coordinatorState.stage,
        source: 'ACCOUNT_COORDINATOR' }
      : { value: 'NOT_MEASURED', reason: 'COORDINATOR_STATE_UNAVAILABLE' },
    position,
    brokerReconciliation: positionProjection ?? { status: 'UNVERIFIED',
      brokerRead: { ok: false, error: 'BROKER_SNAPSHOT_UNAVAILABLE' } },
    entered: side === 'FLAT' || side === null
      ? { value: 'NOT_MEASURED', reason: 'NO_OPEN_BOT_POSITION' }
      : openFill ? { value: openFill.timestamp, source: 'ACCOUNT_COORDINATOR_HISTORY' }
        : { value: 'NOT_MEASURED', reason: 'OPEN_FILL_TIMESTAMP_NOT_RECORDED' },
    fromAlert: side === 'FLAT' || side === null
      ? { value: 'NOT_MEASURED', reason: 'NO_OPEN_BOT_POSITION' }
      : sourceSignal ? { value: sourceSignal.timestamp, instruction: sourceSignal.instruction,
        ingressId: sourceSignal.recordId, source: 'D1_OPERATIONAL_AUDIT' }
        : { value: 'NOT_MEASURED', reason: 'OPEN_FILL_TO_INGRESS_BINDING_NOT_AVAILABLE' },
    pnl: {
      realizedToday: realizedComplete
        ? { valueCents: realizedCents, source: 'LANE_1_FILL_RECEIPT' }
        : { status: 'NOT_MEASURED', reason: exits.length === 0
          ? 'NO_CLOSED_BOT_ROUND_TRIPS' : todayExits.length === 0
            ? 'NO_CLOSED_BOT_ROUND_TRIPS_TODAY' : 'REALIZED_PNL_FIELD_MISSING' },
      open: { status: 'NOT_MEASURED', reason: 'NO_LIVE_BROKER_MARK_SOURCE_IN_THIS_PACKET' },
      aggregate: { status: 'NOT_MEASURED', reason: 'PHASE_2_PAIRING_NOT_IMPLEMENTED' },
    },
    openPosition,
    fills: { today: todayFills.length, total: fillEvents.length,
      provenInstructions: exactFills.size, targetInstructions: LANE_1_INSTRUCTIONS.length,
      source: 'LANE_1_FILL_RECEIPT' },
    matrix,
    blocking: projectionStatus === 'POSITION_DRIFT' ? 'POSITION_DRIFT'
      : projectionStatus === 'UNVERIFIED' ? 'BROKER_POSITION_UNVERIFIED'
        : !stateAvailable ? 'COORDINATOR_STATE_UNAVAILABLE'
          : faultCode ?? (coordinatorState.armed === true ? 'none' : 'ARM_OFF · INTENDED'),
    lastSignal: lastSignal ? {
      timestamp: lastSignal.timestamp,
      instruction: lastSignal.instruction ?? lastSignal.rawSide ?? null,
      outcome: lastSignal.sourceEventType === 'LANE_1_TV_SIGNAL_REFUSED'
        ? `REFUSED · ${lastSignal.reasonCode}`
        : lastSignalPreview?.sourceEventType === 'LANE_1_ORDER_PREVIEW'
          ? 'PREVIEW · CLEAR'
          : lastSignalPreview?.sourceEventType === 'LANE_1_ORDER_PREVIEW_REFUSED'
            ? `PREVIEW · ${lastSignalPreviewAttestation?.outcome ?? 'REFUSED'}`
            : lastSignal.instruction ? 'CONTRACT_ACCEPTED · DISPATCH_OUTCOME_NOT_PERSISTED'
              : 'CONTRACT_REFUSED',
      recordId: lastSignal.recordId,
      previewReceiptId: lastSignalPreview?.recordId ?? null,
    } : { status: 'NOT_MEASURED', reason: 'NO_SIGNAL_EVENTS' },
  };
}

function projectCoordinatorHistoryRow(row) {
  const detail = parseDetail(row?.detail_json);
  const sequence = Number(row?.sequence);
  const recordId = Number.isSafeInteger(sequence) ? `do-v2-${sequence}` : null;
  const base = {
    timestamp: row?.created_at ?? null,
    sourceEventType: row?.event_type ?? null,
    recordId,
    recordHref: recordId ? `#lane1-event-${recordId}` : null,
    sourceIngressId: null,
    rawSide: null,
    instruction: null,
    quantity: null,
    reasonCode: null,
    signal: ownScalar(detail, 'signal'),
    fillId: ownScalar(detail, 'fillId'),
    brokerOrderId: ownScalar(detail, 'brokerOrderId'),
    realizedPnlCents: ownScalar(detail, 'realizedPnlCents'),
  };
  if (row?.event_type === 'ORDER_ACCEPTED') {
    return { ...base, event: 'ORDER', instruction: ownScalar(detail, 'instruction'),
      quantity: ownScalar(detail, 'quantity'), outcome: 'ACCEPTED' };
  }
  if (row?.event_type === 'OPEN_FILLED' || row?.event_type === 'EXIT_FILLED') {
    return { ...base, event: 'FILL', instruction: ownScalar(detail, 'instruction'),
      quantity: ownScalar(detail, 'quantity'), outcome: 'FILLED',
      evidenceOrigin: ownScalar(detail, 'evidenceOrigin'),
      qualifiedStage0Fill: ownScalar(detail, 'qualifiedStage0Fill') === true };
  }
  if (row?.event_type === 'FAULT') {
    return { ...base, event: 'FAULT', outcome: 'FAULT · AUTO_DISARMED',
      reasonCode: ownScalar(detail, 'faultCode') ?? 'LANE_1_REFUSAL_REASON_MISSING' };
  }
  if (row?.event_type === 'AUTO_DISARMED') {
    return { ...base, event: 'DISARMED', outcome: 'AUTO_DISARMED',
      reasonCode: ownScalar(detail, 'reason') ?? 'LANE_1_REFUSAL_REASON_MISSING' };
  }
  return null;
}

export function projectLane1LedgerRow(row) {
  const detail = parseDetail(row?.detail_json);
  const rawMessage = detail.rawMessage && typeof detail.rawMessage === 'object'
    && !Array.isArray(detail.rawMessage) ? detail.rawMessage : null;
  const replayBody = detail.replayBody && typeof detail.replayBody === 'object'
    && !Array.isArray(detail.replayBody) ? detail.replayBody : null;
  const recordId = typeof row?.id === 'string' ? row.id : null;
  const base = {
    timestamp: row?.created_at ?? null,
    sourceEventType: row?.event_type ?? null,
    recordId,
    recordHref: recordId ? `#lane1-event-${recordId}` : null,
    sourceIngressId: typeof detail.sourceIngressId === 'string' ? detail.sourceIngressId : null,
    rawSide: ownScalar(rawMessage, 'side') ?? ownScalar(replayBody, 'side'),
    rawTicker: ownScalar(rawMessage, 'ticker') ?? ownScalar(replayBody, 'ticker'),
    instruction: null,
    quantity: ownScalar(rawMessage, 'qty') ?? ownScalar(replayBody, 'qty')
      ?? ownScalar(detail, 'quantity'),
    reasonCode: null,
    outcome: null,
    bindingSha256: ownScalar(detail, 'tvBodyBindingSha256'),
  };
  if (row?.event_type === 'LANE_1_TV_INGRESS') {
    return { ...base, event: 'SIGNAL', instruction: ownScalar(detail, 'acceptedInstruction'),
      outcome: detail.signalShapeAccepted === true ? 'ACCEPTED'
        : detail.signalShapeAccepted === false ? 'CONTRACT_REFUSED' : 'AUTHENTICATED',
      reasonCode: ownScalar(detail, 'signalFaultCode') };
  }
  if (row?.event_type === 'LANE_1_TV_SIGNAL_REFUSED') {
    return { ...base, event: 'REFUSED', instruction: null,
      outcome: 'REFUSED', reasonCode: ownScalar(detail, 'faultCode') ?? 'LANE_1_REFUSAL_REASON_MISSING' };
  }
  if (row?.event_type === 'LANE_1_ORDER_PREVIEW') {
    return { ...base, event: 'PREVIEW', instruction: ownScalar(detail, 'brokerInstruction'),
      outcome: 'CLEAR', reasonCode: null };
  }
  if (row?.event_type === 'LANE_1_ORDER_PREVIEW_REFUSED') {
    return { ...base, event: 'REFUSED', instruction: ownScalar(detail, 'brokerInstruction'),
      outcome: 'REFUSED', reasonCode: ownScalar(detail, 'faultCode')
        ?? 'LANE_1_REFUSAL_REASON_MISSING' };
  }
  if (row?.event_type === 'LANE_1_FILL_RECEIPT') {
    const identity = detail.identity && typeof detail.identity === 'object' ? detail.identity : {};
    return { ...base, event: 'FILL', rawSide: null,
      instruction: ownScalar(identity, 'instruction'), quantity: ownScalar(identity, 'quantityShares'),
      fillId: ownScalar(identity, 'executionActivityId'),
      brokerOrderId: ownScalar(identity, 'brokerOrderId'), fillType: ownScalar(detail, 'type'),
      outcome: detail.evidenceOrigin === 'BROKER_LEDGER_RECONSTRUCTION'
        ? 'RECOVERED · BROKER_LEDGER_RECONSTRUCTION' : 'CAPTURED · RECEIPT_WRITTEN',
      reasonCode: null, evidenceOrigin: ownScalar(detail, 'evidenceOrigin'),
      realizedPnlCents: ownScalar(detail, 'realizedPnlCents'),
      qualifiedStage0Fill: detail.qualifiedStage0Fill === true };
  }
  return null;
}

function projectBrokerLedgerRow(row) {
  const eventType = String(row?.event_type ?? '').toUpperCase();
  const recordId = typeof row?.event_key === 'string' ? `broker-${row.event_key}` : null;
  const isExecution = eventType === 'EXECUTION';
  const isOrder = eventType === 'ORDER_STATE';
  if (!isExecution && !isOrder) return null;
  return { timestamp: row.occurred_at ?? row.first_seen_at ?? null,
    sourceEventType: isExecution ? 'BROKER_EXECUTION_ORPHAN' : 'BROKER_ORDER_OBSERVED',
    recordId, recordHref: recordId ? `#lane1-event-${recordId}` : null,
    sourceIngressId: null, rawSide: row.side ?? null, instruction: row.side ?? null,
    quantity: row.quantity ?? null, reasonCode: isExecution
      ? 'NO_LANE_1_FILL_RECEIPT_OR_COORDINATOR_RECORD' : null,
    signal: null, fillId: isExecution ? row.activity_id ?? null : null,
    brokerOrderId: row.broker_order_id ?? null, realizedPnlCents: null,
    event: isExecution ? 'FILL' : 'ORDER',
    outcome: isExecution ? 'BROKER_ONLY · ORPHAN' : `BROKER · ${row.state ?? 'OBSERVED'}`,
    evidenceOrigin: 'BROKER_LEDGER', qualifiedStage0Fill: false };
}

export async function lane1EventLedger(env, ownerId, { limit = 250,
  refreshPosition = false } = {}) {
  if (!env.DB?.prepare || !ownerId) throw new Error('LANE_1_LEDGER_STORAGE_UNAVAILABLE');
  const boundedLimit = Math.min(250, Math.max(1, Number.isSafeInteger(Number(limit))
    ? Number(limit) : 250));
  const placeholders = SOURCE_EVENT_TYPES.map(() => '?').join(',');
  const d1Read = env.DB.prepare(`SELECT id,event_type,detail_json,created_at FROM (
    SELECT id,event_type,detail_json,created_at FROM operational_audit
    WHERE owner_id=? AND event_type IN (${placeholders})
    ORDER BY created_at DESC,id DESC LIMIT ?)
    ORDER BY created_at ASC,id ASC`).bind(ownerId, ...SOURCE_EVENT_TYPES, boundedLimit).all();
  const historyStub = env.ACCOUNT_COORDINATOR?.getByName?.(ownerId);
  const coordinatorRead = historyStub?.laneV2History
    ? historyStub.laneV2History({ limit: boundedLimit })
    : Promise.reject(new Error('LANE_1_COORDINATOR_HISTORY_UNAVAILABLE'));
  const stateRead = historyStub?.laneV2Status
    ? historyStub.laneV2Status()
    : Promise.reject(new Error('LANE_1_COORDINATOR_STATE_UNAVAILABLE'));
  const brokerRead = env.DB.prepare(`SELECT event_key,event_type,broker_order_id,transaction_id,
    activity_id,symbol,side,quantity,price,state,occurred_at,first_seen_at FROM broker_events
    WHERE owner_id=? AND symbol='SPY' AND event_type IN ('ORDER_STATE','EXECUTION')
    ORDER BY occurred_at DESC,first_seen_at DESC LIMIT ?`).bind(ownerId, boundedLimit).all();
  const projectionRead = historyStub?.laneV2PositionProjection
    ? historyStub.laneV2PositionProjection({ ownerId, refresh: refreshPosition, maxAgeMs: 60_000 })
    : Promise.reject(new Error('LANE_1_POSITION_PROJECTION_UNAVAILABLE'));
  const [d1Result, coordinatorResult, stateResult, brokerResult, projectionResult]
    = await Promise.allSettled([
      d1Read, coordinatorRead, stateRead, brokerRead, projectionRead,
  ]);
  const d1Events = d1Result.status === 'fulfilled'
    ? (d1Result.value?.results ?? []).map(projectLane1LedgerRow).filter(Boolean) : [];
  const receiptFillIds = new Set(d1Events.filter((event) => event.sourceEventType
    === 'LANE_1_FILL_RECEIPT' && event.fillId).map((event) => String(event.fillId)));
  const coordinatorEvents = coordinatorResult.status === 'fulfilled'
    ? (coordinatorResult.value?.events ?? []).map(projectCoordinatorHistoryRow).filter(Boolean) : [];
  const coordinatorBrokerOrderIds = new Set(coordinatorEvents.filter((event) => event.event === 'ORDER')
    .map((event) => String(event.brokerOrderId ?? '')).filter(Boolean));
  const brokerEvents = brokerResult.status === 'fulfilled'
    ? (brokerResult.value?.results ?? []).map(projectBrokerLedgerRow).filter(Boolean)
      .filter((event) => event.event === 'FILL'
        ? !receiptFillIds.has(String(event.fillId ?? ''))
        : !coordinatorBrokerOrderIds.has(String(event.brokerOrderId ?? '')))
    : [];
  const events = [...d1Events,
    ...coordinatorEvents.filter((event) => event.event !== 'FILL'
      || !receiptFillIds.has(String(event.fillId ?? ''))), ...brokerEvents].sort((left, right) =>
    String(left.timestamp ?? '').localeCompare(String(right.timestamp ?? ''))
      || String(left.recordId ?? '').localeCompare(String(right.recordId ?? '')))
    .slice(-boundedLimit);
  const counts = { SIGNAL: 0, REFUSED: 0, PREVIEW: 0, ORDER: 0, FILL: 0 };
  for (const event of events) {
    if (Object.hasOwn(counts, event.event)) counts[event.event] += 1;
    else if (['FAULT', 'DISARMED'].includes(event.event)) counts.REFUSED += 1;
  }
  if (d1Result.status === 'rejected') {
    counts.SIGNAL = null; counts.PREVIEW = null; counts.REFUSED = null;
  }
  if (coordinatorResult.status === 'rejected') {
    counts.ORDER = null; counts.FILL = null; counts.REFUSED = null;
  }
  const sourceStatus = {
    operationalAudit: d1Result.status === 'fulfilled' ? 'LIVE' : 'FAULT',
    coordinatorHistory: coordinatorResult.status === 'fulfilled' ? 'LIVE' : 'FAULT',
    coordinatorState: stateResult.status === 'fulfilled' ? 'LIVE' : 'FAULT',
    brokerLedger: brokerResult.status === 'fulfilled' ? 'LIVE' : 'FAULT',
    positionProjection: projectionResult.status === 'fulfilled' ? 'LIVE' : 'FAULT',
  };
  const sourceErrors = [
    d1Result.status === 'rejected' ? String(d1Result.reason?.message ?? d1Result.reason) : null,
    coordinatorResult.status === 'rejected'
      ? String(coordinatorResult.reason?.message ?? coordinatorResult.reason) : null,
    stateResult.status === 'rejected'
      ? String(stateResult.reason?.message ?? stateResult.reason) : null,
    brokerResult.status === 'rejected'
      ? String(brokerResult.reason?.message ?? brokerResult.reason) : null,
    projectionResult.status === 'rejected'
      ? String(projectionResult.reason?.message ?? projectionResult.reason) : null,
  ].filter(Boolean);
  const measuredExits = events.filter((event) => event.fillType === 'EXIT_FILLED'
    && Number.isSafeInteger(event.realizedPnlCents));
  return {
    phase: 1,
    appendOnly: true,
    readOnly: true,
    events,
    counts,
    availability: sourceErrors.length ? 'DEGRADED' : 'COMPLETE',
    sourceStatus,
    sourceErrors,
    sources: { operationalAudit: [...SOURCE_EVENT_TYPES],
      coordinatorHistory: ['ORDER_ACCEPTED', 'OPEN_FILLED', 'EXIT_FILLED', 'FAULT',
        'AUTO_DISARMED'],
      brokerLedger: ['ORDER_STATE', 'EXECUTION'] },
    zeroReasons: { ORDER: counts.ORDER === 0 ? 'NEVER_ARMED' : null,
      FILL: counts.FILL === 0 ? (counts.ORDER === 0 ? 'NEVER_ARMED'
        : 'NO_BROKER_FILL_OBSERVED') : null },
    pnl: measuredExits.length ? {
      status: 'MEASURED',
      realizedPnlCents: measuredExits.reduce((sum, event) => sum + event.realizedPnlCents, 0),
      reason: 'Resolved Lane 1 exit receipts only.',
    } : {
      status: 'NOT_MEASURED',
      reason: 'No complete Lane 1 exit receipt exists. Account P&L is never substituted.',
    },
    phase2: measuredExits.length ? {
      status: 'ROUND_TRIP_RECORDED',
      reason: 'Realized P&L comes from a captured, materialized Lane 1 round trip.',
    } : {
      status: 'BLOCKED_NO_COMPLETE_EXIT',
      reason: 'Round-trip P&L requires a complete captured exit payload.',
    },
    positionProjection: projectionResult.status === 'fulfilled' ? projectionResult.value : null,
    summary: buildLane1BotSummary(events,
      stateResult.status === 'fulfilled' ? stateResult.value : null, {
        positionProjection: projectionResult.status === 'fulfilled'
          ? projectionResult.value : null,
      }),
  };
}
