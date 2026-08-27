const CURRENCY_ASSETS = new Set(['CURRENCY', 'CASH_EQUIVALENT']);
export const PERFORMANCE_MARKET_TIME_ZONE = 'America/New_York';
const IN_MANDATE_CALENDAR_STRATEGIES = new Set(['SHORT_CALL', 'SHORT_PUT']);
export const MANDATE_PANEL_STATES = Object.freeze({
  WITHIN: 'WITHIN',
  BREACH: 'BREACH',
  NOT_MEASURED: 'NOT_MEASURED',
  STALE: 'STALE',
  SUSPECT: 'SUSPECT',
});

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const mandateNumber = (value) => value === null || value === undefined || value === '' ? null : finite(value);
const cents = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function ageMs(asof, now) {
  const observed = Date.parse(asof ?? '');
  const current = now instanceof Date ? now.getTime() : Number.isFinite(Number(now))
    ? Number(now) : Date.parse(now ?? '');
  return Number.isFinite(observed) && Number.isFinite(current) ? Math.max(0, current - observed) : null;
}

function mandateRow({ id, label, measurement = null, limit = null, breached = null,
  state = null, classification = null, findingId = null, source, derivation, asof = null,
  caveat = null, visibleNote = null }) {
  const measured = measurement !== null;
  return {
    id,
    label,
    state: state ?? (measured ? breached ? MANDATE_PANEL_STATES.BREACH
      : MANDATE_PANEL_STATES.WITHIN : MANDATE_PANEL_STATES.NOT_MEASURED),
    breached: measured && typeof breached === 'boolean' ? breached : null,
    measurement,
    limit,
    classification,
    finding_id: findingId,
    source,
    derivation,
    asof,
    caveat,
    visible_note: visibleNote,
  };
}

export function mandateStateFromPortfolio({ asof = null, now = Date.now(), nav = null,
  capitalCommitted = [], harvest = [], riskInstrumentation = {}, optionPositionCount = 0,
  optionAnalyticsAsOf = null, positionsUnderReview = null, concentrationFindingOpen = true } = {}) {
  const custodyAgeMs = ageMs(asof, now);
  const quoteAgeMs = ageMs(optionAnalyticsAsOf, now);
  const accountFreshnessMs = mandateNumber(riskInstrumentation.max_account_age_ms);
  const quoteFreshnessMs = mandateNumber(riskInstrumentation.max_quote_age_ms);
  const custodyStale = custodyAgeMs !== null && accountFreshnessMs !== null
    ? custodyAgeMs > accountFreshnessMs : false;
  const quotesRequired = Number(optionPositionCount) > 0;
  const quotesUnmeasured = quotesRequired && quoteAgeMs === null;
  const quotesStale = quotesRequired && quoteAgeMs !== null && quoteFreshnessMs !== null
    ? quoteAgeMs > quoteFreshnessMs : false;
  const dataMeasured = custodyAgeMs !== null && accountFreshnessMs !== null
    && (!quotesRequired || (quoteAgeMs !== null && quoteFreshnessMs !== null));
  const dataState = !dataMeasured || quotesUnmeasured ? MANDATE_PANEL_STATES.NOT_MEASURED
    : custodyStale || quotesStale ? MANDATE_PANEL_STATES.STALE : MANDATE_PANEL_STATES.WITHIN;

  const concentrationLimit = mandateNumber(riskInstrumentation.single_underlying_limit_pct);
  const concentrationItems = capitalCommitted.filter((row) => row.symbol !== 'CASH')
    .map((row) => ({ symbol: row.symbol, value: mandateNumber(row.value), pct_nav: mandateNumber(row.pct_nav) }));
  const concentrationMeasured = mandateNumber(nav) > 0 && concentrationLimit !== null
    && concentrationItems.every((row) => row.value !== null && row.pct_nav !== null);
  const concentrationBreached = concentrationMeasured
    ? concentrationItems.some((row) => row.pct_nav > concentrationLimit) : null;
  const concentrationFindingApplies = concentrationMeasured && concentrationItems.length > 0
    && concentrationFindingOpen;
  const concentration = mandateRow({
    id: 'CONCENTRATION', label: 'Concentration',
    measurement: concentrationMeasured ? { kind: 'PER_UNDERLYING_PCT_NAV', items: concentrationItems } : null,
    limit: concentrationLimit === null ? null : { kind: 'MAX_PCT_NAV', value: concentrationLimit },
    breached: concentrationBreached,
    state: concentrationFindingApplies ? MANDATE_PANEL_STATES.SUSPECT
      : concentrationMeasured ? null : MANDATE_PANEL_STATES.NOT_MEASURED,
    classification: concentrationBreached ? 'PREEXISTING_NONCONFORMING' : null,
    findingId: concentrationFindingApplies ? 'H-01' : null,
    source: 'portfolio.capital_committed',
    derivation: 'share market value plus cash-secured-put assignment notional, grouped by underlying, divided by Schwab net liquidation',
    asof,
    caveat: concentrationFindingApplies
      ? 'Dashboard and Governor concentration paths disagree by 2× for covered shares; value remains flagged until H-01 closes.'
      : concentrationMeasured ? null
        : 'Concentration cannot be asserted without NAV, the active cap, and complete per-underlying commitments.',
  });

  const reservePct = mandateNumber(riskInstrumentation.cash_reserve_pct);
  const reserveLimit = mandateNumber(riskInstrumentation.min_cash_reserve_pct);
  const reserveMeasured = reservePct !== null && reserveLimit !== null;
  const reserveBreached = reserveMeasured ? reservePct < reserveLimit : null;
  const reserve = mandateRow({
    id: 'RESERVE', label: 'Reserve', measurement: reserveMeasured
      ? { kind: 'PCT_NAV', value: reservePct } : null,
    limit: reserveLimit === null ? null : { kind: 'MIN_PCT_NAV', value: reserveLimit },
    breached: reserveBreached,
    state: reserveMeasured && custodyStale ? MANDATE_PANEL_STATES.STALE : null,
    classification: reserveBreached ? 'PREEXISTING_NONCONFORMING' : null,
    source: 'portfolio.risk_instrumentation.cash_reserve_pct',
    derivation: 'max(0, account cash) / Schwab net liquidation', asof,
    caveat: 'Account cash is a derived NAV-minus-position-market-value plug; it is not verified settled cash and inherits mark quality.',
  });

  const deployedPct = mandateNumber(riskInstrumentation.deployed_pct);
  const deployedLimit = mandateNumber(riskInstrumentation.max_deployed_pct);
  const deploymentMeasured = deployedPct !== null && deployedLimit !== null;
  const deploymentBreached = deploymentMeasured ? deployedPct > deployedLimit : null;
  const deployment = mandateRow({
    id: 'DEPLOYMENT', label: 'Deployment', measurement: deploymentMeasured
      ? { kind: 'PCT_NAV', value: deployedPct } : null,
    limit: deployedLimit === null ? null : { kind: 'MAX_PCT_NAV', value: deployedLimit },
    breached: deploymentBreached,
    state: deploymentMeasured && custodyStale ? MANDATE_PANEL_STATES.STALE : null,
    classification: deploymentBreached ? 'PREEXISTING_NONCONFORMING' : null,
    source: 'portfolio.risk_instrumentation.deployed_pct',
    derivation: '1 - cash reserve percentage', asof,
    caveat: 'The active runtime ceiling is displayed. The approved 80% draft is not activated.',
    visibleNote: 'Approved draft 80% not activated.',
  });

  const expirationLimit = mandateNumber(riskInstrumentation.expiration_limit_pct);
  const expirationMap = new Map();
  for (const row of harvest) {
    const expirationCapital = mandateNumber(row.expiration_capital);
    if (!row.expiration || expirationCapital === null) continue;
    expirationMap.set(row.expiration, (expirationMap.get(row.expiration) ?? 0) + expirationCapital);
  }
  const expirationItems = [...expirationMap.entries()].map(([expiration, value]) => ({
    expiration, value, pct_nav: mandateNumber(nav) > 0 ? value / Number(nav) : null,
  })).sort((a, b) => (b.pct_nav ?? -Infinity) - (a.pct_nav ?? -Infinity)
    || String(a.expiration).localeCompare(String(b.expiration)));
  const expirationMeasured = mandateNumber(nav) > 0 && expirationLimit !== null
    && expirationItems.every((row) => row.pct_nav !== null);
  const expirationBreached = expirationMeasured
    ? expirationItems.some((row) => row.pct_nav > expirationLimit) : null;
  const expiration = mandateRow({
    id: 'EXPIRATION', label: 'Expiration', measurement: expirationMeasured
      ? { kind: 'PER_EXPIRATION_PCT_NAV', items: expirationItems,
        primary: expirationItems[0] ?? { expiration: null, value: 0, pct_nav: 0 } } : null,
    limit: expirationLimit === null ? null : { kind: 'MAX_PCT_NAV', value: expirationLimit },
    breached: expirationBreached,
    state: expirationMeasured && custodyStale ? MANDATE_PANEL_STATES.STALE : null,
    classification: expirationBreached ? 'PREEXISTING_NONCONFORMING' : null,
    source: 'portfolio.harvest.expiration_capital grouped by exact expiration date',
    derivation: 'short-option assignment or covered-share notional per exact expiration / Schwab net liquidation', asof,
  });

  const data = mandateRow({
    id: 'DATA', label: 'Data', state: dataState,
    measurement: dataMeasured ? { kind: 'FRESHNESS_AGE_MS', custody_age_ms: custodyAgeMs,
      quote_age_ms: quotesRequired ? quoteAgeMs : null, quotes_required: quotesRequired } : null,
    limit: accountFreshnessMs === null || (quotesRequired && quoteFreshnessMs === null) ? null
      : { kind: 'MAX_AGE_MS', custody: accountFreshnessMs,
        quotes: quotesRequired ? quoteFreshnessMs : null },
    breached: null, source: 'custody.observedAt + oldest open-option quote timestamp',
    derivation: 'current request time minus source timestamp; oldest required source determines state',
    asof: [asof, optionAnalyticsAsOf].filter(Boolean).sort()[0] ?? null,
    caveat: dataMeasured ? null : 'Freshness cannot be asserted until every required timestamp and threshold is present.',
  });

  const evidence = mandateRow({
    id: 'EVIDENCE', label: 'Evidence', state: MANDATE_PANEL_STATES.NOT_MEASURED,
    source: 'H-06 stream-health contract',
    derivation: 'last successful seal compared with expected decision-stream cadence',
    caveat: 'Chain count and validity do not establish liveness. Expected cadence is not wired until H-06.',
  });
  const rows = [concentration, reserve, deployment, expiration, data, evidence];
  const reviewCountMeasured = Number.isInteger(positionsUnderReview) && positionsUnderReview >= 0;
  const positionsUnderReviewState = !reviewCountMeasured ? {
    state: MANDATE_PANEL_STATES.NOT_MEASURED, count: null,
    source: 'portfolio.covered_call_reviews.length',
    reason: 'COVERED_CALL_REVIEW_SOURCE_NOT_WIRED',
  } : {
    state: MANDATE_PANEL_STATES.WITHIN, count: positionsUnderReview,
    source: 'portfolio.covered_call_reviews.length', reason: null,
  };
  return {
    state_version: 'MANDATE_STATE_PANEL_V1',
    asof,
    limits_version: riskInstrumentation.limits_version ?? null,
    breach_count: rows.filter((row) => row.breached === true).length,
    unmeasured_count: rows.filter((row) => row.state === MANDATE_PANEL_STATES.NOT_MEASURED).length
      + (positionsUnderReviewState.state === MANDATE_PANEL_STATES.NOT_MEASURED ? 1 : 0),
    rows,
    positions_under_review: positionsUnderReviewState,
  };
}
const cleanSymbol = (value) => String(value ?? '').replaceAll(' ', '').toUpperCase();
const iso = (value) => {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

function parsePacket(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function transferKind(item) {
  return String(item?.instrument?.assetType ?? '').toUpperCase();
}

/**
 * Turn one Schwab transaction packet into fee-aware security fills.
 *
 * The broker transaction net amount is not copied onto every leg. Fees are
 * allocated across security legs by gross cash-flow weight, which preserves
 * the packet's exact net cash flow without double counting currency rows.
 */
export function transactionFills(packet) {
  const items = Array.isArray(packet?.transferItems) ? packet.transferItems : [];
  const securities = items.filter((item) => !CURRENCY_ASSETS.has(transferKind(item))
    && finite(item?.amount) !== null && finite(item?.cost) !== null);
  if (!securities.length || String(packet?.type ?? '').toUpperCase() !== 'TRADE') return [];

  const feeCashFlow = items.filter((item) => CURRENCY_ASSETS.has(transferKind(item)) && item?.feeType)
    .reduce((sum, item) => sum + (finite(item.cost) ?? 0), 0);
  const grossWeight = securities.reduce((sum, item) => sum + Math.abs(finite(item.cost) ?? 0), 0);
  const equalWeight = 1 / securities.length;

  return securities.map((item) => {
    const instrument = item.instrument ?? {};
    const grossCashFlow = finite(item.cost) ?? 0;
    const weight = grossWeight > 0 ? Math.abs(grossCashFlow) / grossWeight : equalWeight;
    const allocatedFeeCashFlow = feeCashFlow * weight;
    const assetClass = transferKind(item);
    const symbol = cleanSymbol(instrument.symbol ?? instrument.uniformSymbol);
    return {
      transaction_id: String(packet.activityId ?? packet.transactionId ?? ''),
      broker_order_id: String(packet.orderId ?? '') || null,
      occurred_at: iso(packet.time ?? packet.tradeDate ?? packet.transactionDate),
      symbol,
      underlying: cleanSymbol(instrument.underlyingSymbol
        ?? (assetClass === 'EQUITY' ? symbol : symbol.replace(/[0-9].*$/u, ''))),
      asset_class: assetClass,
      right: instrument.putCall ? String(instrument.putCall).toLowerCase() : null,
      strike: finite(instrument.strikePrice),
      expiration: iso(instrument.expirationDate)?.slice(0, 10) ?? null,
      quantity: finite(item.amount),
      price: finite(item.price),
      gross_cash_flow: grossCashFlow,
      fees: Math.max(0, -allocatedFeeCashFlow),
      cash_flow: grossCashFlow + allocatedFeeCashFlow,
      position_effect: String(item.positionEffect ?? 'UNKNOWN').toUpperCase(),
    };
  }).filter((fill) => fill.symbol && fill.quantity !== 0 && fill.occurred_at);
}

export function fillsFromBrokerRows(rows) {
  const seen = new Set();
  const fills = [];
  for (const row of rows ?? []) {
    const packet = parsePacket(row.raw_json);
    if (!packet) continue;
    const key = String(packet.activityId ?? packet.transactionId ?? row.transaction_id ?? '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fills.push(...transactionFills(packet));
  }
  return fills.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)
    || a.transaction_id.localeCompare(b.transaction_id) || a.symbol.localeCompare(b.symbol));
}

function directionFor(quantity) {
  return quantity > 0 ? 'LONG' : 'SHORT';
}

/** FIFO realized P&L. A matched lifecycle is reported only when both sides are
 * present in the imported Schwab history. Unmatched closes remain explicit. */
export function matchRealizedTrades(fills) {
  const lots = new Map();
  const trades = [];
  const unmatched = [];

  for (const fill of fills ?? []) {
    let remaining = Math.abs(fill.quantity);
    const sign = Math.sign(fill.quantity);
    const cashPerUnit = fill.cash_flow / Math.abs(fill.quantity);
    const feePerUnit = fill.fees / Math.abs(fill.quantity);
    const queue = lots.get(fill.symbol) ?? [];

    while (remaining > 1e-9 && queue.length && Math.sign(queue[0].quantity) !== sign) {
      const lot = queue[0];
      const matched = Math.min(remaining, Math.abs(lot.quantity));
      const realized = cents(matched * (lot.cash_per_unit + cashPerUnit));
      trades.push({
        trade_id: `${lot.transaction_id}:${fill.transaction_id}:${fill.symbol}:${trades.length}`,
        symbol: fill.symbol,
        underlying: fill.underlying || lot.underlying,
        asset_class: fill.asset_class,
        right: fill.right,
        strike: fill.strike,
        expiration: fill.expiration,
        direction: directionFor(lot.quantity),
        quantity: matched,
        opened_at: lot.occurred_at,
        closed_at: fill.occurred_at,
        opening_price: lot.price,
        closing_price: fill.price,
        opening_cash_flow: matched * lot.cash_per_unit,
        closing_cash_flow: matched * cashPerUnit,
        fees: matched * (lot.fee_per_unit + feePerUnit),
        realized_pnl: realized,
      });
      lot.quantity -= Math.sign(lot.quantity) * matched;
      remaining -= matched;
      if (Math.abs(lot.quantity) <= 1e-9) queue.shift();
    }

    if (remaining > 1e-9) {
      const claimsClosing = fill.position_effect === 'CLOSING';
      if (claimsClosing && !queue.length) {
        unmatched.push({ symbol: fill.symbol, transaction_id: fill.transaction_id,
          occurred_at: fill.occurred_at, quantity: sign * remaining,
          reason: 'OPENING_LEG_NOT_IN_IMPORTED_HISTORY' });
      } else {
        queue.push({ ...fill, quantity: sign * remaining,
          cash_per_unit: cashPerUnit, fee_per_unit: feePerUnit });
      }
    }
    lots.set(fill.symbol, queue);
  }

  return { trades, unmatched, open_lots: [...lots.values()].flat() };
}

function strategyOf(trade) {
  if (trade.asset_class === 'EQUITY') return 'SHARES';
  if (trade.asset_class !== 'OPTION') return trade.asset_class || 'OTHER';
  return `${trade.direction}_${String(trade.right ?? 'OPTION').toUpperCase()}`;
}

function mandateBucket(strategy) {
  return ['SHARES', 'SHORT_CALL', 'SHORT_PUT'].includes(strategy)
    ? 'MANDATE_COMPATIBLE' : 'STRUCTURE_REVIEW';
}

function summarizeTrades(trades) {
  const wins = trades.filter((trade) => trade.realized_pnl > 0);
  const losses = trades.filter((trade) => trade.realized_pnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.realized_pnl, 0);
  const grossLoss = losses.reduce((sum, trade) => sum + trade.realized_pnl, 0);
  return {
    realized_pnl: cents(trades.reduce((sum, trade) => sum + trade.realized_pnl, 0)),
    closed_trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    win_rate: trades.length ? wins.length / trades.length : null,
    profit_factor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
  };
}

function localDate(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    weekday: get('weekday'),
  };
}

function shiftDateKey(parts, days) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days)).toISOString().slice(0, 10);
}

function localDateKey(value, timeZone = PERFORMANCE_MARKET_TIME_ZONE) {
  const parts = localDate(value, timeZone);
  return parts ? shiftDateKey(parts, 0) : null;
}

function nthWeekday(year, monthIndex, weekday, occurrence) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const day = 1 + ((weekday - first.getUTCDay() + 7) % 7) + (occurrence - 1) * 7;
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function lastWeekday(year, monthIndex, weekday) {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  const day = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function observedFixedHoliday(year, monthIndex, day) {
  const date = new Date(Date.UTC(year, monthIndex, day));
  const weekday = date.getUTCDay();
  if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// Gregorian computus. NYSE observes Good Friday as a full-day closure.
function easterSunday(year) {
  const a = year % 19; const b = Math.floor(year / 100); const c = year % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const EXTRAORDINARY_NYSE_CLOSURES = new Set([
  '1994-04-27',
  '2001-09-11', '2001-09-12', '2001-09-13', '2001-09-14',
  '2004-06-11', '2007-01-02',
  '2012-10-29', '2012-10-30',
  '2018-12-05', '2025-01-09',
]);

/** NYSE full-day closures. Early-close sessions remain trading days. */
export function nyseFullDayClosures(year) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error('NYSE calendar year is invalid.');
  const dates = new Set();
  const addIfYear = (key) => { if (key.startsWith(`${year}-`)) dates.add(key); };
  addIfYear(observedFixedHoliday(year, 0, 1));
  // A Saturday New Year's Day can be observed in the prior calendar year.
  addIfYear(observedFixedHoliday(year + 1, 0, 1));
  if (year >= 1998) dates.add(nthWeekday(year, 0, 1, 3));
  dates.add(nthWeekday(year, 1, 1, 3));
  const goodFriday = easterSunday(year); goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  dates.add(goodFriday.toISOString().slice(0, 10));
  dates.add(lastWeekday(year, 4, 1));
  if (year >= 2022) addIfYear(observedFixedHoliday(year, 5, 19));
  addIfYear(observedFixedHoliday(year, 6, 4));
  dates.add(nthWeekday(year, 8, 1, 1));
  dates.add(nthWeekday(year, 10, 4, 4));
  addIfYear(observedFixedHoliday(year, 11, 25));
  for (const key of EXTRAORDINARY_NYSE_CLOSURES) addIfYear(key);
  return dates;
}

function validatedMonth(value) {
  const match = /^(\d{4})-(\d{2})$/u.exec(String(value ?? ''));
  const year = match ? Number(match[1]) : NaN; const month = match ? Number(match[2]) : NaN;
  if (!Number.isInteger(year) || year < 1900 || year > 2200 || month < 1 || month > 12) {
    throw new Error('Calendar month must use YYYY-MM.');
  }
  return { key: `${year}-${String(month).padStart(2, '0')}`, year, month };
}

/** Month-bounded realized P&L built only from canonical FIFO-matched lifecycles. */
export function realizedPnlCalendar(trades, {
  month, scope = 'ALL', now = new Date(), timeZone = PERFORMANCE_MARKET_TIME_ZONE,
} = {}) {
  const selectedMonth = validatedMonth(month);
  if (!['ALL', 'IN_MANDATE'].includes(scope)) throw new Error('Calendar scope must be ALL or IN_MANDATE.');
  const today = localDateKey(now, timeZone);
  if (!today) throw new Error('A valid clock is required for the realized P&L calendar.');
  const filtered = (trades ?? []).filter((trade) => {
    if (!String(trade.closed_date ?? '').startsWith(`${selectedMonth.key}-`)) return false;
    return scope === 'ALL' || IN_MANDATE_CALENDAR_STRATEGIES.has(trade.strategy);
  });
  const byDay = new Map();
  for (const trade of filtered) {
    const bucket = byDay.get(trade.closed_date) ?? [];
    bucket.push(trade); byDay.set(trade.closed_date, bucket);
  }
  const closures = nyseFullDayClosures(selectedMonth.year);
  const monthEnd = new Date(Date.UTC(selectedMonth.year, selectedMonth.month, 0)).getUTCDate();
  const days = [];
  for (let day = 1; day <= monthEnd; day += 1) {
    const date = new Date(Date.UTC(selectedMonth.year, selectedMonth.month - 1, day));
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const key = date.toISOString().slice(0, 10); const closedTrades = byDay.get(key) ?? [];
    const pnl = cents(closedTrades.reduce((sum, trade) => sum + trade.realized_pnl, 0));
    const isFuture = key > today;
    const state = isFuture ? 'FUTURE'
      : closedTrades.length ? 'CLOSES'
        : closures.has(key) ? 'HOLIDAY' : 'ZERO';
    days.push({
      date: key, day, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday],
      state, pnl: state === 'CLOSES' || state === 'ZERO' ? pnl : null,
      trades: closedTrades.length, trade_ids: closedTrades.map((trade) => trade.trade_id),
    });
  }
  const visibleDates = new Set(days.filter((day) => ['CLOSES', 'ZERO'].includes(day.state)).map((day) => day.date));
  const visibleTrades = filtered.filter((trade) => visibleDates.has(trade.closed_date));
  const attribution = (keyFor) => {
    const grouped = new Map();
    for (const trade of visibleTrades) {
      const key = keyFor(trade) || 'UNKNOWN';
      const row = grouped.get(key) ?? { key, realized_pnl: 0, closed_trades: 0 };
      row.realized_pnl += trade.realized_pnl; row.closed_trades += 1; grouped.set(key, row);
    }
    return [...grouped.values()].map((row) => ({ ...row, realized_pnl: cents(row.realized_pnl) }))
      .sort((a, b) => b.realized_pnl - a.realized_pnl);
  };
  const byTicker = attribution((trade) => trade.underlying || trade.symbol);
  const byStrategy = attribution((trade) => trade.strategy);
  const profit = cents(visibleTrades.filter((trade) => trade.realized_pnl > 0)
    .reduce((sum, trade) => sum + trade.realized_pnl, 0));
  const loss = cents(visibleTrades.filter((trade) => trade.realized_pnl < 0)
    .reduce((sum, trade) => sum + trade.realized_pnl, 0));
  const net = cents(profit + loss);
  const cellTotal = cents(days.reduce((sum, day) => sum + Number(day.pnl ?? 0), 0));
  const tickerTotal = cents(byTicker.reduce((sum, row) => sum + row.realized_pnl, 0));
  const strategyTotal = cents(byStrategy.reduce((sum, row) => sum + row.realized_pnl, 0));
  return {
    month: selectedMonth.key, time_zone: timeZone, scope,
    scope_label: scope === 'ALL' ? 'all closed lifecycles' : 'closed CC and CSP lifecycles only',
    source: 'SCHWAB_LEDGER_FIFO_MATCHED_CLOSED_LIFECYCLES',
    calendar_source: 'NYSE_FULL_DAY_CLOSURES_EARLY_CLOSES_ARE_TRADING_DAYS',
    days,
    by_ticker: byTicker.map(({ key, ...row }) => ({ ticker: key, ...row })),
    by_strategy: byStrategy.map(({ key, ...row }) => ({ strategy: key, ...row })),
    summary: {
      profit, loss, net, closed_trades: visibleTrades.length,
      largest_absolute_day: Math.max(0, ...days.map((day) => Math.abs(Number(day.pnl ?? 0)))),
    },
    reconciliation: {
      status: cellTotal === net && tickerTotal === net && strategyTotal === net ? 'MATCH' : 'DRIFT',
      cell_total: cellTotal, ticker_attribution_total: tickerTotal, strategy_attribution_total: strategyTotal,
    },
  };
}

function currentCalendarMonth(now, timeZone) {
  const parts = localDate(now, timeZone);
  if (!parts) throw new Error('A valid clock is required for month-to-date realized option income.');
  const start = `${parts.year}-${String(parts.month).padStart(2, '0')}-01`;
  const next = new Date(Date.UTC(parts.year, parts.month, 1)).toISOString().slice(0, 10);
  return {
    start,
    end_exclusive: next,
  };
}

function orderMayEncumberUnderlying(order, symbol) {
  const ticker = String(symbol ?? '').toUpperCase();
  const orderSymbol = String(order?.underlying ?? order?.underlyingSymbol ?? order?.symbol ?? '')
    .toUpperCase().replaceAll(' ', '');
  if (!orderSymbol) return true;
  return orderSymbol === ticker || orderSymbol.startsWith(ticker);
}

export function performanceFromBrokerRows(rows, {
  currentUnrealized = null, now = new Date(), timeZone = 'America/Los_Angeles',
  marketTimeZone = PERFORMANCE_MARKET_TIME_ZONE,
} = {}) {
  const fills = fillsFromBrokerRows(rows);
  const matched = matchRealizedTrades(fills);
  const trades = matched.trades.map((trade) => {
    const strategy = strategyOf(trade);
    return { ...trade, closed_date: localDateKey(trade.closed_at, marketTimeZone),
      strategy, mandate_bucket: mandateBucket(strategy) };
  });
  const totals = summarizeTrades(trades);
  const byTicker = new Map();
  const byStrategy = new Map();
  const month = currentCalendarMonth(now, timeZone);
  const mtdRealizedPremiumTrades = trades.filter((trade) => {
    if (trade.asset_class !== 'OPTION' || trade.direction !== 'SHORT') return false;
    if (!['call', 'put'].includes(String(trade.right ?? '').toLowerCase())) return false;
    const closed = localDate(trade.closed_at, timeZone);
    if (!closed) return false;
    const closedDate = shiftDateKey(closed, 0);
    return closedDate >= month.start && closedDate < month.end_exclusive;
  });
  const mtdRealizedPremium = mtdRealizedPremiumTrades
    .reduce((sum, trade) => sum + trade.realized_pnl, 0);
  let cumulative = 0;
  const curve = trades.slice().sort((a, b) => a.closed_at.localeCompare(b.closed_at)).map((trade) => {
    cumulative = cents(cumulative + trade.realized_pnl);
    return { at: trade.closed_at, closed_date: trade.closed_date, value: cumulative, trade_id: trade.trade_id };
  });
  for (const trade of trades) {
    const ticker = trade.underlying || trade.symbol;
    const current = byTicker.get(ticker) ?? { ticker, realized_pnl: 0, closed_trades: 0 };
    current.realized_pnl += trade.realized_pnl;
    current.closed_trades += 1;
    byTicker.set(ticker, current);
    const currentStrategy = byStrategy.get(trade.strategy)
      ?? { strategy: trade.strategy, realized_pnl: 0, closed_trades: 0 };
    currentStrategy.realized_pnl += trade.realized_pnl;
    currentStrategy.closed_trades += 1;
    byStrategy.set(trade.strategy, currentStrategy);
  }
  const mandateCompatible = trades.filter((trade) => trade.mandate_bucket === 'MANDATE_COMPATIBLE');
  const structureReview = trades.filter((trade) => trade.mandate_bucket === 'STRUCTURE_REVIEW');
  return {
    fills,
    trades: trades.slice().sort((a, b) => b.closed_at.localeCompare(a.closed_at)),
    unmatched: matched.unmatched,
    open_lots: matched.open_lots,
    summary: {
      realized_pnl: totals.realized_pnl,
      unrealized_pnl: finite(currentUnrealized),
      total_pnl: finite(currentUnrealized) === null ? null : cents(totals.realized_pnl + Number(currentUnrealized)),
      closed_trades: trades.length,
      wins: totals.wins,
      losses: totals.losses,
      win_rate: totals.win_rate,
      profit_factor: totals.profit_factor,
      history_complete: matched.unmatched.length === 0,
      unmatched_closures: matched.unmatched.length,
      mtd_realized_premium: cents(mtdRealizedPremium),
      mtd_realized_premium_trades: mtdRealizedPremiumTrades.length,
      mtd_period_start: month.start,
      mtd_period_end_exclusive: month.end_exclusive,
      mtd_timezone: timeZone,
      closed_date_timezone: marketTimeZone,
    },
    curve,
    by_ticker: [...byTicker.values()].map((row) => ({ ...row, realized_pnl: cents(row.realized_pnl) }))
      .sort((a, b) => b.realized_pnl - a.realized_pnl),
    by_strategy: [...byStrategy.values()].map((row) => ({ ...row, realized_pnl: cents(row.realized_pnl) }))
      .sort((a, b) => b.realized_pnl - a.realized_pnl),
    mandate_view: {
      mandate_compatible: summarizeTrades(mandateCompatible),
      structure_review: summarizeTrades(structureReview),
      classification: 'STRATEGY_LEG_CLASSIFICATION',
      note: 'SHORT_CALL, SHORT_PUT, and SHARES are mandate-compatible strategy legs. Multi-leg structures require ledger drill-down before a historical mandate conclusion.',
    },
  };
}

export function portfolioFromCustody(custody, optionAnalytics = new Map(), {
  limits = {}, now = Date.now(), positionsUnderReview = null,
} = {}) {
  const account = custody?.account ?? {};
  const positions = custody?.positions ?? [];
  const openOrders = custody?.openOrders ?? [];
  const nav = finite(account.nav);
  const equities = positions.filter((position) => position.type === 'EQUITY');
  const options = positions.filter((position) => position.type === 'OPTION');
  const shortOptions = options.filter((position) => Number(position.quantity) < 0);
  const callsByUnderlying = new Map();
  for (const option of shortOptions.filter((position) => String(position.right).toLowerCase() === 'call')) {
    callsByUnderlying.set(option.underlying, (callsByUnderlying.get(option.underlying) ?? 0) + Math.abs(option.quantity));
  }
  const inventory = equities.map((position) => {
    const mark = finite(position.marketValue) !== null && finite(position.quantity)
      ? position.marketValue / position.quantity : null;
    const unrealized = [finite(position.marketValue), finite(position.averagePrice), finite(position.quantity)]
      .every((value) => value !== null)
      ? position.marketValue - position.averagePrice * position.quantity : null;
    const coveredCallCapacity = Math.max(0, Math.floor(position.quantity / 100)
      - (callsByUnderlying.get(position.symbol) ?? 0));
    const openCoveredCallContracts = callsByUnderlying.get(position.symbol) ?? 0;
    const encumberingOrders = openOrders.filter((order) => orderMayEncumberUnderlying(order, position.symbol));
    return {
      symbol: position.symbol, quantity: position.quantity, average_price: finite(position.averagePrice),
      mark, market_value: finite(position.marketValue), unrealized_pnl: unrealized,
      portfolio_weight: nav > 0 && finite(position.marketValue) !== null ? Math.abs(position.marketValue) / nav : null,
      covered_call_capacity: coveredCallCapacity,
      covered_call_open_contracts: openCoveredCallContracts,
      covered_call_encumbered_shares: openCoveredCallContracts * 100,
      covered_call_actionable: coveredCallCapacity > 0 && encumberingOrders.length === 0
        && finite(position.averagePrice) > 0,
      covered_call_blocker: coveredCallCapacity < 1 ? 'NO_UNENCUMBERED_WHOLE_LOT'
        : encumberingOrders.length ? 'OPEN_ORDER_RECONCILIATION_REQUIRED'
          : finite(position.averagePrice) > 0 ? null : 'AVERAGE_SHARE_PRICE_UNAVAILABLE',
    };
  });
  const harvest = shortOptions.map((position) => {
    const qty = Math.abs(Number(position.quantity));
    const multiplier = finite(position.multiplier) ?? 100;
    const mark = finite(position.marketValue) !== null ? Math.abs(position.marketValue) / (qty * multiplier) : null;
    const openingCredit = finite(position.averagePrice) !== null ? position.averagePrice * qty * multiplier : null;
    const unrealized = openingCredit !== null && finite(position.marketValue) !== null
      ? openingCredit + position.marketValue : null;
    const analytics = optionAnalytics.get(position.symbol) ?? {};
    // Schwab theta is the long-contract theta. A short position and a negative
    // long theta therefore produce positive daily theta exposure.
    const thetaPerDay = finite(analytics.theta) !== null ? Number(position.quantity) * multiplier * analytics.theta : null;
    const right = String(position.right ?? '').toLowerCase();
    const spot = finite(analytics.spot) ?? finite(inventory.find(
      (row) => row.symbol === (position.underlying ?? position.symbol),
    )?.mark);
    const observedAt = Date.parse(custody?.observedAt ?? '');
    const expiryAt = Date.parse(`${position.expiration}T20:00:00Z`);
    const dte = Number.isFinite(observedAt) && Number.isFinite(expiryAt)
      ? Math.max(0, Math.ceil((expiryAt - observedAt) / 86_400_000)) : null;
    const strike = finite(position.strike);
    const cushion = spot !== null && strike !== null
      ? right === 'call' ? strike - spot : right === 'put' ? spot - strike : null
      : null;
    const oneSigmaMove = spot !== null && finite(analytics.iv) > 0 && dte !== null
      ? spot * analytics.iv * Math.sqrt(Math.max(dte, 1) / 365) : null;
    return {
      symbol: position.underlying ?? position.symbol,
      option_symbol: position.symbol,
      type: right === 'call' ? 'COVERED_CALL' : right === 'put' ? 'CASH_SECURED_PUT' : 'SHORT_OPTION',
      strike, expiration: position.expiration ?? null, dte,
      quantity: qty, entry_credit: openingCredit, mark, market_value: finite(position.marketValue),
      unrealized_pnl: unrealized, theta_per_day: thetaPerDay,
      capital_committed: right === 'put' && finite(position.strike) !== null
        ? position.strike * qty * multiplier : null,
      probability_otm: finite(analytics.probability_otm),
      underlying_spot: spot,
      distance_to_strike_dollars: cushion,
      distance_to_strike_pct: spot > 0 && cushion !== null ? cushion / spot : null,
      one_sigma_move: oneSigmaMove,
      distance_to_strike_sigma: oneSigmaMove > 0 && cushion !== null ? cushion / oneSigmaMove : null,
      distance_source: cushion !== null && oneSigmaMove !== null
        ? 'SCHWAB_CUSTODY_SPOT_AND_OPTION_QUOTE_IV' : 'INCOMPLETE',
      expiration_capital: right === 'put' && strike !== null
        ? strike * qty * multiplier
        : right === 'call' && spot !== null ? spot * qty * multiplier : null,
      quote_asof: analytics.asof ?? null,
      quote_freshness: analytics.freshness ?? null,
    };
  });
  const commitments = new Map();
  for (const row of inventory) commitments.set(row.symbol, (commitments.get(row.symbol) ?? 0) + Math.abs(row.market_value ?? 0));
  for (const row of harvest.filter((item) => item.type === 'CASH_SECURED_PUT')) {
    commitments.set(row.symbol, (commitments.get(row.symbol) ?? 0) + Math.abs(row.capital_committed ?? 0));
  }
  const cash = finite(account.cash);
  if (cash > 0) commitments.set('CASH', cash);
  const capitalCommitted = [...commitments.entries()].map(([symbol, value]) => ({
    symbol, value, pct_nav: nav > 0 ? value / nav : null,
    limit_pct: symbol === 'CASH' ? null : finite(limits.maxSingleUnderlyingPct),
    breached: symbol === 'CASH' ? false : nav > 0 && finite(limits.maxSingleUnderlyingPct) !== null
      ? value / nav > limits.maxSingleUnderlyingPct : false,
  })).sort((a, b) => b.value - a.value);
  const bookedPremium = harvest.every((row) => row.entry_credit !== null)
    ? harvest.reduce((sum, row) => sum + row.entry_credit, 0) : null;
  const incomeTheta = harvest.every((row) => row.theta_per_day !== null)
    ? harvest.reduce((sum, row) => sum + row.theta_per_day, 0) : null;
  const netThetaValues = options.map((position) => {
    const theta = finite(optionAnalytics.get(position.symbol)?.theta);
    const multiplier = finite(position.multiplier) ?? 100;
    return theta === null || finite(position.quantity) === null
      ? null : Number(position.quantity) * multiplier * theta;
  });
  const netTheta = netThetaValues.every((value) => value !== null)
    ? netThetaValues.reduce((sum, value) => sum + value, 0) : null;
  const shareOpenPnlValues = inventory.map((row) => row.unrealized_pnl);
  const shareOpenPnl = shareOpenPnlValues.every((value) => value !== null)
    ? shareOpenPnlValues.reduce((sum, value) => sum + value, 0) : null;
  const optionOpenPnlValues = options.map((position) => {
    const marketValue = finite(position.marketValue);
    const averagePrice = finite(position.averagePrice);
    const quantity = finite(position.quantity);
    const multiplier = finite(position.multiplier) ?? 100;
    return [marketValue, averagePrice, quantity].every((value) => value !== null)
      ? marketValue - averagePrice * quantity * multiplier : null;
  });
  const optionOpenPnl = optionOpenPnlValues.every((value) => value !== null)
    ? optionOpenPnlValues.reduce((sum, value) => sum + value, 0) : null;
  const openPnl = shareOpenPnl !== null && optionOpenPnl !== null
    ? shareOpenPnl + optionOpenPnl : null;
  const totalShortContracts = shortOptions.reduce((sum, position) => sum + Math.abs(position.quantity), 0);
  const expirationBuckets = [
    { bucket: 'W1', label: '0–7 DTE', min: 0, max: 7 },
    { bucket: 'W2', label: '8–14 DTE', min: 8, max: 14 },
    { bucket: 'W3', label: '15–21 DTE', min: 15, max: 21 },
    { bucket: 'W4', label: '>21 DTE', min: 22, max: Infinity },
  ].map((bucket) => {
    const positionsInBucket = harvest.filter((position) => position.dte !== null
      && position.dte >= bucket.min && position.dte <= bucket.max);
    const contracts = positionsInBucket.reduce((sum, position) => sum + position.quantity, 0);
    const value = positionsInBucket.every((position) => position.expiration_capital !== null)
      ? positionsInBucket.reduce((sum, position) => sum + position.expiration_capital, 0) : null;
    const pct = nav > 0 && value !== null ? value / nav : null;
    return {
      bucket: bucket.bucket, label: bucket.label, contracts, value, pct,
      expirations: [...new Set(positionsInBucket.map((position) => position.expiration).filter(Boolean))],
      limit_pct: finite(limits.maxExpirationPct),
      breached: finite(limits.maxExpirationPct) !== null && pct > limits.maxExpirationPct,
    };
  });
  const positiveCash = cash === null ? null : Math.max(0, cash);
  const cashReservePct = nav > 0 && positiveCash !== null ? positiveCash / nav : null;
  const deployedPct = cashReservePct === null ? null : Math.max(0, 1 - cashReservePct);
  const riskInstrumentation = {
    cash_reserve_pct: cashReservePct,
    min_cash_reserve_pct: finite(limits.minReservePct),
    reserve_breached: cashReservePct !== null && finite(limits.minReservePct) !== null
      ? cashReservePct < limits.minReservePct : false,
    deployed_pct: deployedPct,
    max_deployed_pct: finite(limits.maxDeployedPct),
    deployed_breached: deployedPct !== null && finite(limits.maxDeployedPct) !== null
      ? deployedPct > limits.maxDeployedPct : false,
    expiration_limit_pct: finite(limits.maxExpirationPct),
    single_underlying_limit_pct: finite(limits.maxSingleUnderlyingPct),
    max_account_age_ms: finite(limits.maxAccountAgeMs),
    max_quote_age_ms: finite(limits.maxQuoteAgeMs),
    limits_version: limits.version ?? null,
    short_option_contracts: totalShortContracts,
    expiration_ladder: expirationBuckets,
    custody_scope: {
      source: 'SCHWAB_TRADER_API_ACCOUNTS_POSITIONS_PACKET',
      packet_position_count: positions.length,
      account_masks: (account.accounts ?? []).map((row) => row.accountMask).filter(Boolean),
      product_surface: 'EQUITIES_AND_OPTIONS',
      futures_verified: false,
      note: 'Current brokerage packet covers equities and options. Closed futures activity remains preserved in the broker event ledger.',
    },
  };
  const analyticsAsOfRows = options.map((position) => optionAnalytics.get(position.symbol)?.asof).filter(Boolean);
  const optionAnalyticsAsOf = options.length > 0 && analyticsAsOfRows.length === options.length
    ? analyticsAsOfRows.sort()[0] : null;
  const mandateState = mandateStateFromPortfolio({
    asof: custody?.observedAt ?? null,
    now,
    nav,
    capitalCommitted,
    harvest,
    riskInstrumentation,
    optionPositionCount: options.length,
    optionAnalyticsAsOf,
    positionsUnderReview,
  });
  return {
    asof: custody?.observedAt ?? null,
    account: {
      nav, cash, margin_debit: finite(account.marginDebit) ?? Math.max(0, -(cash ?? 0)),
      buying_power: finite(account.buyingPower), withdrawable_cash: finite(account.withdrawableCash),
      position_equity: nav !== null && bookedPremium !== null ? cents(nav + bookedPremium) : null,
      gross_positions: positions.every((position) => finite(position.marketValue) !== null)
        ? positions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0) : null,
      position_count: positions.length, open_contracts: shortOptions.reduce((sum, row) => sum + Math.abs(row.quantity), 0),
    },
    summary: { booked_premium: bookedPremium, income_theta_per_day: incomeTheta,
      net_theta_per_day: netTheta, open_pnl: openPnl,
      share_open_pnl: shareOpenPnl, option_open_pnl: optionOpenPnl },
    risk_instrumentation: riskInstrumentation,
    mandate_state: mandateState,
    capital_committed: capitalCommitted,
    inventory,
    harvest,
  };
}
