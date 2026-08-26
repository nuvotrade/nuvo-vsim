import { contentHash } from '../src/execution/order.js';

export const GUARDIAN_MANDATE_VERSION = 'NUVO-GUARDIAN-2026-08-26-v1';
export const GUARDIAN_STATES = Object.freeze({
  OPEN: 'OPEN',
  THROTTLED: 'THROTTLED',
  MANAGE_ONLY: 'MANAGE-ONLY',
  HALTED: 'HALTED',
  BLOCKED: 'BLOCKED-INCOMPLETE',
});

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function underlyingOf(position) {
  return String(position.underlying ?? position.symbol ?? 'UNKNOWN').toUpperCase();
}

export function projectedExposure(snapshot) {
  const byUnderlying = new Map();
  const add = (symbol, value) => byUnderlying.set(symbol, (byUnderlying.get(symbol) ?? 0) + Math.max(0, finite(value, 0)));
  for (const position of snapshot?.positions ?? []) {
    const underlying = underlyingOf(position);
    const quantity = finite(position.quantity, 0);
    const multiplier = finite(position.multiplier, position.type === 'OPTION' ? 100 : 1);
    if (position.type === 'EQUITY' && quantity > 0) add(underlying, Math.abs(finite(position.marketValue, 0)));
    if (position.type === 'OPTION' && position.right === 'put' && quantity < 0) {
      add(underlying, Math.abs(quantity) * multiplier * finite(position.strike, 0));
    }
  }
  return [...byUnderlying].map(([symbol, projected]) => ({ symbol, projected }))
    .sort((a, b) => b.projected - a.projected);
}

export function uncoveredShortCalls(snapshot) {
  const shares = new Map();
  for (const position of snapshot?.positions ?? []) {
    if (position.type === 'EQUITY' && finite(position.quantity, 0) > 0) {
      shares.set(underlyingOf(position), finite(position.quantity, 0));
    }
  }
  return (snapshot?.positions ?? []).filter((position) => position.type === 'OPTION'
    && position.right === 'call' && finite(position.quantity, 0) < 0)
    .map((position) => {
      const requiredShares = Math.abs(finite(position.quantity, 0)) * finite(position.multiplier, 100);
      return { symbol: position.symbol, underlying: underlyingOf(position), requiredShares,
        availableShares: shares.get(underlyingOf(position)) ?? 0 };
    }).filter((row) => row.availableShares < row.requiredShares);
}

export function evaluateGuardian({ snapshot, reconStatus = 'MISSING', campaignCount = 0,
  unresolvedDiscrepancies = 0, now = Date.now(), marketSession = 'CLOSED' } = {}) {
  const violations = [];
  if (!snapshot || !Number.isFinite(finite(snapshot.nav)) || !Number.isFinite(finite(snapshot.cash))) {
    return { state: GUARDIAN_STATES.BLOCKED, violations: [{ code: 'DATA/ACCOUNT_MISSING', severity: 'CRITICAL' }], exposures: [] };
  }
  const ageMs = now - finite(snapshot.asOf, 0);
  if (marketSession === 'RTH' && (ageMs < 0 || ageMs > 5 * 60_000)) {
    violations.push({ code: 'DATA/BROKER_STALE', severity: 'CRITICAL', detail: { age_seconds: Math.max(0, ageMs / 1000) } });
  }
  if (reconStatus === 'MISSING') violations.push({ code: 'RECON/MISSING', severity: 'CRITICAL' });
  if (reconStatus === 'MISMATCH' || unresolvedDiscrepancies > 0) {
    violations.push({ code: 'RECON/MISMATCH', severity: 'CRITICAL', detail: { unresolved: unresolvedDiscrepancies } });
  }
  const marginDebit = Math.max(0, finite(snapshot.marginDebit, Math.max(0, -finite(snapshot.cash, 0))));
  if (marginDebit > 0) violations.push({ code: 'RISK/MARGIN_DEBIT', severity: 'CRITICAL', detail: { margin_debit: marginDebit } });
  for (const call of uncoveredShortCalls(snapshot)) violations.push({ code: 'OPTIONS/UNCOVERED_CALL', severity: 'CRITICAL', detail: call });
  const nav = finite(snapshot.nav, 0);
  const exposures = projectedExposure(snapshot).map((row) => ({ ...row, pctNav: nav > 0 ? row.projected / nav : null }));
  for (const row of exposures) {
    if (row.pctNav > 0.20) violations.push({ code: 'RISK/SINGLE_NAME_ABOVE_20', severity: 'CRITICAL', detail: row });
    else if (row.pctNav > 0.15) violations.push({ code: 'RISK/SINGLE_NAME_ABOVE_15', severity: 'HIGH', detail: row });
    else if (row.pctNav > 0.10) violations.push({ code: 'RISK/SINGLE_NAME_ABOVE_10', severity: 'WARNING', detail: row });
  }
  if (campaignCount === 0 && (snapshot.positions?.length ?? 0) > 0) {
    violations.push({ code: 'CAMPAIGN/CONTRACTS_MISSING', severity: 'HIGH', detail: { positions: snapshot.positions.length } });
  }
  if (campaignCount === 0 && (snapshot.openOrders?.length ?? 0) > 0) {
    violations.push({ code: 'AUTH/BROKER_BYPASS', severity: 'CRITICAL', detail: { open_orders: snapshot.openOrders.length } });
  }
  const codes = new Set(violations.map((row) => row.code));
  let state = GUARDIAN_STATES.OPEN;
  if (codes.has('DATA/ACCOUNT_MISSING') || codes.has('DATA/BROKER_STALE') || codes.has('RECON/MISSING')) state = GUARDIAN_STATES.BLOCKED;
  else if ([...codes].some((code) => code === 'RISK/MARGIN_DEBIT' || code === 'OPTIONS/UNCOVERED_CALL'
    || code === 'RECON/MISMATCH' || code === 'AUTH/BROKER_BYPASS')) state = GUARDIAN_STATES.HALTED;
  else if ([...codes].some((code) => code === 'RISK/SINGLE_NAME_ABOVE_20' || code === 'CAMPAIGN/CONTRACTS_MISSING')) state = GUARDIAN_STATES.MANAGE_ONLY;
  else if ([...codes].some((code) => code === 'RISK/SINGLE_NAME_ABOVE_15')) state = GUARDIAN_STATES.THROTTLED;
  return { state, violations, exposures, marginDebit, snapshotAgeSeconds: Math.max(0, ageMs / 1000) };
}

export function guardianReport({ snapshot, assessment, reconStatus, campaignCount = 0, previousReconciliation = null } = {}) {
  const report = {
    mandateVersion: GUARDIAN_MANDATE_VERSION,
    timestamp: new Date().toISOString(),
    brokerData: assessment?.violations?.some((row) => row.code === 'DATA/BROKER_STALE') ? 'STALE' : snapshot ? 'LIVE' : 'MISSING',
    accountAuthority: assessment?.state ?? GUARDIAN_STATES.BLOCKED,
    accountEquity: finite(snapshot?.nav), cash: finite(snapshot?.cash), marginDebit: finite(assessment?.marginDebit, 0),
    totalDeployment: (snapshot?.positions ?? []).reduce((sum, row) => sum + Math.abs(finite(row.marketValue, 0)), 0),
    largestUnderlyingExposure: assessment?.exposures?.[0] ?? null,
    openPositions: snapshot?.positions?.length ?? 0, openOrders: snapshot?.openOrders?.length ?? 0,
    unresolvedDiscrepancies: assessment?.violations?.find((row) => row.code === 'RECON/MISMATCH')?.detail?.unresolved
      ?? assessment?.violations?.filter((row) => row.code.startsWith('RECON/')).length ?? 0,
    campaignRecordVersion: campaignCount ? `ACTIVE-${campaignCount}` : 'MISSING',
    lastSuccessfulReconciliation: reconStatus === 'CAPTURED' ? new Date(snapshot.asOf).toISOString() : null,
    violations: assessment?.violations ?? [],
    behavioralIntervention: {
      averagingDownAttempt: false, concentrationIncrease: false, stopWideningOrRemoval: false,
      fearDrivenCspAction: false, fearDrivenCoveredCallAction: false,
      prematureWinnerExit: false,
      brokerBypass: assessment?.violations?.some((row) => row.code === 'AUTH/BROKER_BYPASS') ?? false,
      strategyMutationAttempt: false,
    },
    finalDirective: assessment?.state === GUARDIAN_STATES.OPEN
      ? 'Remain inside the frozen campaign and risk rules.'
      : 'Do not add exposure; only frozen protective or risk-reducing actions are permitted.',
    previousReconciliation,
  };
  return { ...report, fingerprint: contentHash(report) };
}

export function normalizedBrokerEventKey(event) {
  if (event.transactionId) {
    return contentHash({
      provider: 'SCHWAB', type: event.type, transactionId: event.transactionId,
    });
  }
  if (event.type === 'ORDER_STATE' && event.brokerOrderId) {
    return contentHash({
      provider: 'SCHWAB', type: event.type, brokerOrderId: event.brokerOrderId,
    });
  }
  if (event.activityId) {
    return contentHash({
      provider: 'SCHWAB', type: event.type, activityId: event.activityId,
      symbol: event.symbol ?? null, side: event.side ?? null,
      quantity: event.quantity ?? null, price: event.price ?? null,
      occurredAt: event.occurredAt ?? null,
    });
  }
  return contentHash({
    provider: 'SCHWAB', type: event.type, brokerOrderId: event.brokerOrderId ?? null,
    activityId: event.activityId ?? null, symbol: event.symbol ?? null, quantity: event.quantity ?? null,
    price: event.price ?? null, occurredAt: event.occurredAt ?? null,
  });
}
