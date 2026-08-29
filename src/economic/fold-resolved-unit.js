import {
  MONEY_CENTS_ROUNDING_RULE, centsToDecimal, netMoneyCents,
} from './money-cents.js';

const REQUIRED_FILES = Object.freeze([
  'manifest.json',
  'decision.json',
  'proposal.json',
  'order-events.json',
  'fills.json',
  'cash.json',
  'shares.json',
  'pnl.json',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(`RESOLVED_UNIT_FOLD:${message}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function same(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function cents(value, label) {
  invariant(typeof value === 'number' && Number.isFinite(value), `${label}:FINITE_NUMBER_REQUIRED`);
  return Math.round(value * 100);
}

function moneyFromCents(value) {
  return Number((value / 100).toFixed(2));
}

function sumMoney(records, selector, label) {
  return records.reduce((total, record) => total + cents(selector(record), label), 0);
}

function setExisting(record, key, value) {
  if (Object.hasOwn(record, key)) record[key] = value;
}

function setPnlLine(lines, name, field, value) {
  const matches = lines.filter((line) => line.name === name);
  invariant(matches.length === 1, `PNL_LINE_${name}:EXPECTED_ONE`);
  matches[0][field] = value;
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

function validateEnvelope(bundle) {
  invariant(bundle && typeof bundle === 'object' && !Array.isArray(bundle), 'BUNDLE_OBJECT_REQUIRED');
  invariant(same(Object.keys(bundle).sort(), REQUIRED_FILES.slice().sort()), 'EXACT_FILE_SET_REQUIRED');

  const manifest = bundle['manifest.json'];
  const episodeId = manifest.economicEpisodeId;
  const unitId = manifest.resolvedUnitId;
  invariant(typeof episodeId === 'string' && episodeId.length > 0, 'ECONOMIC_EPISODE_ID_REQUIRED');
  invariant(typeof unitId === 'string' && unitId.length > 0, 'RESOLVED_UNIT_ID_REQUIRED');

  for (const [name, record] of Object.entries(bundle)) {
    invariant(record && typeof record === 'object' && !Array.isArray(record), `${name}:OBJECT_REQUIRED`);
    if (Object.hasOwn(record, 'economicEpisodeId')) {
      invariant(record.economicEpisodeId === episodeId, `${name}:EPISODE_ID_MISMATCH`);
    }
    if (Object.hasOwn(record, 'resolvedUnitId')) {
      invariant(record.resolvedUnitId === unitId, `${name}:UNIT_ID_MISMATCH`);
    }
  }

  const forbidden = Object.entries(bundle)
    .flatMap(([name, record]) => forbiddenKeyPaths(record, `$[${name}]`));
  invariant(forbidden.length === 0, `FORBIDDEN_KEYS:${forbidden.join(',')}`);
}

function foldFills(bundle) {
  const orderEvents = bundle['order-events.json'];
  const fillsRecord = bundle['fills.json'];
  const fills = fillsRecord.fills;
  const appendLog = orderEvents.appendLog;
  invariant(Array.isArray(fills) && fills.length > 0, 'FILLS_REQUIRED');
  invariant(Array.isArray(appendLog) && appendLog.length > 0, 'ORDER_EVENTS_REQUIRED');

  const fillIds = fills.map((fill) => fill.fillId);
  invariant(fillIds.every((fillId) => typeof fillId === 'string' && fillId.length > 0),
    'FILL_ID_REQUIRED');
  invariant(new Set(fillIds).size === fillIds.length, 'DUPLICATE_FILL_ID');
  invariant(new Set(fills.map((fill) => fill.canonicalDeduplicationSha256)).size === fills.length,
    'DUPLICATE_FILL_DEDUPLICATION_HASH');

  const appendFillIds = appendLog
    .filter((event) => event.eventType === 'FILL')
    .map((event) => event.fillId);
  invariant(same(appendFillIds, fillIds), 'FILL_ACQUISITION_ORDER_MISMATCH');
  invariant(same(appendLog.map((event) => event.appendSequence),
    appendLog.map((_, index) => index + 1)), 'APPEND_SEQUENCE_NOT_CONTIGUOUS');

  const submittedContracts = orderEvents.order.quantityContracts;
  const filledContracts = fills.reduce((total, fill) => total + fill.quantityContracts, 0);
  const grossPremiumCents = sumMoney(fills, (fill) => fill.grossPremiumUsd, 'FILL_PREMIUM');
  const openingFeeCents = sumMoney(fills, (fill) => fill.feeUsd, 'FILL_FEE');
  const weightedPrice = fills.reduce(
    (total, fill) => total + fill.executionPriceUsdPerShare * fill.quantityContracts,
    0,
  ) / filledContracts;

  Object.assign(fillsRecord.fillReconciliation, {
    submittedContracts,
    filledContracts,
    remainingOrderContracts: submittedContracts - filledContracts,
    grossPremiumUsd: moneyFromCents(grossPremiumCents),
    openingFillFeesUsd: moneyFromCents(openingFeeCents),
    grossWeightedFillPriceUsdPerShare: Number(weightedPrice.toFixed(10)),
  });

  const terminalEvents = fillsRecord.lifecycle.terminalEvents;
  invariant(Array.isArray(terminalEvents) && terminalEvents.length > 0, 'TERMINAL_EVENTS_REQUIRED');
  const assignedContracts = terminalEvents.reduce(
    (total, event) => total + Number(event.assignedContracts ?? 0), 0,
  );
  const expiredContracts = terminalEvents.reduce(
    (total, event) => total + Number(event.expiredContracts ?? 0), 0,
  );
  const sharesCreated = terminalEvents.reduce(
    (total, event) => total + Number(event.sharesReceived ?? event.sharesCreated ?? 0), 0,
  );
  const sharesDelivered = terminalEvents.reduce(
    (total, event) => total + Number(event.sharesDelivered ?? 0), 0,
  );
  const remainingContracts = filledContracts - assignedContracts - expiredContracts;
  invariant(remainingContracts === 0, 'OPTION_POSITION_NOT_TERMINAL');

  Object.assign(fillsRecord.position, {
    openedShortContracts: filledContracts,
    assignedContracts,
    expiredContracts,
    remainingOptionContracts: remainingContracts,
    grossPremiumUsd: moneyFromCents(grossPremiumCents),
    openingFeesUsd: moneyFromCents(openingFeeCents),
    lifecycleStatus: 'TERMINAL',
  });

  const terminalSummary = fillsRecord.lifecycle.terminalSummary;
  setExisting(terminalSummary, 'openedContracts', filledContracts);
  setExisting(terminalSummary, 'assignedContracts', assignedContracts);
  setExisting(terminalSummary, 'expiredContracts', expiredContracts);
  setExisting(terminalSummary, 'remainingContracts', remainingContracts);
  setExisting(terminalSummary, 'sharesCreated', sharesCreated);
  setExisting(terminalSummary, 'sharesDelivered', sharesDelivered);

  return { filledContracts, grossPremiumCents, openingFeeCents, assignedContracts, expiredContracts };
}

function cashLineCents(entries, line) {
  return sumMoney(entries.filter((entry) => entry.line === line), (entry) => entry.amount,
    `CASH_LINE_${line}`);
}

function foldCash(bundle, strategy, parentBundle) {
  const cash = bundle['cash.json'];
  const entries = cash.entries;
  invariant(Array.isArray(entries) && entries.length > 0, 'CASH_ENTRIES_REQUIRED');
  const ids = entries.map((entry) => entry.cashEntryId);
  invariant(ids.every((id) => typeof id === 'string' && id.length > 0), 'CASH_ENTRY_ID_REQUIRED');
  invariant(new Set(ids).size === ids.length, 'DUPLICATE_CASH_ENTRY_ID');
  invariant(same(ids, cash.cashEntryIds), 'CASH_ENTRY_ID_ORDER_MISMATCH');
  const netCents = sumMoney(entries, (entry) => entry.amount, 'CASH_ENTRY_AMOUNT');

  if (strategy === 'CASH_SECURED_PUT') {
    Object.assign(cash.summary, {
      grossOptionPremiumUsd: moneyFromCents(cashLineCents(entries, 'OPTION_PREMIUM_RECEIPT')),
      openingFillFeesUsd: moneyFromCents(cashLineCents(entries, 'OPENING_FILL_FEE')),
      putAssignmentStrikeDebitUsd: moneyFromCents(
        cashLineCents(entries, 'PUT_ASSIGNMENT_STRIKE_DEBIT'),
      ),
      putAssignmentFeeUsd: moneyFromCents(cashLineCents(entries, 'PUT_ASSIGNMENT_FEE')),
      netCashMovementUsd: moneyFromCents(netCents),
    });
  } else {
    invariant(parentBundle, 'COVERED_CALL_PARENT_BUNDLE_REQUIRED');
    const parentNetCents = cents(
      parentBundle['cash.json'].summary.netCashMovementUsd,
      'PARENT_NET_CASH',
    );
    Object.assign(cash.summary, {
      coveredCallPremiumGrossUsd: moneyFromCents(
        cashLineCents(entries, 'COVERED_CALL_PREMIUM_RECEIPT'),
      ),
      openingFillFeesUsd: moneyFromCents(
        cashLineCents(entries, 'COVERED_CALL_OPENING_FILL_FEE'),
      ),
      shareSaleProceedsUsd: moneyFromCents(cashLineCents(entries, 'SHARE_SALE_PROCEEDS')),
      continuationNetCashMovementUsd: moneyFromCents(netCents),
      parentNetCashMovementUsd: moneyFromCents(parentNetCents),
      cumulativeEpisodeNetCashMovementUsd: moneyFromCents(parentNetCents + netCents),
    });
  }
  return netCents;
}

function foldShares(bundle, strategy, parentBundle) {
  const shares = bundle['shares.json'];
  if (strategy === 'CASH_SECURED_PUT') {
    invariant(Array.isArray(shares.lots) && shares.lots.length > 0, 'ASSIGNMENT_SHARE_LOTS_REQUIRED');
    const lotIds = shares.lots.map((lot) => lot.shareLotId);
    invariant(new Set(lotIds).size === lotIds.length, 'DUPLICATE_SHARE_LOT_ID');
    invariant(same(lotIds, shares.shareLotIds), 'SHARE_LOT_ID_ORDER_MISMATCH');
    const remainingShares = shares.lots.reduce((total, lot) => total + lot.quantityShares, 0);
    const inventoryCostCents = sumMoney(shares.lots, (lot) => lot.totalLotCostUsd,
      'SHARE_LOT_COST');
    Object.assign(shares.summary, {
      sharesCreated: remainingShares,
      sharesRemaining: remainingShares,
      deliverableShares: shares.lots
        .filter((lot) => lot.state === 'AVAILABLE')
        .reduce((total, lot) => total + lot.quantityShares, 0),
      coveredCallReservedShares: 0,
      strikeCostUsd: moneyFromCents(sumMoney(shares.lots, (lot) => lot.strikeCostUsd,
        'SHARE_STRIKE_COST')),
      assignmentFeesAllocatedUsd: moneyFromCents(sumMoney(
        shares.lots, (lot) => lot.allocatedAssignmentFeeUsd, 'SHARE_ASSIGNMENT_FEE',
      )),
      remainingShareInventoryCostUsd: moneyFromCents(inventoryCostCents),
      episodeStatus: remainingShares > 0 ? 'OPEN_SHARES' : 'CLOSED',
    });
    return { lotIds, remainingShares, inventoryCostCents };
  }

  invariant(parentBundle, 'COVERED_CALL_PARENT_BUNDLE_REQUIRED');
  const parentShares = parentBundle['shares.json'];
  const parentLotIds = parentShares.shareLotIds;
  invariant(same(shares.openingShareLotIds, parentLotIds), 'COVERED_CALL_PARENT_LOTS_MISMATCH');
  invariant(same(shares.closingLots.map((lot) => lot.shareLotId), parentLotIds),
    'COVERED_CALL_CLOSING_LOTS_MISMATCH');
  invariant(same(shares.newShareLotIds, []), 'COVERED_CALL_MUST_NOT_CREATE_SHARE_LOTS');
  invariant(same(shares.shareSaleMovementIds, []), 'EXPIRED_CALL_MUST_NOT_SELL_SHARES');
  invariant(same(shares.shareDeliveryMovementIds, []), 'EXPIRED_CALL_MUST_NOT_DELIVER_SHARES');

  const reserveMovements = shares.movements.filter((movement) => movement.action === 'RESERVE_COVERED_CALL');
  const releaseMovements = shares.movements.filter((movement) => movement.action === 'RELEASE_COVERED_CALL');
  invariant(same(reserveMovements.map((movement) => movement.shareLotId), parentLotIds),
    'COVERED_CALL_RESERVATION_LOTS_MISMATCH');
  invariant(same(releaseMovements.map((movement) => movement.shareLotId), parentLotIds),
    'COVERED_CALL_RELEASE_LOTS_MISMATCH');
  invariant(reserveMovements.reduce((total, movement) => total + movement.quantityShares, 0) === 200,
    'COVERED_CALL_RESERVED_SHARE_QUANTITY_INVALID');
  invariant(releaseMovements.reduce((total, movement) => total + movement.quantityShares, 0) === 200,
    'COVERED_CALL_RELEASED_SHARE_QUANTITY_INVALID');

  const remainingShares = shares.closingLots.reduce((total, lot) => total + lot.quantityShares, 0);
  const inventoryCostCents = sumMoney(shares.closingLots, (lot) => lot.totalLotCostUsd,
    'COVERED_CALL_SHARE_LOT_COST');
  Object.assign(shares.summary, {
    durableLotCount: shares.closingLots.length,
    newShareLotsCreated: 0,
    sharesAtStart: parentShares.summary.sharesRemaining,
    sharesCreated: 0,
    sharesDelivered: 0,
    sharesSold: 0,
    sharesRemaining: remainingShares,
    deliverableShares: remainingShares,
    reservedShares: 0,
    remainingShareInventoryCostUsd: moneyFromCents(inventoryCostCents),
    episodeStatus: remainingShares > 0 ? 'OPEN_SHARES' : 'CLOSED',
  });
  return { lotIds: parentLotIds, remainingShares, inventoryCostCents };
}

function foldPnl(bundle, strategy, cashNetCents, shareFold, parentBundle) {
  const pnl = bundle['pnl.json'];
  invariant(Array.isArray(pnl.lines), 'PNL_LINES_REQUIRED');
  const markCents = cents(pnl.markEvidence.markUsdPerShare, 'SHARE_MARK');
  const markValueCents = shareFold.remainingShares * markCents;
  const unrealizedCents = markValueCents - shareFold.inventoryCostCents;

  if (strategy === 'CASH_SECURED_PUT') {
    const realizedCents = cashLineCents(
      bundle['cash.json'].entries,
      'OPTION_PREMIUM_RECEIPT',
    ) + cashLineCents(bundle['cash.json'].entries, 'OPENING_FILL_FEE');
    const totalMarkedCents = realizedCents + unrealizedCents;
    setPnlLine(pnl.lines, 'OPTION_REALIZED_PNL', 'amountUsd', moneyFromCents(realizedCents));
    setPnlLine(pnl.lines, 'REMAINING_SHARE_INVENTORY_COST', 'amountUsd',
      moneyFromCents(shareFold.inventoryCostCents));
    setPnlLine(pnl.lines, 'REMAINING_SHARE_MARK_VALUE', 'amountUsd', moneyFromCents(markValueCents));
    setPnlLine(pnl.lines, 'UNREALIZED_SHARE_PNL', 'amountUsd', moneyFromCents(unrealizedCents));
    setPnlLine(pnl.lines, 'TOTAL_REALIZED_PNL', 'amountUsd', moneyFromCents(realizedCents));
    setPnlLine(pnl.lines, 'TOTAL_MARKED_EPISODE_PNL', 'amountUsd', moneyFromCents(totalMarkedCents));
    Object.assign(pnl.summary, {
      optionRealizedPnlUsd: moneyFromCents(realizedCents),
      remainingShareInventoryCostUsd: moneyFromCents(shareFold.inventoryCostCents),
      unrealizedSharePnlUsd: moneyFromCents(unrealizedCents),
      totalMarkedEpisodePnlUsd: moneyFromCents(totalMarkedCents),
      unitStatus: 'RESOLVED_ASSIGNMENT_TO_INVENTORY',
      episodeStatus: 'OPEN_SHARES',
    });
    return;
  }

  invariant(parentBundle, 'COVERED_CALL_PARENT_BUNDLE_REQUIRED');
  const parentRealizedCents = cents(
    parentBundle['pnl.json'].summary.optionRealizedPnlUsd,
    'PARENT_OPTION_REALIZED_PNL',
  );
  const callRealizedCents = cashNetCents;
  const cumulativeRealizedCents = parentRealizedCents + callRealizedCents;
  const cumulativeMarkedCents = cumulativeRealizedCents + unrealizedCents;
  setPnlLine(pnl.lines, 'COVERED_CALL_OPTION_REALIZED_PNL', 'amountUsd',
    moneyFromCents(callRealizedCents));
  setPnlLine(pnl.lines, 'REMAINING_SHARE_INVENTORY_COST', 'amountUsd',
    moneyFromCents(shareFold.inventoryCostCents));
  setPnlLine(pnl.lines, 'REMAINING_SHARE_MARK_VALUE', 'amountUsd', moneyFromCents(markValueCents));
  setPnlLine(pnl.lines, 'UNREALIZED_SHARE_PNL', 'amountUsd', moneyFromCents(unrealizedCents));
  setPnlLine(pnl.lines, 'CUMULATIVE_OPTION_REALIZED_PNL', 'amountUsd',
    moneyFromCents(cumulativeRealizedCents));
  setPnlLine(pnl.lines, 'CUMULATIVE_MARKED_EPISODE_PNL', 'amountUsd',
    moneyFromCents(cumulativeMarkedCents));
  Object.assign(pnl.summary, {
    coveredCallOptionRealizedPnlUsd: moneyFromCents(callRealizedCents),
    parentOptionRealizedPnlUsd: moneyFromCents(parentRealizedCents),
    cumulativeOptionRealizedPnlUsd: moneyFromCents(cumulativeRealizedCents),
    shareSaleProceedsUsd: 0,
    sharesDelivered: 0,
    remainingShares: shareFold.remainingShares,
    remainingShareInventoryCostUsd: moneyFromCents(shareFold.inventoryCostCents),
    unrealizedSharePnlUsd: moneyFromCents(unrealizedCents),
    cumulativeMarkedEpisodePnlUsd: moneyFromCents(cumulativeMarkedCents),
    unitStatus: 'RESOLVED_EXPIRED',
    episodeStatus: 'OPEN_SHARES',
  });
}

function enforceCoverage(bundle, strategy, shareFold) {
  if (strategy !== 'COVERED_CALL') return;
  const decision = bundle['decision.json'];
  const proposal = bundle['proposal.json'];
  const multiplier = proposal.contract.contractMultiplierShares;
  const proposedContracts = proposal.contract.quantityContracts;
  const requiredShares = proposedContracts * multiplier;
  invariant(requiredShares <= shareFold.remainingShares, 'COVERED_CALL_INSUFFICIENT_DELIVERABLE_SHARES');
  invariant(same(proposal.coverage.referencedShareLotIds, shareFold.lotIds),
    'COVERED_CALL_SHARE_LOT_REFERENCE_MISMATCH');
  invariant(proposal.coverage.inventedShares === 0, 'COVERED_CALL_INVENTED_SHARES');

  const fault = decision.thirdCallFault;
  invariant(fault.outcome === 'FAULT', 'THIRD_CALL_MUST_FAULT');
  invariant(fault.faultCode === 'COVERED_CALL_INSUFFICIENT_DELIVERABLE_SHARES',
    'THIRD_CALL_FAULT_CODE_INVALID');
  invariant(fault.requiredShares > fault.deliverableShares, 'THIRD_CALL_NOT_ACTUALLY_UNCOVERED');
  invariant(fault.proposalCreated === false && fault.orderCreated === false
    && fault.reservationCreated === false, 'THIRD_CALL_FAULT_HAS_SIDE_EFFECTS');
}

export function foldResolvedUnit(inputBundle, { parentBundle = null } = {}) {
  validateEnvelope(inputBundle);
  const bundle = clone(inputBundle);
  const strategy = bundle['decision.json'].strategy;
  invariant(['CASH_SECURED_PUT', 'COVERED_CALL'].includes(strategy), 'UNSUPPORTED_STRATEGY');

  if (parentBundle) validateEnvelope(parentBundle);
  if (strategy === 'COVERED_CALL') {
    invariant(parentBundle, 'COVERED_CALL_PARENT_BUNDLE_REQUIRED');
    invariant(parentBundle['manifest.json'].economicEpisodeId
      === bundle['manifest.json'].economicEpisodeId, 'COVERED_CALL_EPISODE_MISMATCH');
  }

  foldFills(bundle);
  const cashNetCents = foldCash(bundle, strategy, parentBundle);
  const shareFold = foldShares(bundle, strategy, parentBundle);
  enforceCoverage(bundle, strategy, shareFold);
  foldPnl(bundle, strategy, cashNetCents, shareFold, parentBundle);

  const terminalSummary = bundle['fills.json'].lifecycle.terminalSummary;
  const unitStatus = strategy === 'CASH_SECURED_PUT'
    ? 'RESOLVED_ASSIGNMENT_TO_INVENTORY' : 'RESOLVED_EXPIRED';
  Object.assign(terminalSummary, {
    sharesRemaining: shareFold.remainingShares,
    unitStatus,
    episodeStatus: 'OPEN_SHARES',
  });
  Object.assign(bundle['manifest.json'], { unitStatus, episodeStatus: 'OPEN_SHARES' });

  validateEnvelope(bundle);
  return bundle;
}

export function foldResolvedEpisode(inputBundles) {
  invariant(Array.isArray(inputBundles) && inputBundles.length === 2,
    'EXACTLY_TWO_INPUT_BUNDLES_REQUIRED');
  const firstUnit = foldResolvedUnit(inputBundles[0]);
  const coveredCallContinuation = foldResolvedUnit(inputBundles[1], { parentBundle: firstUnit });
  return { firstUnit, coveredCallContinuation };
}

/** Fold the admitted LANE_1_SPY append stream into the canonical eight files. */
export function foldEquityRoundTrip(input) {
  invariant(input?.symbol === 'SPY' && input?.quantityShares === 1,
    'LANE_1_SPY_EXACT_SHARE_REQUIRED');
  invariant(Array.isArray(input.fills) && [1, 2].includes(input.fills.length),
    'LANE_1_SPY_FILL_COUNT_INVALID');
  const opening = input.fills[0];
  const closing = input.fills[1] ?? null;
  invariant(['BUY', 'SELL_SHORT'].includes(opening.side), 'LANE_1_SPY_OPEN_REQUIRED');
  const positionSide = opening.side === 'BUY' ? 'LONG' : 'SHORT';
  if (closing) invariant(closing.side === (positionSide === 'LONG' ? 'SELL' : 'BUY_TO_COVER'),
    'LANE_1_SPY_CLOSE_REQUIRED');

  const status = closing ? 'RESOLVED_FLAT' : `OPEN_${positionSide}`;
  const executionSign = (side) => ['BUY', 'BUY_TO_COVER'].includes(side) ? -1 : 1;
  const signedExecutionTerms = input.fills.map((fill) => ({
    value: fill.executionPriceUsdPerShare,
    multiplier: executionSign(fill.side) * fill.quantityShares,
  }));
  const feeTerms = input.fills.map((fill) => ({ value: centsToDecimal(fill.feeCents) }));
  const netCashMovementCents = netMoneyCents([...signedExecutionTerms, ...feeTerms]);
  const totalFeesCents = netMoneyCents(feeTerms);
  const realizedPnlCents = closing ? netCashMovementCents : null;
  const lotId = `LOT-${opening.fillId}`;
  const proposals = input.proposals.map((event) => clone(event.proposal));
  const orders = input.accepted.map((event) => ({
    brokerOrderId: event.brokerOrderId,
    clientOrderId: event.clientOrderId,
    acceptedAt: event.acceptedAt,
    side: event.side,
  }));
  const cashLines = input.fills.flatMap((fill) => [
    {
      cashEntryId: `CASH-${fill.fillId}-GROSS`,
      line: ['BUY', 'BUY_TO_COVER'].includes(fill.side)
        ? 'EQUITY_PURCHASE_DEBIT' : 'EQUITY_SALE_PROCEEDS',
      amountCents: netMoneyCents([{
        value: fill.executionPriceUsdPerShare,
        multiplier: executionSign(fill.side) * fill.quantityShares,
      }]),
      sourceFillId: fill.fillId,
    },
    {
      cashEntryId: `CASH-${fill.fillId}-FEE`,
      line: ['BUY', 'BUY_TO_COVER'].includes(fill.side) ? 'EQUITY_BUY_FEE' : 'EQUITY_SELL_FEE',
      amountCents: fill.feeCents,
      sourceFillId: fill.fillId,
    },
  ]);
  const orderedFiles = [
    'decision.json', 'proposal.json', 'order-events.json', 'fills.json',
    'cash.json', 'shares.json', 'pnl.json',
  ].map((path, index) => ({ path, sequence: index + 1, byteLength: 0, sha256: '0'.repeat(64) }));

  return {
    'manifest.json': {
      schemaVersion: 'E3_RESOLVED_UNIT_BUNDLE_V2_MONEY_CENTS',
      moneyContractVersion: 'MONEY_CENTS_V1',
      moneyRoundingRule: MONEY_CENTS_ROUNDING_RULE,
      recordType: 'RESOLVED_UNIT_MANIFEST',
      lane: 'LANE_1_SPY',
      economicEpisodeId: input.economicEpisodeId,
      resolvedUnitId: input.resolvedUnitId,
      symbol: 'SPY',
      quantityShares: 1,
      positionSide,
      status,
      orderedFiles,
    },
    'decision.json': {
      recordType: 'DECISION',
      lane: 'LANE_1_SPY',
      authority: {
        level: 2,
        name: 'PROPOSE_ONLY',
        executionException: 'LANE_1_SPY_PRINCIPAL_SIGNED_2026-08-28T01:30:00-07:00',
      },
      economicEpisodeId: input.economicEpisodeId,
      resolvedUnitId: input.resolvedUnitId,
      symbol: 'SPY',
      quantityShares: 1,
      positionSide,
      state: status,
      decisionIds: proposals.map((proposal) => proposal.decisionId),
    },
    'proposal.json': {
      recordType: 'SEALED_PROPOSALS',
      economicEpisodeId: input.economicEpisodeId,
      resolvedUnitId: input.resolvedUnitId,
      proposals,
    },
    'order-events.json': {
      recordType: 'APPEND_ONLY_ORDER_EVENTS',
      economicEpisodeId: input.economicEpisodeId,
      resolvedUnitId: input.resolvedUnitId,
      orders,
      appendLog: input.events.map((event) => clone(event)),
    },
    'fills.json': {
      recordType: 'FILLS',
      economicEpisodeId: input.economicEpisodeId,
      resolvedUnitId: input.resolvedUnitId,
      fillIds: input.fills.map((fill) => fill.fillId),
      fills: input.fills.map((fill) => clone(fill)),
      status,
    },
    'cash.json': {
      recordType: 'ECONOMIC_CASH_LEDGER',
      economicEpisodeId: input.economicEpisodeId,
      resolvedUnitId: input.resolvedUnitId,
      lines: cashLines,
      summary: {
        netCashMovementCents,
        totalFeesCents,
        roundingRule: MONEY_CENTS_ROUNDING_RULE,
      },
    },
    'shares.json': {
      recordType: 'SHARE_INVENTORY',
      economicEpisodeId: input.economicEpisodeId,
      resolvedUnitId: input.resolvedUnitId,
      lots: [{
        shareLotId: lotId,
        quantityShares: positionSide === 'LONG' ? 1 : -1,
        acquisitionFillId: positionSide === 'LONG' ? opening.fillId : null,
        shortSaleFillId: positionSide === 'SHORT' ? opening.fillId : null,
        dispositionFillId: closing?.fillId ?? null,
        costCents: positionSide === 'LONG' ? netMoneyCents([
          { value: opening.executionPriceUsdPerShare },
          { value: centsToDecimal(opening.feeCents), multiplier: -1 },
        ]) : null,
        openingCashCents: netMoneyCents([
          { value: opening.executionPriceUsdPerShare,
            multiplier: executionSign(opening.side) * opening.quantityShares },
          { value: centsToDecimal(opening.feeCents) },
        ]),
        state: closing ? 'CLOSED' : `OPEN_${positionSide}`,
      }],
      summary: {
        sharesRemaining: closing ? 0 : (positionSide === 'LONG' ? 1 : -1),
        state: closing ? 'CLOSED' : `OPEN_${positionSide}`,
      },
    },
    'pnl.json': {
      recordType: 'ECONOMIC_PNL',
      economicEpisodeId: input.economicEpisodeId,
      resolvedUnitId: input.resolvedUnitId,
      lines: [
        { line: positionSide === 'LONG' ? 'BUY_COST_WITH_FEE' : 'SHORT_SALE_PROCEEDS_WITH_FEE',
          amountCents: netMoneyCents([
          { value: opening.executionPriceUsdPerShare,
            multiplier: executionSign(opening.side) * opening.quantityShares },
          { value: centsToDecimal(opening.feeCents) },
        ]) },
        ...(closing ? [{ line: 'CLOSING_CASH_WITH_FEE', amountCents: netMoneyCents([
          { value: closing.executionPriceUsdPerShare,
            multiplier: executionSign(closing.side) * closing.quantityShares },
          { value: centsToDecimal(closing.feeCents) },
        ]) }] : []),
        { line: 'REALIZED_EQUITY_PNL', amountCents: realizedPnlCents },
      ],
      summary: {
        realizedPnlCents,
        status,
        roundingRule: MONEY_CENTS_ROUNDING_RULE,
      },
    },
  };
}
