import { resolveSchwabFillEvidence } from './schwab-fill-identity.js';

const FAULT_STAGE = 'SCHWAB_EXECUTION_MAPPING';

class MappingFault extends Error {
  constructor(code, detail = null) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

function fault(code, detail = null) {
  return Object.freeze({
    ok: false,
    outcome: 'FAULT',
    faultCode: code,
    faultStage: FAULT_STAGE,
    detail,
    events: null,
    mutationEligible: false,
  });
}

function requireValue(value, code, detail = null) {
  if (value === null || value === undefined || value === '') throw new MappingFault(code, detail);
  return value;
}

function requireArray(value, code, detail = null) {
  if (!Array.isArray(value) || value.length === 0) throw new MappingFault(code, detail);
  return value;
}

function finite(value, code, detail = null) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new MappingFault(code, detail);
  return number;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function executionObservations(order) {
  const fillEvidence = resolveSchwabFillEvidence(order);
  if (!fillEvidence.ok) throw new MappingFault(fillEvidence.faultCode, fillEvidence.detail);
  const evidenceByLeg = new Map(fillEvidence.fills.map((fill) =>
    [`${fill.activityIndex}:${fill.legIndex}`, fill]));
  const observations = [];
  const acknowledgement = order.acknowledgement;
  if (acknowledgement) {
    observations.push({
      kind: 'ACKNOWLEDGEMENT',
      acquiredSequence: finite(acknowledgement.acquiredSequence,
        'MISSING_APPEND_SEQUENCE', { brokerOrderId: order.orderId, kind: 'ACKNOWLEDGEMENT' }),
      acknowledgement,
    });
  }
  for (const [activityIndex, activity] of (order.orderActivityCollection ?? []).entries()) {
    if (String(activity.activityType ?? '').toUpperCase() !== 'EXECUTION') continue;
    for (const [legIndex, leg] of (activity.executionLegs ?? []).entries()) {
      observations.push({
        kind: 'FILL',
        acquiredSequence: finite(leg.acquiredSequence,
          'MISSING_APPEND_SEQUENCE', { brokerOrderId: order.orderId, kind: 'FILL' }),
        activity,
        leg,
        evidence: evidenceByLeg.get(`${activityIndex}:${legIndex}`),
      });
    }
  }
  return observations.sort((left, right) => left.acquiredSequence - right.acquiredSequence);
}

function mapFill(order, activity, leg, evidence, unit) {
  const fillId = requireValue(evidence?.fillId, 'MISSING_FILL_ID', {
    brokerOrderId: order.orderId,
  });
  const fee = finite(evidence?.feeUsd, 'MISSING_FEE', { brokerOrderId: order.orderId, fillId });
  return {
    eventType: 'BROKER_FILL',
    resolvedUnitId: unit.context.resolvedUnitId,
    brokerEventId: requireValue(leg.eventId, 'MISSING_BROKER_EVENT_ID', { fillId }),
    fillId,
    brokerExecutionId: requireValue(leg.executionId ?? activity.activityId
      ?? leg.orderLegExecutionId ?? fillId,
      'MISSING_EXECUTION_ID', { fillId }),
    brokerOrderId: requireValue(order.orderId, 'MISSING_ORDER_ID'),
    clientOrderId: requireValue(order.clientOrderId, 'MISSING_CLIENT_ORDER_ID'),
    brokerAdapterVersion: requireValue(unit.context.brokerAdapterVersion,
      'MISSING_BROKER_ADAPTER_VERSION'),
    brokerOccurredAt: requireValue(leg.time, 'MISSING_BROKER_OCCURRED_AT', { fillId }),
    acquiredAt: requireValue(leg.acquiredAt, 'MISSING_ACQUIRED_AT', { fillId }),
    quantityContracts: finite(evidence?.quantity, 'MISSING_FILL_QUANTITY', { fillId }),
    executionPriceUsdPerShare: finite(evidence?.price, 'MISSING_FILL_PRICE', { fillId }),
    feeUsd: fee,
    premiumCashEntryId: requireValue(leg.premiumCashEntryId,
      'MISSING_PREMIUM_CASH_ENTRY_ID', { fillId }),
    feeCashEntryId: requireValue(leg.feeCashEntryId,
      'MISSING_FEE_CASH_ENTRY_ID', { fillId }),
    canonicalDeduplicationSha256: requireValue(leg.canonicalDeduplicationSha256,
      'MISSING_FILL_DEDUPLICATION_HASH', { fillId }),
    rawBrokerEvidenceSha256: requireValue(leg.rawBrokerEvidenceSha256,
      'MISSING_RAW_EVIDENCE_HASH', { fillId }),
  };
}

function mapAcknowledgement(order, acknowledgement, unit) {
  return {
    eventType: 'BROKER_ACKNOWLEDGEMENT',
    resolvedUnitId: unit.context.resolvedUnitId,
    brokerEventId: requireValue(acknowledgement.eventId,
      'MISSING_BROKER_EVENT_ID', { brokerOrderId: order.orderId }),
    brokerOrderId: requireValue(order.orderId, 'MISSING_ORDER_ID'),
    clientOrderId: requireValue(order.clientOrderId, 'MISSING_CLIENT_ORDER_ID'),
    acknowledgedQuantityContracts: finite(
      acknowledgement.quantity ?? order.quantity,
      'MISSING_ACKNOWLEDGED_QUANTITY',
      { brokerOrderId: order.orderId },
    ),
    brokerOccurredAt: requireValue(acknowledgement.time,
      'MISSING_BROKER_OCCURRED_AT', { brokerOrderId: order.orderId }),
    acquiredAt: requireValue(acknowledgement.acquiredAt,
      'MISSING_ACQUIRED_AT', { brokerOrderId: order.orderId }),
  };
}

function mapAssignment(activity, unit) {
  const assignedContracts = finite(activity.assignedContracts,
    'MISSING_ASSIGNMENT_QUANTITY', { resolvedUnitId: unit.context.resolvedUnitId });
  const lots = requireArray(activity.shareLots, 'MISSING_ASSIGNMENT_LOTS', {
    resolvedUnitId: unit.context.resolvedUnitId,
  });
  if (lots.length !== assignedContracts || lots.some((lot) => !lot.shareLotId || !lot.shareMovementId)) {
    throw new MappingFault('MISSING_ASSIGNMENT_LOTS', {
      resolvedUnitId: unit.context.resolvedUnitId,
      assignedContracts,
      suppliedLots: lots.length,
    });
  }
  return {
    eventType: 'PUT_ASSIGNMENT',
    resolvedUnitId: unit.context.resolvedUnitId,
    terminalEventId: requireValue(activity.terminalEventId, 'MISSING_TERMINAL_EVENT_ID'),
    sourceEventId: requireValue(activity.activityId, 'MISSING_ASSIGNMENT_EVENT_ID'),
    sourceEvidenceSha256: requireValue(activity.rawBrokerEvidenceSha256,
      'MISSING_RAW_EVIDENCE_HASH'),
    assignedContracts,
    strikeUsdPerShare: finite(activity.strikePrice, 'MISSING_ASSIGNMENT_STRIKE'),
    assignmentFeeUsd: finite(activity.fee, 'MISSING_ASSIGNMENT_FEE'),
    shareLotIds: lots.map((lot) => lot.shareLotId),
    shareMovementIds: lots.map((lot) => lot.shareMovementId),
    strikeCashEntryId: requireValue(activity.strikeCashEntryId,
      'MISSING_ASSIGNMENT_CASH_ENTRY_ID'),
    assignmentFeeCashEntryId: requireValue(activity.assignmentFeeCashEntryId,
      'MISSING_ASSIGNMENT_FEE_ENTRY_ID'),
    effectiveAt: requireValue(activity.effectiveAt, 'MISSING_EFFECTIVE_AT'),
    acquiredAt: requireValue(activity.acquiredAt, 'MISSING_ACQUIRED_AT'),
  };
}

function mapExpiration(activity, unit) {
  const call = unit.context.strategy === 'COVERED_CALL';
  const releaseShareMovementIds = call
    ? requireArray(activity.releaseShareMovementIds, 'MISSING_RELEASE_LOT_EVENTS', {
      resolvedUnitId: unit.context.resolvedUnitId,
    }) : null;
  return {
    eventType: call ? 'CALL_EXPIRY' : 'OPTION_EXPIRY',
    resolvedUnitId: unit.context.resolvedUnitId,
    terminalEventId: requireValue(activity.terminalEventId, 'MISSING_TERMINAL_EVENT_ID'),
    sourceEventId: requireValue(activity.activityId, 'MISSING_EXPIRATION_EVENT_ID'),
    sourceEvidenceSha256: requireValue(activity.rawBrokerEvidenceSha256,
      'MISSING_RAW_EVIDENCE_HASH'),
    expiredContracts: finite(activity.expiredContracts, 'MISSING_EXPIRATION_QUANTITY'),
    ...(call ? { releaseShareMovementIds: releaseShareMovementIds.slice() } : {}),
    effectiveAt: requireValue(activity.effectiveAt, 'MISSING_EFFECTIVE_AT'),
    acquiredAt: requireValue(activity.acquiredAt, 'MISSING_ACQUIRED_AT'),
  };
}

function mapUnit(unit, append) {
  const context = unit?.context;
  if (!context) throw new MappingFault('MISSING_UNIT_CONTEXT');
  const resolvedUnitId = requireValue(context.resolvedUnitId, 'MISSING_RESOLVED_UNIT_ID');
  const order = unit.order;
  if (!order) throw new MappingFault('MISSING_ORDER', { resolvedUnitId });
  requireValue(order.orderId, 'MISSING_ORDER_ID', { resolvedUnitId });

  append({
    eventType: 'UNIT_OPENED',
    economicEpisodeId: requireValue(context.economicEpisodeId, 'MISSING_ECONOMIC_EPISODE_ID'),
    resolvedUnitId,
    ...(context.parentResolvedUnitId ? { parentResolvedUnitId: context.parentResolvedUnitId } : {}),
    strategy: requireValue(context.strategy, 'MISSING_STRATEGY'),
    accountId: requireValue(context.accountId, 'MISSING_ACCOUNT_ID'),
    symbol: requireValue(context.symbol, 'MISSING_SYMBOL'),
    lifecycleId: requireValue(context.lifecycleId, 'MISSING_LIFECYCLE_ID'),
    positionId: requireValue(context.positionId, 'MISSING_POSITION_ID'),
    terminalEventId: requireValue(context.terminalEventId, 'MISSING_TERMINAL_EVENT_ID'),
    pnlRecordId: requireValue(context.pnlRecordId, 'MISSING_PNL_RECORD_ID'),
  });
  append({
    ...clone(requireValue(context.decision, 'MISSING_DECISION_CONTEXT')),
    eventType: 'DECISION_SEALED',
    economicEpisodeId: context.economicEpisodeId,
    resolvedUnitId,
  });
  append({
    ...clone(requireValue(context.proposal, 'MISSING_PROPOSAL_CONTEXT')),
    eventType: 'PROPOSAL_SEALED',
    economicEpisodeId: context.economicEpisodeId,
    resolvedUnitId,
  });
  if (context.strategy === 'COVERED_CALL') {
    append({
      ...clone(requireValue(context.reservation, 'MISSING_SHARE_RESERVATION')),
      eventType: 'SHARES_RESERVED',
      resolvedUnitId,
    });
  }
  append({
    eventType: 'ORDER_SUBMITTED',
    resolvedUnitId,
    authorizationRecordId: requireValue(context.authorizationRecordId,
      'MISSING_AUTHORIZATION_RECORD_ID'),
    brokerAdapterVersion: requireValue(context.brokerAdapterVersion,
      'MISSING_BROKER_ADAPTER_VERSION'),
    brokerOrderId: order.orderId,
    clientOrderId: requireValue(order.clientOrderId, 'MISSING_CLIENT_ORDER_ID'),
    canonicalRequestSha256: requireValue(context.canonicalRequestSha256,
      'MISSING_CANONICAL_REQUEST_HASH'),
    submittedAt: requireValue(order.enteredTime, 'MISSING_ORDER_ENTERED_AT'),
  });

  const observations = executionObservations(order);
  if (!observations.some((observation) => observation.kind === 'FILL')) {
    throw new MappingFault('MISSING_FILLS', { brokerOrderId: order.orderId });
  }
  for (const observation of observations) {
    append(observation.kind === 'FILL'
      ? mapFill(order, observation.activity, observation.leg, observation.evidence, unit)
      : mapAcknowledgement(order, observation.acknowledgement, unit));
  }

  const terminalActivities = requireArray(unit.terminalActivities,
    'MISSING_TERMINAL_EVENT', { resolvedUnitId });
  for (const activity of terminalActivities) {
    const type = String(activity.activityType ?? '').toUpperCase();
    if (type === 'PUT_ASSIGNMENT') append(mapAssignment(activity, unit));
    else if (type === 'OPTION_EXPIRATION' || type === 'CALL_EXPIRATION') {
      append(mapExpiration(activity, unit));
    } else {
      throw new MappingFault('UNSUPPORTED_TERMINAL_EVENT', { resolvedUnitId, activityType: type });
    }
  }
  append({
    ...clone(requireValue(context.mark, 'MISSING_MARK_CONTEXT')),
    eventType: 'MARK_OBSERVED',
    resolvedUnitId,
  });
}

/**
 * Convert explicitly identified Schwab execution facts to the append-only E3
 * event stream. Custody positions are deliberately outside this boundary.
 */
export function schwabExecutionToEvents(payload) {
  try {
    if (Array.isArray(payload?.positions) && !Array.isArray(payload?.units)) {
      return fault('POSITION_SNAPSHOT_NOT_EXECUTION_EVIDENCE');
    }
    const units = requireArray(payload?.units, 'MISSING_EXECUTION_UNITS');
    const snapshotId = requireValue(payload.snapshotId, 'MISSING_SNAPSHOT_ID');
    const events = [];
    const append = (event) => {
      const streamSequence = events.length + 1;
      events.push({
        ...event,
        streamEventId: `${snapshotId}:${String(streamSequence).padStart(6, '0')}`,
        streamSequence,
      });
    };
    for (const unit of units) mapUnit(unit, append);
    return Object.freeze({
      ok: true,
      outcome: 'MAPPED',
      faultCode: null,
      faultStage: null,
      events,
      mutationEligible: false,
    });
  } catch (error) {
    if (error instanceof MappingFault) return fault(error.code, error.detail);
    return fault('INVALID_SCHWAB_EXECUTION_PAYLOAD', { message: String(error?.message ?? error) });
  }
}
