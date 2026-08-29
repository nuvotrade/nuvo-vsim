const absent = (value) => value === null || value === undefined || value === '';

function numeric(value) {
  if (absent(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function canonicalQuantity(value) {
  const quantity = numeric(value);
  return quantity === null ? null : String(quantity);
}

function canonicalFillKey(order, leg) {
  const orderId = absent(order?.orderId) ? null : String(order.orderId);
  const executedAt = absent(leg?.time) ? null : String(leg.time);
  const quantity = canonicalQuantity(leg?.quantity);
  if (orderId === null || executedAt === null || quantity === null) return null;
  return `SCHWAB_FILL_CANONICAL|orderId=${encodeURIComponent(orderId)}`
    + `|executedAt=${encodeURIComponent(executedAt)}|qty=${encodeURIComponent(quantity)}`;
}

function identityCandidates(order, activity, leg) {
  const candidates = [];
  const add = (source, value) => {
    if (!absent(value)) candidates.push({ source, value: String(value) });
  };
  // Existing fixture bundles already carry a normalized fillId. Real Schwab
  // order activities begin with the documented broker-field precedence below.
  add('NORMALIZED_FILL_ID', leg.fillId);
  add('EXECUTION_ID', leg.executionId);
  add('ACTIVITY_ID', activity.activityId);
  add('ORDER_LEG_EXECUTION_ID', leg.orderLegExecutionId);
  add('CANONICAL_ORDER_TIME_QUANTITY', canonicalFillKey(order, leg));
  return candidates;
}

function feeArrays(order, activity, leg) {
  const directArrays = [
    leg.commissionFees,
    leg.fees,
    activity.commissionFees,
    activity.fees,
    order.commissionFees,
    order.fees,
  ].filter((value) => value !== undefined && value !== null);
  const orderId = absent(order?.orderId) ? null : String(order.orderId);
  const executedAt = absent(leg?.time) ? null : String(leg.time);
  const quantity = numeric(leg?.quantity);
  const price = numeric(leg?.price);
  if (orderId === null || executedAt === null || quantity === null || price === null) {
    return directArrays;
  }
  const transactions = (order.transactionActivityCollection ?? []).filter((transaction) => {
    if (String(transaction?.orderId ?? '') !== orderId
      || String(transaction?.time ?? transaction?.tradeDate ?? '') !== executedAt) return false;
    const securityItems = (transaction.transferItems ?? []).filter((item) => !item?.feeType);
    return securityItems.some((item) => Math.abs(numeric(item?.amount) ?? Number.NaN) === quantity
      && numeric(item?.price) === price);
  });
  if (transactions.length !== 1) return directArrays;
  const transactionFees = transactions[0].transferItems.filter((item) => !absent(item?.feeType));
  return transactionFees.length > 0 ? [...directArrays, transactionFees] : directArrays;
}

function feeItemValue(item) {
  if (typeof item === 'number' || typeof item === 'string') return numeric(item);
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  for (const field of ['amountUsd', 'cost', 'fee', 'commission']) {
    const value = numeric(item[field]);
    if (value !== null) return value;
  }
  return null;
}

function mappedFee(order, activity, leg) {
  const direct = numeric(leg.fee);
  if (direct !== null) return { ok: true, feeUsd: direct, feeSource: 'NORMALIZED_FEE' };

  for (const items of feeArrays(order, activity, leg)) {
    if (!Array.isArray(items) || items.length === 0) continue;
    const values = items.map(feeItemValue);
    if (values.some((value) => value === null)) continue;
    const total = Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100;
    if (Number.isFinite(total) && total <= 0) {
      return { ok: true, feeUsd: total, feeSource: 'SCHWAB_COMMISSION_FEE_ARRAY' };
    }
  }
  return { ok: false, faultCode: 'MISSING_FEE' };
}

function fault(faultCode, detail = null) {
  return Object.freeze({ ok: false, faultCode, detail, fills: null });
}

/**
 * Resolve immutable fill identity and fee evidence from Schwab order
 * activities. No position snapshot or inferred quantity/price is accepted.
 */
export function resolveSchwabFillEvidence(order) {
  const observations = [];
  for (const [activityIndex, activity] of (order?.orderActivityCollection ?? []).entries()) {
    if (String(activity?.activityType ?? '').toUpperCase() !== 'EXECUTION') continue;
    for (const [legIndex, leg] of (activity.executionLegs ?? []).entries()) {
      observations.push({ activityIndex, legIndex, activity, leg,
        candidates: identityCandidates(order, activity, leg) });
    }
  }
  if (observations.length === 0) return fault('MISSING_FILLS');

  const candidateOwners = new Map();
  observations.forEach((observation, observationIndex) => {
    for (const candidate of observation.candidates) {
      if (!candidateOwners.has(candidate.value)) candidateOwners.set(candidate.value, new Set());
      candidateOwners.get(candidate.value).add(observationIndex);
    }
  });

  const fills = [];
  for (const [observationIndex, observation] of observations.entries()) {
    const identity = observation.candidates.find((candidate) =>
      candidateOwners.get(candidate.value)?.size === 1);
    if (!identity) {
      return fault('MISSING_FILL_ID', {
        orderId: absent(order?.orderId) ? null : String(order.orderId),
        activityIndex: observation.activityIndex,
        legIndex: observation.legIndex,
      });
    }
    const fee = mappedFee(order, observation.activity, observation.leg);
    if (!fee.ok) {
      return fault('MISSING_FEE', {
        fillId: identity.value,
        identitySource: identity.source,
        activityIndex: observation.activityIndex,
        legIndex: observation.legIndex,
      });
    }
    const quantity = numeric(observation.leg.quantity);
    if (quantity === null) return fault('MISSING_FILL_QUANTITY', { fillId: identity.value });
    const price = numeric(observation.leg.price);
    if (price === null) return fault('MISSING_FILL_PRICE', { fillId: identity.value });
    fills.push(Object.freeze({
      activityIndex: observation.activityIndex,
      legIndex: observation.legIndex,
      fillId: identity.value,
      identitySource: identity.source,
      feeUsd: fee.feeUsd,
      feeSource: fee.feeSource,
      quantity,
      price,
    }));
  }
  return Object.freeze({ ok: true, faultCode: null, detail: null, fills: Object.freeze(fills) });
}
