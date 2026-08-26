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
  const positions = (snapshot?.positions ?? []).map((position) => {
    const quantity = finite(position.quantity, 0);
    const multiplier = finite(position.multiplier, position.type === 'OPTION' ? 100 : 1);
    const averagePrice = finite(position.averagePrice);
    const marketValue = finite(position.marketValue);
    const mark = quantity !== 0 && marketValue != null ? marketValue / (quantity * multiplier) : null;
    const signedCost = averagePrice == null ? null : quantity * multiplier * averagePrice;
    return {
      symbol: position.symbol, underlying: underlyingOf(position), assetClass: position.type ?? 'UNKNOWN',
      right: position.right ?? null, strike: finite(position.strike), expiration: position.expiration ?? null,
      quantity, multiplier, averagePrice, mark, marketValue,
      unrealizedPnl: marketValue == null || signedCost == null
        ? null : Math.round((marketValue - signedCost) * 100) / 100,
    };
  });
  const report = {
    mandateVersion: GUARDIAN_MANDATE_VERSION,
    timestamp: new Date().toISOString(),
    brokerData: assessment?.violations?.some((row) => row.code === 'DATA/BROKER_STALE') ? 'STALE' : snapshot ? 'LIVE' : 'MISSING',
    accountAuthority: assessment?.state ?? GUARDIAN_STATES.BLOCKED,
    accountEquity: finite(snapshot?.nav), cash: finite(snapshot?.cash), marginDebit: finite(assessment?.marginDebit, 0),
    totalDeployment: (snapshot?.positions ?? []).reduce((sum, row) => sum + Math.abs(finite(row.marketValue, 0)), 0),
    largestUnderlyingExposure: assessment?.exposures?.[0] ?? null,
    openPositions: snapshot?.positions?.length ?? 0, openOrders: snapshot?.openOrders?.length ?? 0,
    positions,
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

export function wholeDollar(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return 'UNKNOWN';
  const number = Number(value);
  const rounded = Math.sign(number) * Math.round(Math.abs(number));
  const absolute = Math.abs(rounded).toLocaleString('en-US');
  return rounded < 0 ? `-$${absolute}` : `$${absolute}`;
}

function pct(value) {
  return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(1)}%` : 'UNKNOWN';
}

function optionDescription(position) {
  const side = position.quantity < 0 ? 'Short' : 'Long';
  const contracts = Math.abs(position.quantity);
  const right = position.right === 'put' ? 'put' : 'call';
  const expiry = position.expiration ?? 'unknown expiry';
  const strike = Number.isFinite(position.strike) ? wholeDollar(position.strike) : 'unknown strike';
  return `${side} ${contracts} ${position.underlying} ${expiry} ${strike} ${right}${contracts === 1 ? '' : 's'}`;
}

function positionField(position) {
  const isOption = position.assetClass === 'OPTION';
  const description = isOption
    ? optionDescription(position)
    : `${Math.abs(position.quantity).toLocaleString('en-US')} ${position.symbol} share${Math.abs(position.quantity) === 1 ? '' : 's'}`;
  return {
    name: description,
    value: [`Mark: ${wholeDollar(position.mark)}`, `Market value: ${wholeDollar(position.marketValue)}`,
      `Average price: ${wholeDollar(position.averagePrice)}`, `Current P&L: **${wholeDollar(position.unrealizedPnl)}**`].join(' · '),
    inline: false,
  };
}

function violationText(violation) {
  const detail = violation.detail ?? {};
  switch (violation.code) {
    case 'RECON/MISMATCH':
      return `Broker custody differs from the frozen baseline (${detail.unresolved ?? 'unknown'} unresolved facts). New exposure is blocked.`;
    case 'RECON/MISSING':
      return 'No verified reconciliation baseline exists. New exposure is blocked.';
    case 'RISK/SINGLE_NAME_ABOVE_20':
      return `${detail.symbol ?? 'A position'} is ${pct(detail.pctNav)} of NAV, above the 20% limit. No additional exposure is allowed.`;
    case 'RISK/SINGLE_NAME_ABOVE_15':
      return `${detail.symbol ?? 'A position'} is ${pct(detail.pctNav)} of NAV, above the 15% throttle level.`;
    case 'RISK/SINGLE_NAME_ABOVE_10':
      return `${detail.symbol ?? 'A position'} is ${pct(detail.pctNav)} of NAV, above the 10% warning level.`;
    case 'RISK/MARGIN_DEBIT':
      return `Margin debit is ${wholeDollar(detail.margin_debit)}. Account authority is HALTED.`;
    case 'OPTIONS/UNCOVERED_CALL':
      return `${detail.symbol ?? 'A short call'} requires ${detail.requiredShares ?? 'unknown'} shares but only ${detail.availableShares ?? 'unknown'} are available.`;
    case 'CAMPAIGN/CONTRACTS_MISSING':
      return `${detail.positions ?? 'Open'} position(s) have no frozen campaign contract. Management terms cannot be invented after entry.`;
    case 'AUTH/BROKER_BYPASS':
      return `${detail.open_orders ?? 'An'} broker order(s) lack frozen campaign authority.`;
    case 'DATA/BROKER_STALE':
      return `Broker data is ${Math.round(detail.age_seconds ?? 0)} seconds old and cannot authorize new exposure.`;
    default:
      return violation.code;
  }
}

export function guardianDiscordPayload(review) {
  const report = review.report;
  const critical = (report.violations ?? []).some((row) => row.severity === 'CRITICAL');
  const statusIcon = report.accountAuthority === GUARDIAN_STATES.OPEN ? '🟢'
    : report.accountAuthority === GUARDIAN_STATES.THROTTLED ? '🟠' : '🛑';
  const fields = [
    { name: 'Account', value: [`NAV: **${wholeDollar(report.accountEquity)}**`,
      `Cash: **${wholeDollar(report.cash)}**`, `Margin debit: **${wholeDollar(report.marginDebit)}**`,
      `Deployed: **${wholeDollar(report.totalDeployment)}**`].join('\n'), inline: true },
    { name: 'System status', value: [`Authority: **${report.accountAuthority}**`,
      `Broker data: **${report.brokerData ?? 'UNKNOWN'}**`, `Market data: **${report.marketData ?? 'UNKNOWN'}**`,
      `Reconciliation: **${report.reconciliation?.status ?? 'UNKNOWN'}**`,
      `Open orders: **${report.openOrders ?? 0}**`].join('\n'), inline: true },
    ...(report.positions ?? []).map(positionField),
    { name: `Violations (${(report.violations ?? []).length})`,
      value: (report.violations ?? []).length
        ? report.violations.map((row) => `• **${row.code}** — ${violationText(row)}`).join('\n').slice(0, 1024)
        : 'None.', inline: false },
    { name: 'Guardian directive', value: report.finalDirective ?? 'No directive available.', inline: false },
  ].slice(0, 25);
  return {
    content: `${statusIcon} **NUVO GUARDIAN — ${report.accountAuthority}**`,
    allowed_mentions: { parse: [] },
    embeds: [{
      title: critical ? 'Critical account control report' : 'Account control report',
      description: `Schwab snapshot: ${report.timestamp}\nPosition P&L is current broker mark versus Schwab average price. Values are rounded to whole dollars.`,
      color: critical ? 0xED4245 : report.accountAuthority === GUARDIAN_STATES.OPEN ? 0x57F287 : 0xFEE75C,
      fields,
      footer: { text: `Evidence ${review.id} · ${report.mandateVersion}` },
      timestamp: report.timestamp,
    }],
  };
}

export function shouldNotifyGuardian({ previous = null, assessment, newEventCount = 0,
  reviewType = 'EVENT', notify = true } = {}) {
  if (!notify) return false;
  if (reviewType === 'MANUAL' || reviewType === 'END_OF_DAY') return true;
  if (!previous) return true;
  if (previous.state !== assessment?.state) return true;
  if (Number(newEventCount) > 0) return true;
  const priorCodes = (previous.report?.violations ?? []).map((row) => row.code).sort();
  const currentCodes = (assessment?.violations ?? []).map((row) => row.code).sort();
  return JSON.stringify(priorCodes) !== JSON.stringify(currentCodes);
}

export function normalizedBrokerEventKey(event) {
  if (event.transactionId) {
    return contentHash({
      provider: 'SCHWAB', type: event.type, transactionId: event.transactionId,
      transactionLegId: event.transactionLegId ?? null,
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
