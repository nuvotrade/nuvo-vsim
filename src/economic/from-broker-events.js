const DATA_FILES = Object.freeze([
  'decision.json',
  'proposal.json',
  'order-events.json',
  'fills.json',
  'cash.json',
  'shares.json',
  'pnl.json',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`BROKER_EVENT_ADAPTER:${message}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cents(value, label) {
  invariant(typeof value === 'number' && Number.isFinite(value), `${label}:FINITE_NUMBER_REQUIRED`);
  return Math.round(value * 100);
}

function money(value) {
  return Number((value / 100).toFixed(2));
}

function requireString(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label}:NONEMPTY_STRING_REQUIRED`);
  return value;
}

function forbiddenKeyPaths(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => forbiddenKeyPaths(entry, `${path}[${index}]`, found));
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  for (const [key, entry] of Object.entries(value)) {
    const keyPath = `${path}.${key}`;
    if (/forecast|calibration/iu.test(key)) found.push(keyPath);
    forbiddenKeyPaths(entry, keyPath, found);
  }
  return found;
}

function fillFingerprint(event) {
  return JSON.stringify([
    event.fillId,
    event.brokerExecutionId,
    event.brokerOrderId,
    event.clientOrderId,
    event.brokerOccurredAt,
    event.quantityContracts,
    event.executionPriceUsdPerShare,
    event.feeUsd,
    event.canonicalDeduplicationSha256,
  ]);
}

function newUnit(event) {
  return {
    meta: clone(event),
    decisionEvent: null,
    proposalEvent: null,
    order: null,
    appendLog: [],
    fills: [],
    fillFingerprints: new Map(),
    terminalEvents: [],
    cashEntries: [],
    lots: [],
    shareMovements: [],
    reserveEvent: null,
    markEvent: null,
  };
}

function appendBrokerEvent(unit, event, fields) {
  unit.appendLog.push({
    ...fields,
    acquiredAt: event.acquiredAt,
    appendSequence: unit.appendLog.length + 1,
    brokerOccurredAt: event.brokerOccurredAt,
    brokerOrderId: event.brokerOrderId,
    clientOrderId: event.clientOrderId,
    eventId: event.brokerEventId,
  });
}

function appendCash(unit, entry) {
  const priorCents = unit.cashEntries.reduce((total, current) => total + cents(current.amount,
    'CASH_AMOUNT'), 0);
  const amountCents = cents(entry.amount, 'CASH_AMOUNT');
  const running = money(priorCents + amountCents);
  unit.cashEntries.push({
    ...entry,
    appendSequence: unit.cashEntries.length + 1,
    currency: 'USD',
    feeFormulaVersion: 'FIXTURE_FEE_FORMULA_V1',
    ...(unit.meta.strategy === 'CASH_SECURED_PUT'
      ? { runningNetMovementUsd: running }
      : { runningContinuationNetUsd: running }),
  });
}

function applyFill(unit, event) {
  const fingerprint = fillFingerprint(event);
  if (unit.fillFingerprints.has(event.fillId)) {
    invariant(unit.fillFingerprints.get(event.fillId) === fingerprint,
      `FILL_${event.fillId}:CONFLICTING_DUPLICATE`);
    return;
  }

  invariant(unit.order, `FILL_${event.fillId}:ORDER_REQUIRED`);
  requireString(event.fillId, 'FILL_ID');
  requireString(event.canonicalDeduplicationSha256, 'FILL_DEDUPLICATION_SHA256');
  const quantityContracts = event.quantityContracts;
  const multiplier = unit.proposalEvent.contract.contractMultiplierShares;
  invariant(Number.isInteger(quantityContracts) && quantityContracts > 0,
    `FILL_${event.fillId}:POSITIVE_INTEGER_CONTRACTS_REQUIRED`);
  const grossPremiumUsd = money(cents(event.executionPriceUsdPerShare,
    `FILL_${event.fillId}:PRICE`) * quantityContracts * multiplier);

  const fill = {
    acquiredAt: event.acquiredAt,
    brokerAdapterVersion: event.brokerAdapterVersion,
    brokerExecutionId: event.brokerExecutionId,
    brokerOccurredAt: event.brokerOccurredAt,
    brokerOrderId: event.brokerOrderId,
    canonicalDeduplicationSha256: event.canonicalDeduplicationSha256,
    clientOrderId: event.clientOrderId,
    contractMultiplierShares: multiplier,
    executionPriceUsdPerShare: event.executionPriceUsdPerShare,
    feeCashEntryId: event.feeCashEntryId,
    feeUsd: event.feeUsd,
    fillId: event.fillId,
    grossPremiumUsd,
    positionContractHash: unit.proposalEvent.positionContractHash,
    premiumCashEntryId: event.premiumCashEntryId,
    quantityContracts,
    rawBrokerEvidenceSha256: event.rawBrokerEvidenceSha256,
    side: 'SELL_TO_OPEN',
    ...(unit.meta.strategy === 'COVERED_CALL'
      ? { reservedShareLotIds: unit.reserveEvent.shareLotIds.slice() }
      : {}),
  };
  unit.fillFingerprints.set(event.fillId, fingerprint);
  unit.fills.push(fill);
  appendBrokerEvent(unit, event, {
    eventType: 'FILL',
    fillId: event.fillId,
    quantityContracts,
  });

  const call = unit.meta.strategy === 'COVERED_CALL';
  appendCash(unit, {
    amount: grossPremiumUsd,
    cashEntryId: event.premiumCashEntryId,
    idempotencyKey: `CASH-IDEM-${event.premiumCashEntryId}`,
    line: call ? 'COVERED_CALL_PREMIUM_RECEIPT' : 'OPTION_PREMIUM_RECEIPT',
    sourceEventId: event.fillId,
  });
  appendCash(unit, {
    amount: event.feeUsd,
    cashEntryId: event.feeCashEntryId,
    idempotencyKey: `CASH-IDEM-${event.feeCashEntryId}`,
    line: call ? 'COVERED_CALL_OPENING_FILL_FEE' : 'OPENING_FILL_FEE',
    sourceEventId: event.fillId,
  });
}

function applyPutAssignment(unit, event) {
  invariant(unit.meta.strategy === 'CASH_SECURED_PUT', 'PUT_ASSIGNMENT_STRATEGY_INVALID');
  const multiplier = unit.proposalEvent.contract.contractMultiplierShares;
  invariant(Number.isInteger(event.assignedContracts) && event.assignedContracts > 0,
    'PUT_ASSIGNMENT_CONTRACTS_INVALID');
  invariant(event.shareLotIds.length === event.assignedContracts,
    'PUT_ASSIGNMENT_ONE_LOT_PER_CONTRACT_REQUIRED');
  invariant(event.shareMovementIds.length === event.assignedContracts,
    'PUT_ASSIGNMENT_MOVEMENT_IDS_INVALID');

  const sharesReceived = event.assignedContracts * multiplier;
  const strikeDebitCents = -cents(event.strikeUsdPerShare, 'PUT_ASSIGNMENT_STRIKE') * sharesReceived;
  const assignmentFeeCents = cents(event.assignmentFeeUsd, 'PUT_ASSIGNMENT_FEE');
  invariant(strikeDebitCents < 0 && assignmentFeeCents <= 0, 'PUT_ASSIGNMENT_CASH_SIGNS_INVALID');
  const allocatedFeeCents = Math.round((-assignmentFeeCents) / event.shareLotIds.length);

  event.shareLotIds.forEach((shareLotId, index) => {
    const movementId = event.shareMovementIds[index];
    const strikeCostCents = cents(event.strikeUsdPerShare, 'PUT_ASSIGNMENT_STRIKE') * multiplier;
    const totalLotCostCents = strikeCostCents + allocatedFeeCents;
    unit.lots.push({
      allocatedAssignmentFeeUsd: money(allocatedFeeCents),
      costPerShareUsd: Number((money(totalLotCostCents) / multiplier).toFixed(3)),
      parentAssignmentEventId: event.terminalEventId,
      quantityShares: multiplier,
      shareLotId,
      sourceMovementId: movementId,
      state: 'AVAILABLE',
      strikeCostUsd: money(strikeCostCents),
      totalLotCostUsd: money(totalLotCostCents),
    });
    unit.shareMovements.push({
      effectiveAt: event.effectiveAt,
      idempotencyKey: `SHARE-IDEM-${movementId}`,
      quantityShares: multiplier,
      shareLotId,
      shareMovementId: movementId,
      sourceEventId: event.terminalEventId,
    });
  });

  appendCash(unit, {
    amount: money(strikeDebitCents),
    cashEntryId: event.strikeCashEntryId,
    idempotencyKey: `CASH-IDEM-${event.strikeCashEntryId}`,
    line: 'PUT_ASSIGNMENT_STRIKE_DEBIT',
    sourceEventId: event.terminalEventId,
  });
  appendCash(unit, {
    amount: event.assignmentFeeUsd,
    cashEntryId: event.assignmentFeeCashEntryId,
    idempotencyKey: `CASH-IDEM-${event.assignmentFeeCashEntryId}`,
    line: 'PUT_ASSIGNMENT_FEE',
    sourceEventId: event.terminalEventId,
  });

  unit.terminalEvents.push({
    acquiredAt: event.acquiredAt,
    assignedContracts: event.assignedContracts,
    assignmentFeeUsd: event.assignmentFeeUsd,
    cashEntryIds: [event.strikeCashEntryId, event.assignmentFeeCashEntryId],
    contractMultiplierShares: multiplier,
    effectiveAt: event.effectiveAt,
    eventType: 'PARTIAL_PUT_ASSIGNMENT',
    settlementFormulaVersion: 'OCC_EQUITY_OPTION_100_SHARE_FIXTURE_V1',
    shareLotIds: event.shareLotIds.slice(),
    shareMovementIds: event.shareMovementIds.slice(),
    sharesReceived,
    sourceEventId: event.sourceEventId,
    sourceEvidenceSha256: event.sourceEvidenceSha256,
    strikeCashDebitUsd: money(strikeDebitCents),
    strikeUsdPerShare: event.strikeUsdPerShare,
    terminalEventId: event.terminalEventId,
  });
}

function applyExpiry(unit, event) {
  const call = unit.meta.strategy === 'COVERED_CALL';
  if (call) {
    invariant(unit.reserveEvent, 'COVERED_CALL_EXPIRY_RESERVATION_REQUIRED');
    invariant(event.releaseShareMovementIds.length === unit.reserveEvent.shareLotIds.length,
      'COVERED_CALL_RELEASE_MOVEMENT_IDS_INVALID');
    unit.reserveEvent.shareLotIds.forEach((shareLotId, index) => {
      unit.shareMovements.push({
        action: 'RELEASE_COVERED_CALL',
        appendSequence: unit.shareMovements.length + 1,
        effectiveAt: event.acquiredAt,
        idempotencyKey: `SHARE-IDEM-${event.releaseShareMovementIds[index]}`,
        quantityShares: unit.proposalEvent.contract.contractMultiplierShares,
        shareLotId,
        shareMovementId: event.releaseShareMovementIds[index],
        sourceEventId: event.terminalEventId,
      });
    });
  }

  unit.terminalEvents.push({
    acquiredAt: event.acquiredAt,
    cashEntryIds: [],
    effectiveAt: event.effectiveAt,
    eventType: call ? 'COVERED_CALL_EXPIRY' : 'PARTIAL_EXPIRY',
    expiredContracts: event.expiredContracts,
    feeEntryIds: [],
    ...(call ? {
      releaseShareMovementIds: event.releaseShareMovementIds.slice(),
      remainingContracts: 0,
      shareSaleProceedsUsd: 0,
      sharesCreated: 0,
      sharesDelivered: 0,
    } : {
      optionQuantityAfterEvent: 0,
      shareMovementIds: [],
    }),
    settlementFormulaVersion: 'OCC_EQUITY_OPTION_100_SHARE_FIXTURE_V1',
    sourceEventId: event.sourceEventId,
    sourceEvidenceSha256: event.sourceEvidenceSha256,
    terminalEventId: event.terminalEventId,
  });
}

function applyReservation(unit, event, parent) {
  invariant(unit.meta.strategy === 'COVERED_CALL', 'SHARE_RESERVATION_STRATEGY_INVALID');
  invariant(parent && parent.lots.length > 0, 'SHARE_RESERVATION_PARENT_LOTS_REQUIRED');
  const multiplier = unit.proposalEvent.contract.contractMultiplierShares;
  const requiredShares = unit.proposalEvent.contract.quantityContracts * multiplier;
  const deliverableShares = parent.lots.reduce((total, lot) => total + lot.quantityShares, 0);
  invariant(requiredShares <= deliverableShares, 'COVERED_CALL_INSUFFICIENT_DELIVERABLE_SHARES');
  invariant(event.shareLotIds.length === unit.proposalEvent.contract.quantityContracts,
    'COVERED_CALL_RESERVATION_LOT_COUNT_INVALID');
  invariant(JSON.stringify(event.shareLotIds) === JSON.stringify(parent.lots.map((lot) => lot.shareLotId)),
    'COVERED_CALL_MUST_RESERVE_PARENT_LOTS');
  invariant(event.shareMovementIds.length === event.shareLotIds.length,
    'COVERED_CALL_RESERVATION_MOVEMENT_IDS_INVALID');

  unit.reserveEvent = clone(event);
  event.shareLotIds.forEach((shareLotId, index) => {
    unit.shareMovements.push({
      action: 'RESERVE_COVERED_CALL',
      appendSequence: unit.shareMovements.length + 1,
      effectiveAt: event.effectiveAt,
      idempotencyKey: `SHARE-IDEM-${event.shareMovementIds[index]}`,
      positionId: unit.meta.positionId,
      quantityShares: multiplier,
      shareLotId,
      shareMovementId: event.shareMovementIds[index],
    });
  });
}

function placeholderOrderedFiles() {
  return DATA_FILES.map((path, index) => ({
    byteLength: 0,
    path,
    sequence: index + 1,
    sha256: '0'.repeat(64),
  }));
}

function makeDecision(unit, parent) {
  const event = unit.decisionEvent;
  invariant(event, `${unit.meta.resolvedUnitId}:DECISION_REQUIRED`);
  const base = {
    accountId: unit.meta.accountId,
    authority: { level: 2, name: 'PROPOSE_ONLY' },
    decision: unit.meta.strategy === 'COVERED_CALL' ? 'PROPOSE_TWO_COVERED_CALLS' : 'PROPOSE',
    decisionAt: event.decisionAt,
    decisionId: event.decisionId,
    economicEpisodeId: unit.meta.economicEpisodeId,
    recordType: 'DECISION',
    resolvedUnitId: unit.meta.resolvedUnitId,
    sealedAt: event.sealedAt,
    strategy: unit.meta.strategy,
    symbol: unit.meta.symbol,
  };
  if (unit.meta.strategy !== 'COVERED_CALL') return base;

  const lotIds = parent.lots.map((lot) => lot.shareLotId);
  const multiplier = unit.proposalEvent.contract.contractMultiplierShares;
  const deliverableShares = parent.lots.reduce((total, lot) => total + lot.quantityShares, 0);
  const requiredShares = unit.proposalEvent.contract.quantityContracts * multiplier;
  const thirdRequiredShares = event.thirdCallContracts * multiplier;
  invariant(requiredShares <= deliverableShares, 'COVERED_CALL_DECISION_NOT_COVERED');
  invariant(thirdRequiredShares > deliverableShares, 'THIRD_CALL_MUST_FAULT');
  const thirdCallFault = {
    deliverableShares,
    faultClass: 'CONTRACT_FAULT',
    faultCode: 'COVERED_CALL_INSUFFICIENT_DELIVERABLE_SHARES',
    faultId: event.faultId,
    faultStage: 'SHARE_RESERVATION',
    orderCreated: false,
    outcome: 'FAULT',
    proposalAttemptId: event.proposalAttemptId,
    proposalCreated: false,
    requestedContracts: event.thirdCallContracts,
    requiredShares: thirdRequiredShares,
    reservationCreated: false,
    shortfallShares: thirdRequiredShares - deliverableShares,
  };
  return {
    ...base,
    acceptedCoverageEvaluation: {
      deliverableShares,
      requestedContracts: unit.proposalEvent.contract.quantityContracts,
      requiredShares,
      reservedShareLotIds: lotIds,
      result: 'PASS',
    },
    parentResolvedUnitId: unit.meta.parentResolvedUnitId,
    thirdCallFault,
  };
}

function makeProposal(unit, parent, decision) {
  const event = unit.proposalEvent;
  invariant(event, `${unit.meta.resolvedUnitId}:PROPOSAL_REQUIRED`);
  const proposal = {
    accountId: unit.meta.accountId,
    contract: clone(event.contract),
    economicEpisodeId: unit.meta.economicEpisodeId,
    orderInstruction: clone(event.orderInstruction),
    parentDecisionId: decision.decisionId,
    positionContractHash: event.positionContractHash,
    positionContractId: event.positionContractId,
    proposalHash: event.proposalHash,
    proposalId: event.proposalId,
    recordType: 'PROPOSAL',
    resolvedUnitId: unit.meta.resolvedUnitId,
    sealedAt: event.sealedAt,
  };
  if (unit.meta.strategy === 'COVERED_CALL') {
    const lotIds = parent.lots.map((lot) => lot.shareLotId);
    proposal.coverage = {
      inventedShares: 0,
      referencedShareLotIds: lotIds,
      referencedShares: lotIds.length * event.contract.contractMultiplierShares,
      requiredShares: event.contract.quantityContracts * event.contract.contractMultiplierShares,
      result: 'PASS',
    };
    proposal.rejectedThirdCallAttempt = clone(decision.thirdCallFault);
  }
  return proposal;
}

function makeOrderEvents(unit) {
  invariant(unit.order, `${unit.meta.resolvedUnitId}:ORDER_REQUIRED`);
  return {
    acquisitionOrderFillIds: unit.fills.map((fill) => fill.fillId),
    appendLog: clone(unit.appendLog),
    economicEpisodeId: unit.meta.economicEpisodeId,
    fillIds: unit.fills.map((fill) => fill.fillId),
    order: clone(unit.order),
    recordType: 'ORDER_EVENT_LOG',
    resolvedUnitId: unit.meta.resolvedUnitId,
  };
}

function makeFills(unit) {
  return {
    economicEpisodeId: unit.meta.economicEpisodeId,
    fillIds: unit.fills.map((fill) => fill.fillId),
    fillReconciliation: {},
    fills: clone(unit.fills),
    lifecycle: {
      lifecycleId: unit.meta.lifecycleId,
      positionId: unit.meta.positionId,
      terminalEvents: clone(unit.terminalEvents),
      terminalSummary: {
        assignedContracts: 0,
        childTerminalEventIds: unit.terminalEvents.map((event) => event.terminalEventId),
        episodeStatus: 'OPEN_SHARES',
        expiredContracts: 0,
        openedContracts: 0,
        remainingContracts: 0,
        sharesCreated: 0,
        sharesDelivered: 0,
        sharesRemaining: 0,
        terminalEventId: unit.meta.terminalEventId,
        unitStatus: 'PENDING_FOLD',
      },
    },
    position: {
      contributingFillIds: unit.fills.map((fill) => fill.fillId),
      positionContractHash: unit.proposalEvent.positionContractHash,
      positionContractId: unit.proposalEvent.positionContractId,
      positionId: unit.meta.positionId,
    },
    recordType: 'FILLS_POSITION_AND_LIFECYCLE',
    resolvedUnitId: unit.meta.resolvedUnitId,
  };
}

function makeCash(unit) {
  return {
    accountId: unit.meta.accountId,
    cashEntryIds: unit.cashEntries.map((entry) => entry.cashEntryId),
    currency: 'USD',
    economicEpisodeId: unit.meta.economicEpisodeId,
    entries: clone(unit.cashEntries),
    recordType: 'ECONOMIC_CASH_LEDGER',
    resolvedUnitId: unit.meta.resolvedUnitId,
    ...(unit.meta.strategy === 'COVERED_CALL' ? { shareSaleCashEntryIds: [] } : {}),
    summary: {},
  };
}

function makeShares(unit, parent) {
  if (unit.meta.strategy === 'CASH_SECURED_PUT') {
    return {
      accountId: unit.meta.accountId,
      economicEpisodeId: unit.meta.economicEpisodeId,
      lots: clone(unit.lots),
      movements: clone(unit.shareMovements),
      parentAssignmentEventId: unit.terminalEvents
        .find((event) => event.eventType === 'PARTIAL_PUT_ASSIGNMENT').terminalEventId,
      recordType: 'SHARE_INVENTORY_LEDGER',
      resolvedUnitId: unit.meta.resolvedUnitId,
      shareLotIds: unit.lots.map((lot) => lot.shareLotId),
      shareMovementIds: unit.shareMovements.map((movement) => movement.shareMovementId),
      summary: {},
      symbol: unit.meta.symbol,
    };
  }
  const openingLots = parent.lots.map((lot) => ({
    quantityShares: lot.quantityShares,
    shareLotId: lot.shareLotId,
    state: 'AVAILABLE',
    totalLotCostUsd: lot.totalLotCostUsd,
  }));
  return {
    accountId: unit.meta.accountId,
    closingLots: clone(openingLots),
    economicEpisodeId: unit.meta.economicEpisodeId,
    movements: clone(unit.shareMovements),
    newShareLotIds: [],
    openingLots: clone(openingLots),
    openingShareLotIds: openingLots.map((lot) => lot.shareLotId),
    parentResolvedUnitId: unit.meta.parentResolvedUnitId,
    recordType: 'SHARE_INVENTORY_LEDGER_CONTINUATION',
    resolvedUnitId: unit.meta.resolvedUnitId,
    shareDeliveryMovementIds: [],
    shareMovementIds: unit.shareMovements.map((movement) => movement.shareMovementId),
    shareSaleMovementIds: [],
    summary: {},
    symbol: unit.meta.symbol,
  };
}

function pnlLines(strategy) {
  const names = strategy === 'CASH_SECURED_PUT' ? [
    'OPTION_REALIZED_PNL',
    'REMAINING_SHARE_INVENTORY_COST',
    'REMAINING_SHARE_MARK_VALUE',
    'UNREALIZED_SHARE_PNL',
    'TOTAL_REALIZED_PNL',
    'TOTAL_MARKED_EPISODE_PNL',
  ] : [
    'COVERED_CALL_OPTION_REALIZED_PNL',
    'REMAINING_SHARE_INVENTORY_COST',
    'REMAINING_SHARE_MARK_VALUE',
    'UNREALIZED_SHARE_PNL',
    'CUMULATIVE_OPTION_REALIZED_PNL',
    'CUMULATIVE_MARKED_EPISODE_PNL',
  ];
  return names.map((name, index) => ({
    amountUsd: 0,
    name,
    pnlLineId: `PNL-LINE-${strategy}-${String(index + 1).padStart(2, '0')}`,
  }));
}

function makePnl(unit, shares) {
  invariant(unit.markEvent, `${unit.meta.resolvedUnitId}:MARK_REQUIRED`);
  return {
    cashEntryIds: unit.cashEntries.map((entry) => entry.cashEntryId),
    economicEpisodeId: unit.meta.economicEpisodeId,
    lines: pnlLines(unit.meta.strategy),
    markEvidence: {
      acquiredAt: unit.markEvent.acquiredAt,
      markEvidenceId: unit.markEvent.markEvidenceId,
      markUsdPerShare: unit.markEvent.markUsdPerShare,
      marketAdapterVersion: unit.markEvent.marketAdapterVersion,
      rawEvidenceSha256: unit.markEvent.rawEvidenceSha256,
      symbol: unit.meta.symbol,
      vendorAsOf: unit.markEvent.vendorAsOf,
    },
    pnlRecordId: unit.meta.pnlRecordId,
    recordType: 'PNL',
    resolvedUnitId: unit.meta.resolvedUnitId,
    shareLotIds: unit.meta.strategy === 'CASH_SECURED_PUT'
      ? shares.shareLotIds.slice() : shares.openingShareLotIds.slice(),
    summary: {},
    terminalEventIds: [
      ...unit.terminalEvents.map((event) => event.terminalEventId),
      unit.meta.terminalEventId,
    ],
  };
}

function buildBundle(unit, parent) {
  invariant(unit.proposalEvent, `${unit.meta.resolvedUnitId}:PROPOSAL_REQUIRED`);
  invariant(unit.fills.length > 0, `${unit.meta.resolvedUnitId}:FILL_REQUIRED`);
  invariant(unit.terminalEvents.length > 0, `${unit.meta.resolvedUnitId}:TERMINAL_EVENT_REQUIRED`);
  const decision = makeDecision(unit, parent);
  const proposal = makeProposal(unit, parent, decision);
  const shares = makeShares(unit, parent);
  return {
    'manifest.json': {
      authority: '2 / PROPOSE_ONLY',
      bundleSchemaVersion: 'E3_RESOLVED_UNIT_BUNDLE_V1',
      canonicalSerializationVersion: 'CANONICAL_JSON_SORTED_KEYS_V1',
      economicEpisodeId: unit.meta.economicEpisodeId,
      episodeStatus: 'PENDING_FOLD',
      manifestFile: {
        path: 'manifest.json',
        sha256Publication: 'OUT_OF_BAND_TO_AVOID_SELF_REFERENTIAL_HASH',
      },
      orderedFiles: placeholderOrderedFiles(),
      productionEffect: 'NONE',
      recordType: 'RESOLVED_UNIT_BUNDLE_MANIFEST',
      resolvedUnitId: unit.meta.resolvedUnitId,
      ...(unit.meta.parentResolvedUnitId
        ? { parentResolvedUnitId: unit.meta.parentResolvedUnitId }
        : {}),
      syntheticFixture: true,
      unitStatus: 'PENDING_FOLD',
    },
    'decision.json': decision,
    'proposal.json': proposal,
    'order-events.json': makeOrderEvents(unit),
    'fills.json': makeFills(unit),
    'cash.json': makeCash(unit),
    'shares.json': shares,
    'pnl.json': makePnl(unit, shares),
  };
}

export function fromBrokerEvents(inputEvents) {
  invariant(Array.isArray(inputEvents) && inputEvents.length > 0, 'NONEMPTY_EVENT_LIST_REQUIRED');
  const forbidden = forbiddenKeyPaths(inputEvents);
  invariant(forbidden.length === 0, `FORBIDDEN_KEYS:${forbidden.join(',')}`);
  const events = clone(inputEvents);
  invariant(events.every((event, index) => event.streamSequence === index + 1),
    'APPEND_SEQUENCE_NOT_CONTIGUOUS');
  const streamEventIds = events.map((event) => requireString(event.streamEventId, 'STREAM_EVENT_ID'));
  invariant(new Set(streamEventIds).size === streamEventIds.length, 'DUPLICATE_STREAM_EVENT_ID');

  const units = new Map();
  const unitOrder = [];
  for (const event of events) {
    if (event.eventType === 'UNIT_OPENED') {
      requireString(event.resolvedUnitId, 'RESOLVED_UNIT_ID');
      invariant(!units.has(event.resolvedUnitId), 'DUPLICATE_UNIT_OPENED');
      invariant(['CASH_SECURED_PUT', 'COVERED_CALL'].includes(event.strategy),
        'UNSUPPORTED_STRATEGY');
      const unit = newUnit(event);
      units.set(event.resolvedUnitId, unit);
      unitOrder.push(unit);
      continue;
    }

    const unit = units.get(event.resolvedUnitId);
    invariant(unit, `${event.resolvedUnitId}:UNIT_MUST_OPEN_FIRST`);
    const parent = unit.meta.parentResolvedUnitId
      ? units.get(unit.meta.parentResolvedUnitId) : null;
    switch (event.eventType) {
      case 'DECISION_SEALED':
        invariant(!unit.decisionEvent, `${event.resolvedUnitId}:DUPLICATE_DECISION`);
        unit.decisionEvent = clone(event);
        break;
      case 'PROPOSAL_SEALED':
        invariant(!unit.proposalEvent, `${event.resolvedUnitId}:DUPLICATE_PROPOSAL`);
        unit.proposalEvent = clone(event);
        break;
      case 'ORDER_SUBMITTED':
        invariant(unit.proposalEvent, `${event.resolvedUnitId}:PROPOSAL_REQUIRED_BEFORE_ORDER`);
        invariant(!unit.order, `${event.resolvedUnitId}:DUPLICATE_ORDER`);
        unit.order = {
          accountId: unit.meta.accountId,
          authorizationRecordId: event.authorizationRecordId,
          authorizationType: 'HUMAN_SUBMIT_FIXTURE_ONLY',
          brokerAdapterVersion: event.brokerAdapterVersion,
          brokerOrderId: event.brokerOrderId,
          canonicalRequestSha256: event.canonicalRequestSha256,
          clientOrderId: event.clientOrderId,
          duration: unit.proposalEvent.orderInstruction.duration,
          limitUsdPerShare: unit.proposalEvent.orderInstruction.limitUsdPerShare,
          parentProposalHash: unit.proposalEvent.proposalHash,
          positionContractHash: unit.proposalEvent.positionContractHash,
          quantityContracts: unit.proposalEvent.contract.quantityContracts,
          submittedAt: event.submittedAt,
          type: unit.proposalEvent.orderInstruction.type,
        };
        break;
      case 'BROKER_ACKNOWLEDGEMENT':
        appendBrokerEvent(unit, event, {
          acknowledgedQuantityContracts: event.acknowledgedQuantityContracts,
          eventType: 'ACKNOWLEDGEMENT',
        });
        break;
      case 'BROKER_FILL':
        applyFill(unit, event);
        break;
      case 'PUT_ASSIGNMENT':
        applyPutAssignment(unit, event);
        break;
      case 'OPTION_EXPIRY':
      case 'CALL_EXPIRY':
        applyExpiry(unit, event);
        break;
      case 'SHARES_RESERVED':
        applyReservation(unit, event, parent);
        break;
      case 'MARK_OBSERVED':
        invariant(!unit.markEvent, `${event.resolvedUnitId}:DUPLICATE_MARK`);
        unit.markEvent = clone(event);
        break;
      default:
        throw new Error(`BROKER_EVENT_ADAPTER:UNSUPPORTED_EVENT_TYPE:${event.eventType}`);
    }
  }

  invariant(unitOrder.length === 2, 'EXACTLY_TWO_RESOLVED_UNITS_REQUIRED');
  invariant(unitOrder[0].meta.strategy === 'CASH_SECURED_PUT'
    && unitOrder[1].meta.strategy === 'COVERED_CALL', 'CSP_THEN_COVERED_CALL_REQUIRED');
  invariant(unitOrder[1].meta.parentResolvedUnitId === unitOrder[0].meta.resolvedUnitId,
    'COVERED_CALL_PARENT_UNIT_MISMATCH');
  return [buildBundle(unitOrder[0], null), buildBundle(unitOrder[1], unitOrder[0])];
}

/**
 * Admit the narrow append-only equity stream used by LANE_1_SPY. Shares are
 * kept in their own grammar instead of being disguised as option contracts.
 */
export function fromEquityBrokerEvents(rawEvents) {
  invariant(Array.isArray(rawEvents) && rawEvents.length >= 4,
    'EQUITY_STREAM_EVENTS_REQUIRED');
  const forbidden = forbiddenKeyPaths(rawEvents);
  invariant(forbidden.length === 0, `FORBIDDEN_KEYS:${forbidden.join(',')}`);
  const events = clone(rawEvents);
  const sequences = events.map((event) => event.appendSequence);
  invariant(sequences.every((value) => Number.isInteger(value) && value > 0),
    'EQUITY_APPEND_SEQUENCE_REQUIRED');
  invariant(sequences.every((value, index) => index === 0 || value > sequences[index - 1]),
    'EQUITY_APPEND_ORDER_INVALID');

  const opened = events[0];
  invariant(opened.eventType === 'UNIT_OPENED', 'EQUITY_UNIT_MUST_OPEN_FIRST');
  invariant(opened.symbol === 'SPY' && opened.quantityShares === 1,
    'LANE_1_SPY_EXACT_SHARE_REQUIRED');
  requireString(opened.economicEpisodeId, 'ECONOMIC_EPISODE_ID');
  requireString(opened.resolvedUnitId, 'RESOLVED_UNIT_ID');

  const proposals = events.filter((event) => event.eventType === 'PROPOSAL_SEALED');
  const accepted = events.filter((event) => event.eventType === 'ORDER_ACCEPTED');
  const fills = events.filter((event) => event.eventType === 'EQUITY_FILL');
  const protectiveAccepted = events.filter((event) => event.eventType === 'PROTECTIVE_STOP_ACCEPTED');
  invariant(proposals.length >= 1 && proposals.length <= 2, 'EQUITY_PROPOSAL_COUNT_INVALID');
  invariant(accepted.length === proposals.length, 'EQUITY_ACCEPTED_ORDER_COUNT_INVALID');
  invariant([1, 2].includes(fills.length), 'EQUITY_FILL_COUNT_INVALID');
  invariant(fills.length <= proposals.length
    || (fills.length === 2 && proposals.length === 1 && protectiveAccepted.length === 1
      && String(fills[1].brokerOrderId) === String(protectiveAccepted[0].brokerOrderId)),
  'EQUITY_FILL_AUTHORIZATION_INVALID');

  const fillIds = new Set();
  for (const fill of fills) {
    requireString(fill.fillId, 'MISSING_FILL_ID');
    invariant(!fillIds.has(fill.fillId), `FILL_${fill.fillId}:DUPLICATE`);
    fillIds.add(fill.fillId);
    invariant(fill.symbol === 'SPY' && fill.quantityShares === 1,
      'LANE_1_SPY_EXACT_FILL_REQUIRED');
    invariant(['BUY', 'SELL', 'SELL_SHORT', 'BUY_TO_COVER'].includes(fill.side),
      'EQUITY_FILL_SIDE_INVALID');
    invariant(Number.isFinite(fill.executionPriceUsdPerShare)
      && fill.executionPriceUsdPerShare > 0, 'EQUITY_FILL_PRICE_INVALID');
    invariant(Number.isSafeInteger(fill.feeCents) && fill.feeCents <= 0, 'MISSING_FEE');
    requireString(fill.brokerOrderId, 'MISSING_ORDER_ID');
    requireString(fill.clientOrderId, 'MISSING_CLIENT_ORDER_ID');
    requireString(fill.brokerOccurredAt, 'MISSING_BROKER_OCCURRED_AT');
    requireString(fill.acquiredAt, 'MISSING_ACQUIRED_AT');
    requireString(fill.rawBrokerEvidenceSha256, 'MISSING_RAW_EVIDENCE_HASH');
  }
  invariant(['BUY', 'SELL_SHORT'].includes(fills[0].side),
    'EQUITY_FIRST_FILL_MUST_OPEN');
  if (fills.length === 2) {
    const requiredClose = fills[0].side === 'BUY' ? 'SELL' : 'BUY_TO_COVER';
    invariant(fills[1].side === requiredClose, 'EQUITY_SECOND_FILL_MUST_CLOSE');
  }

  const supported = new Set(['UNIT_OPENED', 'PROPOSAL_SEALED', 'ORDER_ACCEPTED', 'EQUITY_FILL',
    'PROTECTIVE_STOP_ACCEPTED', 'PROTECTIVE_STOP_CANCELED']);
  invariant(events.every((event) => supported.has(event.eventType)),
    'EQUITY_UNSUPPORTED_EVENT_TYPE');
  return {
    economicEpisodeId: opened.economicEpisodeId,
    resolvedUnitId: opened.resolvedUnitId,
    symbol: 'SPY',
    quantityShares: 1,
    events,
    proposals,
    accepted,
    fills,
  };
}
