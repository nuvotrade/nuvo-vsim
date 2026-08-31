const SOURCE_EVENT_TYPES = Object.freeze([
  'LANE_1_TV_INGRESS',
  'LANE_1_TV_SIGNAL_REFUSED',
  'LANE_1_ORDER_PREVIEW',
  'LANE_1_ORDER_PREVIEW_REFUSED',
]);

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
  };
  if (row?.event_type === 'ORDER_ACCEPTED') {
    return { ...base, event: 'ORDER', outcome: 'ACCEPTED' };
  }
  if (row?.event_type === 'OPEN_FILLED' || row?.event_type === 'EXIT_FILLED') {
    return { ...base, event: 'FILL', outcome: 'FILLED' };
  }
  if (row?.event_type === 'FAULT') {
    return { ...base, event: 'REFUSED', outcome: 'REFUSED',
      reasonCode: ownScalar(detail, 'faultCode') ?? 'LANE_1_REFUSAL_REASON_MISSING' };
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
    instruction: null,
    quantity: ownScalar(rawMessage, 'qty') ?? ownScalar(replayBody, 'qty')
      ?? ownScalar(detail, 'quantity'),
    reasonCode: null,
    outcome: null,
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
  return null;
}

export async function lane1EventLedger(env, ownerId, { limit = 250 } = {}) {
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
  const [d1Result, coordinatorResult] = await Promise.allSettled([d1Read, coordinatorRead]);
  const d1Events = d1Result.status === 'fulfilled'
    ? (d1Result.value?.results ?? []).map(projectLane1LedgerRow).filter(Boolean) : [];
  const coordinatorEvents = coordinatorResult.status === 'fulfilled'
    ? (coordinatorResult.value?.events ?? []).map(projectCoordinatorHistoryRow).filter(Boolean) : [];
  const events = [...d1Events, ...coordinatorEvents].sort((left, right) =>
    String(left.timestamp ?? '').localeCompare(String(right.timestamp ?? ''))
      || String(left.recordId ?? '').localeCompare(String(right.recordId ?? '')))
    .slice(-boundedLimit);
  const counts = { SIGNAL: 0, REFUSED: 0, PREVIEW: 0, ORDER: 0, FILL: 0 };
  for (const event of events) counts[event.event] += 1;
  if (d1Result.status === 'rejected') {
    counts.SIGNAL = null; counts.PREVIEW = null; counts.REFUSED = null;
  }
  if (coordinatorResult.status === 'rejected') {
    counts.ORDER = null; counts.FILL = null; counts.REFUSED = null;
  }
  const sourceStatus = {
    operationalAudit: d1Result.status === 'fulfilled' ? 'LIVE' : 'FAULT',
    coordinatorHistory: coordinatorResult.status === 'fulfilled' ? 'LIVE' : 'FAULT',
  };
  const sourceErrors = [
    d1Result.status === 'rejected' ? String(d1Result.reason?.message ?? d1Result.reason) : null,
    coordinatorResult.status === 'rejected'
      ? String(coordinatorResult.reason?.message ?? coordinatorResult.reason) : null,
  ].filter(Boolean);
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
      coordinatorHistory: ['ORDER_ACCEPTED', 'OPEN_FILLED', 'EXIT_FILLED', 'FAULT'] },
    zeroReasons: { ORDER: counts.ORDER === 0 ? 'NEVER_ARMED' : null,
      FILL: counts.FILL === 0 ? 'NEVER_ARMED' : null },
    pnl: {
      status: 'NOT_MEASURED',
      reason: 'No captured Lane 1 fill payloads exist. Phase 1 does not infer pairing or substitute account P&L.',
    },
    phase2: {
      status: 'BLOCKED_NO_FILL_PAYLOADS',
      reason: 'Round-trip pairing starts only after four complete broker fill payloads are captured.',
    },
  };
}
