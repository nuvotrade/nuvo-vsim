const AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const TRADER_URL = 'https://api.schwabapi.com/trader/v1';
const MARKETDATA_URL = 'https://api.schwabapi.com/marketdata/v1';
const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSACTION_TYPES = 'TRADE,RECEIVE_AND_DELIVER,DIVIDEND_OR_INTEREST,ACH_RECEIPT,ACH_DISBURSEMENT,CASH_RECEIPT,CASH_DISBURSEMENT,ELECTRONIC_FUND,WIRE_OUT,WIRE_IN,JOURNAL,MEMORANDUM,MARGIN_CALL,MONEY_MARKET,SMA_ADJUSTMENT';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
import { normalizedBrokerEventKey } from './guardian.js';
import { resolveSchwabFillEvidence } from '../src/economic/schwab-fill-identity.js';
import {
  assertLane1DispatchCoordinator, assertLane1InstructionState, assertLane1SendSnapshot,
  assertLane1SnapshotUnchanged, lane1OrderState, readLane1SpyPosition,
} from '../src/lane/lane-1-position-guards.js';

export async function fetchLane1PreviewOnly(url, init, fetcher = fetch) {
  let destination;
  try { destination = new URL(url); }
  catch { throw new Error('LANE_1_PREVIEW_DESTINATION_REFUSED'); }
  if (destination.origin !== 'https://api.schwabapi.com'
    || !/^\/trader\/v1\/accounts\/[^/]+\/previewOrder$/u.test(destination.pathname)) {
    throw new Error('LANE_1_PREVIEW_DESTINATION_REFUSED');
  }
  return fetcher(destination.toString(), init);
}

export function buildLane1SchwabOrder({ symbol, side, quantity }) {
  if (symbol !== 'SPY' || !['BUY', 'SELL'].includes(side) || quantity !== 1) {
    throw new Error('LANE_1_ORDER_REFUSED');
  }
  return {
    orderType: 'MARKET',
    session: 'NORMAL',
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    orderLegCollection: [{
      instruction: side,
      quantity: 1,
      instrument: { symbol: 'SPY', assetType: 'EQUITY' },
    }],
  };
}

export const LANE_1_SPY_BRACKET_CONTRACT = 'LANE_1_SPY_BRACKET_TRIGGER_OFFSET_V2';
export const LANE_1_SPY_STOP_OFFSET_USD = 2;
export const LANE_1_SPY_MARKET_CONTRACT = 'LANE_1_SPY_MARKET_ONLY_V2_1';
export const LANE_1_PREVIEW_ASSET_TYPES = Object.freeze(['EQUITY', 'COLLECTIVE_INVESTMENT']);

function lane1EquityLeg(instruction) {
  return {
    instruction,
    quantity: 1,
    instrument: { symbol: 'SPY', assetType: 'EQUITY' },
  };
}

export function buildLane1SchwabMarketOrder({
  symbol = 'SPY', instruction, quantity = 1,
}) {
  if (symbol !== 'SPY' || quantity !== 1
    || !['BUY', 'SELL', 'SELL_SHORT', 'BUY_TO_COVER'].includes(instruction)) {
    throw new Error('LANE_1_MARKET_ORDER_REFUSED');
  }
  return {
    orderType: 'MARKET',
    session: 'NORMAL',
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    orderLegCollection: [lane1EquityLeg(instruction)],
  };
}

/**
 * A native Schwab first-triggers-second order.  The child STOP is linked to
 * the parent trigger price, so the broker — not VSIM — derives fill +/- $2.
 * Both LONG and SHORT payloads must pass the account-scoped preview endpoint
 * before the V2 lane is allowed to arm.
 */
export function buildLane1SchwabBracket({ symbol = 'SPY', signal, quantity = 1 }) {
  if (symbol !== 'SPY' || quantity !== 1 || !['LONG', 'SHORT'].includes(signal)) {
    throw new Error('LANE_1_BRACKET_REFUSED');
  }
  const openingInstruction = signal === 'LONG' ? 'BUY' : 'SELL_SHORT';
  const stopInstruction = signal === 'LONG' ? 'SELL' : 'BUY_TO_COVER';
  const stopPriceOffset = signal === 'LONG'
    ? -LANE_1_SPY_STOP_OFFSET_USD : LANE_1_SPY_STOP_OFFSET_USD;
  return {
    orderType: 'MARKET',
    session: 'NORMAL',
    duration: 'DAY',
    orderStrategyType: 'TRIGGER',
    orderLegCollection: [lane1EquityLeg(openingInstruction)],
    childOrderStrategies: [{
      orderType: 'STOP',
      session: 'NORMAL',
      duration: 'GOOD_TILL_CANCEL',
      orderStrategyType: 'SINGLE',
      stopPriceLinkBasis: 'TRIGGER',
      stopPriceLinkType: 'VALUE',
      stopPriceOffset,
      orderLegCollection: [lane1EquityLeg(stopInstruction)],
    }],
  };
}

export function buildLane1SchwabExit({ symbol = 'SPY', positionSide, quantity = 1 }) {
  if (symbol !== 'SPY' || quantity !== 1 || !['LONG', 'SHORT'].includes(positionSide)) {
    throw new Error('LANE_1_EXIT_REFUSED');
  }
  return {
    orderType: 'MARKET',
    session: 'NORMAL',
    duration: 'DAY',
    orderStrategyType: 'SINGLE',
    orderLegCollection: [lane1EquityLeg(positionSide === 'LONG' ? 'SELL' : 'BUY_TO_COVER')],
  };
}

export function lane1InstructionForSignal(signal, positionSide = null) {
  if (signal === 'LONG') return 'BUY';
  if (signal === 'SHORT') return 'SELL_SHORT';
  if (signal === 'EXIT' && positionSide === 'LONG') return 'SELL';
  if (signal === 'EXIT' && positionSide === 'SHORT') return 'BUY_TO_COVER';
  throw new Error('LANE_1_SIGNAL_POSITION_MISMATCH');
}

export function extractLane1BracketStop(order, signal, { requireOrderId = true } = {}) {
  const children = order?.childOrderStrategies ?? [];
  if (children.length !== 1) throw new Error('LANE_1_BRACKET_CHILD_COUNT_INVALID');
  const stop = children[0];
  const expectedInstruction = signal === 'LONG' ? 'SELL' : signal === 'SHORT' ? 'BUY_TO_COVER' : null;
  const expectedOffset = signal === 'LONG' ? -LANE_1_SPY_STOP_OFFSET_USD
    : signal === 'SHORT' ? LANE_1_SPY_STOP_OFFSET_USD : null;
  const leg = stop?.orderLegCollection?.[0];
  if (stop?.orderType !== 'STOP' || stop?.orderStrategyType !== 'SINGLE'
    || stop?.duration !== 'GOOD_TILL_CANCEL' || stop?.stopPriceLinkBasis !== 'TRIGGER'
    || stop?.stopPriceLinkType !== 'VALUE' || Number(stop?.stopPriceOffset) !== expectedOffset
    || leg?.instruction !== expectedInstruction || Number(leg?.quantity) !== 1
    || leg?.instrument?.symbol !== 'SPY' || leg?.instrument?.assetType !== 'EQUITY') {
    throw new Error('LANE_1_BRACKET_STOP_CONTRACT_INVALID');
  }
  const orderId = String(stop?.orderId ?? '').trim();
  if (requireOrderId && !orderId) throw new Error('LANE_1_STOP_ORDER_ID_MISSING');
  return {
    orderId,
    status: String(stop?.status ?? 'UNKNOWN').toUpperCase(),
    instruction: expectedInstruction,
    stopPriceLinkBasis: 'TRIGGER',
    stopPriceLinkType: 'VALUE',
    stopPriceOffset: expectedOffset,
    duration: 'GOOD_TILL_CANCEL',
  };
}

export function schwabOrderIdFromLocation(location) {
  if (typeof location !== 'string' || !location) throw new Error('MISSING_ORDER_ID');
  const match = /\/orders\/([^/?#]+)\/?(?:[?#].*)?$/u.exec(location);
  if (!match?.[1]) throw new Error('MISSING_ORDER_ID');
  return decodeURIComponent(match[1]);
}

export function extractLane1SchwabFill(order, context = {}) {
  const executions = (order?.orderActivityCollection ?? [])
    .filter((activity) => String(activity?.activityType ?? '').toUpperCase() === 'EXECUTION')
    .flatMap((activity) => activity.executionLegs ?? []);
  if (executions.length === 0) throw new Error('LANE_1_FILL_PENDING');
  if (executions.length !== 1) throw new Error('LANE_1_MULTIPLE_EXECUTION_LEGS_REFUSED');
  const mapped = resolveSchwabFillEvidence({
    ...order,
    orderId: order?.orderId ?? context.brokerOrderId,
  });
  if (!mapped.ok) throw new Error(mapped.faultCode);
  const [fill] = mapped.fills;
  const leg = executions[0];
  const quantity = fill.quantity;
  const price = fill.price;
  const fee = fill.feeUsd;
  if (quantity !== 1 || !(price > 0) || fee === null || fee > 0) {
    throw new Error('LANE_1_FILL_ECONOMICS_INVALID');
  }
  if (!context.brokerOrderId || !context.clientOrderId
    || !['BUY', 'SELL', 'SELL_SHORT', 'BUY_TO_COVER'].includes(context.side)) {
    throw new Error('LANE_1_FILL_CONTEXT_INVALID');
  }
  if (!context.acquiredAt || !context.rawBrokerEvidenceSha256) {
    throw new Error('MISSING_RAW_EVIDENCE_HASH');
  }
  const occurredAt = iso(leg.time);
  if (!occurredAt) throw new Error('MISSING_BROKER_OCCURRED_AT');
  return {
    fillId: fill.fillId,
    brokerOrderId: String(context.brokerOrderId),
    clientOrderId: String(context.clientOrderId),
    symbol: 'SPY',
    side: context.side,
    quantityShares: 1,
    executionPriceUsdPerShare: price,
    feeUsd: fee,
    brokerOccurredAt: occurredAt,
    acquiredAt: context.acquiredAt,
    rawBrokerEvidenceSha256: context.rawBrokerEvidenceSha256,
  };
}

async function boundedText(response, maximumBytes = 1_048_576) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error('SCHWAB_RESPONSE_TOO_LARGE');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error('SCHWAB_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return decoder.decode(joined);
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function cents(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function iso(value, fallback = null) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function epochMs(value, fallback = null) {
  const number = finite(value);
  if (number == null) {
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (number > 1e17) return Math.floor(number / 1e6);
  if (number > 1e14) return Math.floor(number / 1e3);
  if (number > 1e11) return number;
  if (number > 1e9) return number * 1000;
  return fallback;
}

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(String(value));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomState() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function tokenKey(raw, usages) {
  const bytes = fromBase64(raw);
  if (bytes.byteLength !== 32) throw new Error('BROKER_TOKEN_KEY_MUST_BE_32_BYTES_BASE64');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, usages);
}

async function encrypt(value, rawKey, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(context),
  }, await tokenKey(rawKey, ['encrypt']), encoder.encode(String(value)));
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv) };
}

async function decrypt(ciphertext, iv, rawKey, context) {
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: fromBase64(iv), additionalData: encoder.encode(context),
  }, await tokenKey(rawKey, ['decrypt']), fromBase64(ciphertext));
  return decoder.decode(plaintext);
}

function parseOcc(symbol) {
  const compact = String(symbol ?? '').toUpperCase().replaceAll(' ', '');
  const match = /^([A-Z0-9.]{1,6})(\d{6})([CP])(\d{8})$/u.exec(compact);
  if (!match) return null;
  const [, underlying, date, right, rawStrike] = match;
  return {
    underlying,
    right: right === 'P' ? 'put' : 'call',
    expiration: `20${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4, 6)}`,
    strike: Number(rawStrike) / 1000,
  };
}

function schwabOccSymbol(symbol) {
  const compact = String(symbol ?? '').toUpperCase().replaceAll(' ', '');
  const match = /^([A-Z0-9.]{1,6})(\d{6}[CP]\d{8})$/u.exec(compact);
  return match ? `${match[1].padEnd(6, ' ')}${match[2]}` : compact;
}

export function normalizePosition(position) {
  const symbol = String(position.instrument?.symbol ?? '').toUpperCase();
  const assetType = String(position.instrument?.assetType ?? 'UNKNOWN').toUpperCase();
  const option = parseOcc(symbol);
  const longQuantity = finite(position.longQuantity);
  const shortQuantity = finite(position.shortQuantity);
  const previousSessionLongQuantity = finite(position.previousSessionLongQuantity, 0);
  const previousSessionShortQuantity = finite(position.previousSessionShortQuantity, 0);
  const multiplier = option ? 100 : 1;
  const rawDayProfitLoss = finite(position.currentDayProfitLoss);
  const netChange = finite(position.instrument?.netChange);
  const previousSessionQuantity = previousSessionLongQuantity - previousSessionShortQuantity;
  return {
    symbol: symbol.replaceAll(' ', ''),
    underlying: option?.underlying ?? symbol,
    type: option ? 'OPTION' : assetType === 'EQUITY' ? 'EQUITY' : assetType,
    right: option?.right ?? null,
    strike: option?.strike ?? null,
    expiration: option?.expiration ?? null,
    quantity: longQuantity != null && shortQuantity != null
      ? longQuantity - shortQuantity : null,
    multiplier,
    averagePrice: finite(position.averagePrice),
    marketValue: finite(position.marketValue),
    rawDayProfitLoss,
    currentDayCost: finite(position.currentDayCost),
    netChange,
    previousSessionQuantity,
    dayProfitLossReference: netChange == null ? null
      : cents(previousSessionQuantity * multiplier * netChange),
    dayProfitLoss: rawDayProfitLoss,
    dayProfitLossSource: rawDayProfitLoss == null
      ? 'INCOMPLETE_SCHWAB_POSITION_CURRENT_DAY_PROFIT_LOSS'
      : 'SCHWAB_POSITION_CURRENT_DAY_PROFIT_LOSS',
    dayProfitLossContributionMode: rawDayProfitLoss == null ? 'INCOMPLETE' : 'RAW',
    dayProfitLossTriggerReason: rawDayProfitLoss == null
      ? 'RAW_FIELD_MISSING' : 'RAW_FIELD_ACCEPTED',
  };
}

function easternDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const field = (type) => parts.find((part) => part.type === type)?.value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}

/**
 * Schwab can carry a prior session's currentDayCost into the next session while
 * currentDayProfitLoss continues subtracting it. Repair only the exact, sealed
 * identity and only when the transaction ledger proves there was no trade in
 * this instrument during the observation's session.
 */
export function reconcilePositionDayProfitLoss(position, brokerEvents, observedAt) {
  const raw = finite(position?.rawDayProfitLoss ?? position?.dayProfitLoss);
  const cost = finite(position?.currentDayCost);
  const reference = finite(position?.dayProfitLossReference);
  const quantity = finite(position?.quantity);
  const previousQuantity = finite(position?.previousSessionQuantity);
  const sessionDate = easternDate(observedAt);
  const hasSessionTrade = (brokerEvents ?? []).some((event) => event?.type === 'TRADE'
    && String(event.symbol ?? '').replaceAll(' ', '').toUpperCase() === position.symbol
    && easternDate(event.occurredAt) === sessionDate);
  const unchangedQuantity = quantity != null && previousQuantity != null
    && Math.abs(quantity - previousQuantity) < 1e-9;
  const staleCostIdentity = raw != null && cost != null && reference != null
    && Math.abs(cost) > 0.01 && Math.abs(cents(raw + cost) - reference) <= 0.01;
  if (!hasSessionTrade && unchangedQuantity && staleCostIdentity) {
    return {
      ...position,
      dayProfitLoss: reference,
      dayProfitLossAdjustment: cents(reference - raw),
      dayProfitLossSource: 'SCHWAB_RECONCILED_CARRIED_CURRENT_DAY_COST',
      dayProfitLossContributionMode: 'SUBSTITUTED',
      dayProfitLossTriggerReason: 'CURRENT_DAY_COST_IDENTITY_WITHOUT_SAME_SESSION_TRADE',
    };
  }
  return {
    ...position,
    dayProfitLoss: raw,
    dayProfitLossAdjustment: 0,
    dayProfitLossSource: raw == null
      ? 'INCOMPLETE_SCHWAB_POSITION_CURRENT_DAY_PROFIT_LOSS'
      : 'SCHWAB_POSITION_CURRENT_DAY_PROFIT_LOSS',
    dayProfitLossContributionMode: raw == null ? 'INCOMPLETE' : 'RAW',
    dayProfitLossTriggerReason: raw == null ? 'RAW_FIELD_MISSING' : 'RAW_FIELD_ACCEPTED',
  };
}

/** Aggregate the same instrument across linked Schwab accounts. */
export function aggregatePositions(positions) {
  const grouped = new Map();
  for (const position of positions ?? []) {
    const key = [position.symbol, position.underlying, position.type, position.right,
      position.strike, position.expiration].join('|');
    const prior = grouped.get(key);
    if (!prior) {
      grouped.set(key, {
        ...position,
        _allMarketValuesKnown: Number.isFinite(position.marketValue),
        _allDayProfitLossKnown: Number.isFinite(position.dayProfitLoss),
        _weightedPrice: Number.isFinite(position.averagePrice)
          ? Math.abs(position.quantity) * position.averagePrice : null,
        _weight: Number.isFinite(position.averagePrice) ? Math.abs(position.quantity) : 0,
        _direction: Math.sign(position.quantity),
      });
      continue;
    }
    prior.quantity += position.quantity;
    prior._allMarketValuesKnown = prior._allMarketValuesKnown && Number.isFinite(position.marketValue);
    prior.marketValue = prior._allMarketValuesKnown ? prior.marketValue + position.marketValue : null;
    prior._allDayProfitLossKnown = prior._allDayProfitLossKnown && Number.isFinite(position.dayProfitLoss);
    prior.dayProfitLoss = prior._allDayProfitLossKnown
      ? prior.dayProfitLoss + position.dayProfitLoss : null;
    if (prior._direction !== Math.sign(position.quantity)) prior._direction = 0;
    if (prior._direction && Number.isFinite(position.averagePrice)) {
      prior._weightedPrice = (prior._weightedPrice ?? 0) + Math.abs(position.quantity) * position.averagePrice;
      prior._weight += Math.abs(position.quantity);
    } else if (!prior._direction) {
      prior._weightedPrice = null;
      prior._weight = 0;
    }
  }
  return [...grouped.values()].filter((position) => position.quantity !== 0).map((position) => {
    const {
      _allMarketValuesKnown, _allDayProfitLossKnown, _weightedPrice, _weight, _direction, ...clean
    } = position;
    clean.averagePrice = _weightedPrice != null && _weight > 0 ? _weightedPrice / _weight : null;
    return clean;
  });
}

function flattenOrders(order, accountRef, observedAt, rows = []) {
  const providerOrderId = String(order?.orderId ?? '').trim();
  if (providerOrderId) {
    const leg = order?.orderLegCollection?.[0] ?? {};
    rows.push({
      brokerOrderId: providerOrderId,
      clientOrderId: providerOrderId,
      accountRef,
      symbol: String(leg.instrument?.symbol ?? '').replaceAll(' ', '').toUpperCase(),
      side: String(leg.instruction ?? 'UNKNOWN').toUpperCase(),
      state: String(order.status ?? 'UNKNOWN').toUpperCase(),
      quantity: finite(order.quantity ?? leg.quantity, 0),
      updatedAt: iso(order.closeTime ?? order.cancelTime ?? order.enteredTime, observedAt),
    });
  }
  for (const child of order?.childOrderStrategies ?? []) flattenOrders(child, accountRef, observedAt, rows);
  return rows;
}

function flattenOrderEvents(order, accountMask, observedAt, rows = []) {
  const brokerOrderId = String(order?.orderId ?? '').trim() || null;
  const legById = new Map((order?.orderLegCollection ?? []).map((leg) => [String(leg.legId ?? ''), leg]));
  if (brokerOrderId) {
    const firstLeg = order?.orderLegCollection?.[0] ?? {};
    rows.push({
      type: 'ORDER_STATE', brokerOrderId, accountMask,
      symbol: String(firstLeg.instrument?.symbol ?? '').replaceAll(' ', '').toUpperCase() || null,
      side: String(firstLeg.instruction ?? 'UNKNOWN').toUpperCase(),
      quantity: finite(order.quantity ?? firstLeg.quantity), price: finite(order.price), amount: null,
      state: String(order.status ?? 'UNKNOWN').toUpperCase(),
      occurredAt: iso(order.closeTime ?? order.cancelTime ?? order.enteredTime, observedAt), raw: order,
    });
  }
  for (const activity of order?.orderActivityCollection ?? []) {
    const activityId = String(activity.activityId ?? '').trim() || null;
    for (const leg of activity.executionLegs ?? []) {
      const orderLeg = legById.get(String(leg.legId ?? '')) ?? {};
      rows.push({
        type: String(activity.activityType ?? 'EXECUTION').toUpperCase(), brokerOrderId,
        activityId, accountMask,
        symbol: String(orderLeg.instrument?.symbol ?? '').replaceAll(' ', '').toUpperCase() || null,
        side: String(orderLeg.instruction ?? 'UNKNOWN').toUpperCase(), quantity: finite(leg.quantity),
        price: finite(leg.price), amount: null, state: String(order.status ?? 'UNKNOWN').toUpperCase(),
        occurredAt: iso(leg.time ?? activity.executionType ?? order.closeTime, observedAt), raw: activity,
      });
    }
  }
  for (const child of order?.childOrderStrategies ?? []) flattenOrderEvents(child, accountMask, observedAt, rows);
  return rows;
}

function normalizeTransactionItem(transaction, item, accountMask, observedAt, transactionLegId = null) {
  const instrument = item?.instrument ?? {};
  return {
    type: String(transaction?.type ?? 'BROKER_TRANSACTION').toUpperCase(),
    transactionId: String(transaction?.activityId ?? transaction?.transactionId ?? '').trim() || null,
    transactionLegId,
    brokerOrderId: String(transaction?.orderId ?? '').trim() || null,
    activityId: String(transaction?.activityId ?? '').trim() || null,
    accountMask,
    symbol: String(instrument.symbol ?? instrument.assetType ?? '').replaceAll(' ', '').toUpperCase() || null,
    side: String(item?.positionEffect ?? item?.direction ?? transaction?.subAccount ?? 'UNKNOWN').toUpperCase(),
    quantity: finite(item?.amount ?? item?.quantity), price: finite(item?.price), amount: finite(transaction?.netAmount),
    state: String(transaction?.status ?? 'RECORDED').toUpperCase(),
    occurredAt: iso(transaction?.time ?? transaction?.settlementDate ?? transaction?.transactionDate, observedAt),
    raw: transaction,
  };
}

export function normalizeTransactions(transaction, accountMask, observedAt) {
  const transferItems = transaction?.transferItems ?? [];
  const primary = transferItems.find((candidate) => {
    const assetType = String(candidate?.instrument?.assetType ?? '').toUpperCase();
    return assetType && !['CURRENCY', 'CASH_EQUIVALENT'].includes(assetType);
  }) ?? transferItems[0] ?? {};
  const ordered = [primary, ...transferItems.filter((item) => item !== primary)];
  return ordered.map((item, index) => normalizeTransactionItem(
    transaction, item, accountMask, observedAt, index === 0 ? null : `ITEM:${index}`,
  ));
}

export function normalizeTransaction(transaction, accountMask, observedAt) {
  return normalizeTransactions(transaction, accountMask, observedAt)[0];
}

export function historicalLedgerWindow(cursorBefore, floor, windowDays = 59) {
  const endMs = Date.parse(cursorBefore);
  const floorMs = Date.parse(floor);
  if (!Number.isFinite(endMs) || !Number.isFinite(floorMs) || endMs <= floorMs) return null;
  const startMs = Math.max(floorMs, endMs - Math.max(1, windowDays) * DAY_MS);
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), complete: startMs === floorMs };
}

function isOpenOrder(order) {
  return ['AWAITING_PARENT_ORDER', 'AWAITING_CONDITION', 'AWAITING_STOP_CONDITION', 'AWAITING_MANUAL_REVIEW',
    'ACCEPTED', 'AWAITING_UR_OUT', 'PENDING_ACTIVATION', 'QUEUED', 'WORKING', 'PENDING_CANCEL',
    'PENDING_REPLACE'].includes(order.state);
}

export class SchwabD1Client {
  constructor(env) { this.env = env; }

  configured() {
    return this.env.NUVO_BROKER_MODE === 'READ_ONLY'
      && this.env.NUVO_BROKER_EXECUTION_MODE === 'SHADOW_ONLY'
      && this.env.SCHWAB_CLIENT_ID && this.env.SCHWAB_CLIENT_SECRET
      && this.env.SCHWAB_CALLBACK_URL && this.env.BROKER_TOKEN_ENCRYPTION_KEY;
  }

  async beginOAuth(ownerId) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const state = randomState();
    const stateHash = await digest(state);
    const now = new Date().toISOString();
    await this.env.DB.prepare(`INSERT INTO broker_oauth_states
      (state_hash,owner_id,redirect_uri,expires_at,consumed_at,created_at)
      VALUES (?,?,?,?,NULL,?)`).bind(
      stateHash, ownerId, this.env.SCHWAB_CALLBACK_URL,
      new Date(Date.now() + 600_000).toISOString(), now,
    ).run();
    const destination = new URL(AUTH_URL);
    destination.searchParams.set('client_id', this.env.SCHWAB_CLIENT_ID);
    destination.searchParams.set('redirect_uri', this.env.SCHWAB_CALLBACK_URL);
    destination.searchParams.set('response_type', 'code');
    destination.searchParams.set('state', state);
    return destination.toString();
  }

  async completeOAuth(ownerId, state, code) {
    if (!state || !code) throw new Error('SCHWAB_OAUTH_RESPONSE_INCOMPLETE');
    const stateHash = await digest(state);
    const row = await this.env.DB.prepare(`SELECT redirect_uri,expires_at,consumed_at
      FROM broker_oauth_states WHERE state_hash=? AND owner_id=?`).bind(stateHash, ownerId).first();
    if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) {
      throw new Error('SCHWAB_OAUTH_STATE_INVALID');
    }
    const consumed = await this.env.DB.prepare(`UPDATE broker_oauth_states SET consumed_at=?
      WHERE state_hash=? AND owner_id=? AND consumed_at IS NULL`).bind(
      new Date().toISOString(), stateHash, ownerId,
    ).run();
    if (Number(consumed.meta?.changes ?? 0) !== 1) throw new Error('SCHWAB_OAUTH_STATE_INVALID');
    const packet = await this._tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: row.redirect_uri,
    });
    await this._saveTokens(ownerId, packet);
    await this.env.DB.prepare(`INSERT INTO broker_connections
      (owner_id,status,last_successful_sync_at,last_error_code,updated_at)
      VALUES (?,'CONNECTED',NULL,NULL,?) ON CONFLICT(owner_id) DO UPDATE SET
      status='CONNECTED',last_error_code=NULL,updated_at=excluded.updated_at`).bind(
      ownerId, new Date().toISOString(),
    ).run();
  }

  async _tokenRequest(fields) {
    const credentials = btoa(`${this.env.SCHWAB_CLIENT_ID}:${this.env.SCHWAB_CLIENT_SECRET}`);
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields), signal: AbortSignal.timeout(15_000),
    });
    const packet = await response.json().catch(() => ({}));
    if (!response.ok || typeof packet.access_token !== 'string') {
      throw new Error(`SCHWAB_TOKEN_${fields.grant_type === 'refresh_token' ? 'REFRESH' : 'EXCHANGE'}_${response.status}`);
    }
    return packet;
  }

  async _saveTokens(ownerId, packet, priorRefresh = null, priorRefreshExpiry = null) {
    const refresh = typeof packet.refresh_token === 'string' ? packet.refresh_token : priorRefresh;
    if (!refresh) throw new Error('SCHWAB_REFRESH_TOKEN_MISSING');
    const [accessBox, refreshBox] = await Promise.all([
      encrypt(packet.access_token, this.env.BROKER_TOKEN_ENCRYPTION_KEY, `${ownerId}:SCHWAB:access:v1`),
      encrypt(refresh, this.env.BROKER_TOKEN_ENCRYPTION_KEY, `${ownerId}:SCHWAB:refresh:v1`),
    ]);
    const accessSeconds = Math.min(Math.max(60, Number(packet.expires_in ?? 1800)), 720);
    const refreshExpiry = Number.isFinite(Number(packet.refresh_token_expires_in))
      ? new Date(Date.now() + Number(packet.refresh_token_expires_in) * 1000).toISOString()
      : priorRefreshExpiry ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await this.env.DB.prepare(`INSERT INTO broker_token_vault
      (owner_id,encrypted_access_token,access_iv,encrypted_refresh_token,refresh_iv,
       access_expires_at,refresh_expires_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET
      encrypted_access_token=excluded.encrypted_access_token,access_iv=excluded.access_iv,
      encrypted_refresh_token=excluded.encrypted_refresh_token,refresh_iv=excluded.refresh_iv,
      access_expires_at=excluded.access_expires_at,refresh_expires_at=excluded.refresh_expires_at,
      updated_at=excluded.updated_at`).bind(
      ownerId, accessBox.ciphertext, accessBox.iv, refreshBox.ciphertext, refreshBox.iv,
      new Date(Date.now() + accessSeconds * 1000).toISOString(), refreshExpiry, new Date().toISOString(),
    ).run();
  }

  async _tokenRow(ownerId) {
    return this.env.DB.prepare('SELECT * FROM broker_token_vault WHERE owner_id=?').bind(ownerId).first();
  }

  async _acquireRefreshLease(ownerId, leaseId) {
    const acquiredAt = new Date().toISOString();
    const result = await this.env.DB.prepare(`INSERT INTO broker_token_refresh_leases
      (owner_id,lease_id,acquired_at,expires_at) VALUES (?,?,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET
      lease_id=excluded.lease_id,acquired_at=excluded.acquired_at,expires_at=excluded.expires_at
      WHERE broker_token_refresh_leases.expires_at<=excluded.acquired_at`).bind(
      ownerId, leaseId, acquiredAt, new Date(Date.now() + 20_000).toISOString(),
    ).run();
    return Number(result.meta?.changes ?? 0) === 1;
  }

  async _releaseRefreshLease(ownerId, leaseId) {
    await this.env.DB.prepare(`DELETE FROM broker_token_refresh_leases
      WHERE owner_id=? AND lease_id=?`).bind(ownerId, leaseId).run();
  }

  async _freshAccessToken(ownerId, minimumLifetimeMs = 120_000) {
    const row = await this._tokenRow(ownerId);
    if (!row) throw new Error('SCHWAB_NOT_CONNECTED');
    if (Date.parse(row.refresh_expires_at) <= Date.now()) throw new Error('SCHWAB_AUTHORIZATION_RENEWAL_REQUIRED');
    if (Date.parse(row.access_expires_at) <= Date.now() + minimumLifetimeMs) return null;
    return decrypt(row.encrypted_access_token, row.access_iv, this.env.BROKER_TOKEN_ENCRYPTION_KEY, `${ownerId}:SCHWAB:access:v1`);
  }

  async _accessToken(ownerId) {
    const current = await this._freshAccessToken(ownerId);
    if (current) return current;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const leaseId = crypto.randomUUID();
      if (await this._acquireRefreshLease(ownerId, leaseId)) {
        try {
          const refreshedByPeer = await this._freshAccessToken(ownerId);
          if (refreshedByPeer) return refreshedByPeer;
          const row = await this._tokenRow(ownerId);
          const refresh = await decrypt(row.encrypted_refresh_token, row.refresh_iv,
            this.env.BROKER_TOKEN_ENCRYPTION_KEY, `${ownerId}:SCHWAB:refresh:v1`);
          const packet = await this._tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
          await this._saveTokens(ownerId, packet, refresh, row.refresh_expires_at);
          return packet.access_token;
        } finally {
          await this._releaseRefreshLease(ownerId, leaseId);
        }
      }

      for (let poll = 0; poll < 20; poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const refreshedByPeer = await this._freshAccessToken(ownerId);
        if (refreshedByPeer) return refreshedByPeer;
      }
    }
    throw new Error('SCHWAB_TOKEN_REFRESH_BUSY');
  }

  async _read(path, token, { completeOrderList = false } = {}) {
    const response = await fetch(`${TRADER_URL}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`SCHWAB_READ_${response.status}:${path.split('?')[0]}`);
    if (completeOrderList) {
      // Do not promote partial/page-limited success to an empty working set.
      if (response.status !== 200 || ['content-range', 'link', 'x-next-page',
        'x-next-cursor', 'x-has-more', 'x-truncated'].some((name) => response.headers.has(name))) {
        throw new Error('LANE_1_ORDER_READ_INCOMPLETE');
      }
      let orders;
      try { orders = JSON.parse(await boundedText(response)); }
      catch { throw new Error('LANE_1_ORDER_READ_INCOMPLETE'); }
      const total = response.headers.get('x-total-count');
      if (total !== null && (!/^\d+$/u.test(total) || !Array.isArray(orders)
        || Number(total) !== orders.length)) throw new Error('LANE_1_ORDER_READ_INCOMPLETE');
      return orders;
    }
    return response.json();
  }

  async _laneAccountHash(ownerId, configuredHash = null) {
    const token = await this._accessToken(ownerId);
    const accounts = await this._read('/accounts/accountNumbers', token);
    const hashes = (accounts ?? []).map((account) => String(account?.hashValue ?? '')).filter(Boolean);
    if (configuredHash) {
      if (!hashes.includes(String(configuredHash))) throw new Error('LANE_1_ACCOUNT_NOT_FOUND');
      const selected = (accounts ?? []).find((account) => String(account?.hashValue ?? '')
        === String(configuredHash));
      return { accountHash: String(configuredHash), token,
        accountMask: String(selected?.accountNumber ?? '').slice(-4).padStart(4, '•') };
    }
    if (hashes.length !== 1) throw new Error('LANE_1_ACCOUNT_SELECTION_REQUIRED');
    return { accountHash: hashes[0], token,
      accountMask: String(accounts?.[0]?.accountNumber ?? '').slice(-4).padStart(4, '•') };
  }

  async lane1FillFromStoredBrokerEvents(ownerId, {
    brokerOrderId, executionActivityId, transactionActivityId,
    clientOrderId, side, expectedPrice, expectedOccurredAt,
  }) {
    const rows = await this.env.DB.prepare(`SELECT event_type,activity_id,transaction_id,
      symbol,side,quantity,price,occurred_at,raw_json,last_seen_at FROM broker_events
      WHERE owner_id=? AND broker_order_id=? AND event_type IN ('ORDER_STATE','EXECUTION','TRADE')
      ORDER BY event_type`).bind(ownerId, String(brokerOrderId)).all();
    const events = rows.results ?? [];
    const orderRow = events.find((row) => row.event_type === 'ORDER_STATE');
    const executionRow = events.find((row) => row.event_type === 'EXECUTION'
      && String(row.activity_id ?? '') === String(executionActivityId));
    const transactionRow = events.find((row) => row.event_type === 'TRADE'
      && String(row.transaction_id ?? '') === String(transactionActivityId));
    if (!orderRow || !executionRow) throw new Error('MISSING_FILL_ID');
    if (!transactionRow) throw new Error('MISSING_FEE');
    if (executionRow.symbol !== 'SPY' || executionRow.side !== side
      || Number(executionRow.quantity) !== 1 || Number(executionRow.price) !== Number(expectedPrice)
      || iso(executionRow.occurred_at) !== iso(expectedOccurredAt)) {
      throw new Error('LANE_1_STORED_FILL_MISMATCH');
    }
    let order;
    let transaction;
    try {
      order = JSON.parse(orderRow.raw_json);
      transaction = JSON.parse(transactionRow.raw_json);
    } catch { throw new Error('LANE_1_STORED_FILL_MALFORMED_JSON'); }
    order.transactionActivityCollection = [transaction];
    const acquiredAt = iso([orderRow.last_seen_at, executionRow.last_seen_at,
      transactionRow.last_seen_at].sort().at(-1));
    const rawBrokerEvidenceSha256 = await digest(JSON.stringify({ order, transaction }));
    const fill = extractLane1SchwabFill(order, {
      brokerOrderId: String(brokerOrderId), clientOrderId, side,
      acquiredAt, rawBrokerEvidenceSha256,
    });
    if (fill.fillId !== String(executionActivityId)) {
      throw new Error('LANE_1_STORED_FILL_ID_MISMATCH');
    }
    return fill;
  }

  async placeLane1EquityOrder(ownerId, order, { accountHash = null } = {}) {
    if (this.env.NUVO_LANE_1_SPY_ARMED !== 'ON') throw new Error('LANE_1_DISARMED');
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const requestBody = buildLane1SchwabOrder(order);
    const account = await this._laneAccountHash(ownerId, accountHash);
    const response = await fetch(`${TRADER_URL}/accounts/${encodeURIComponent(account.accountHash)}/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${account.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`SCHWAB_LANE_ORDER_${response.status}`);
    return {
      brokerOrderId: schwabOrderIdFromLocation(response.headers.get('location')),
      accountHash: account.accountHash,
      acceptedAt: new Date().toISOString(),
    };
  }

  async previewLane1V2Brackets(ownerId, { accountHash = null } = {}) {
    if (this.env.NUVO_LANE_1_SPY_ARMED !== 'OFF') {
      throw new Error('LANE_1_BRACKET_PREVIEW_REQUIRES_ARMED_OFF');
    }
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const account = await this._laneAccountHash(ownerId, accountHash);
    const previews = [];
    for (const signal of ['LONG', 'SHORT']) {
      const requestBody = buildLane1SchwabBracket({ signal });
      const requestSha256 = await digest(JSON.stringify(requestBody));
      const response = await fetch(`${TRADER_URL}/accounts/${encodeURIComponent(account.accountHash)}/previewOrder`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${account.token}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(10_000),
      });
      const raw = await boundedText(response);
      const rawResponseSha256 = await digest(raw);
      if (!response.ok) {
        throw new Error(`SCHWAB_LANE_BRACKET_PREVIEW_${signal}_${response.status}:${rawResponseSha256}`);
      }
      let preview;
      try { preview = JSON.parse(raw); }
      catch { throw new Error(`SCHWAB_LANE_BRACKET_PREVIEW_${signal}_MALFORMED_JSON`); }
      const validation = preview?.orderValidationResult;
      if (!validation || !Array.isArray(validation.rejects) || !Array.isArray(validation.reviews)
        || validation.rejects.length > 0 || validation.reviews.length > 0) {
        throw new Error(`SCHWAB_LANE_BRACKET_PREVIEW_${signal}_NOT_CLEAR`);
      }
      const echoed = preview?.orderStrategy;
      if (!echoed || echoed.orderStrategyType !== 'TRIGGER') {
        throw new Error(`SCHWAB_LANE_BRACKET_PREVIEW_${signal}_CONTRACT_UNVERIFIED`);
      }
      extractLane1BracketStop(echoed, signal, { requireOrderId: false });
      previews.push({
        signal,
        requestSha256,
        rawResponseSha256,
        orderStrategyType: echoed.orderStrategyType,
        warnings: [...(validation.warns ?? []), ...(validation.alerts ?? [])],
      });
    }
    return {
      contractVersion: LANE_1_SPY_BRACKET_CONTRACT,
      stopOffsetUsd: LANE_1_SPY_STOP_OFFSET_USD,
      accountMask: account.accountMask,
      previews,
      validatedAt: new Date().toISOString(),
    };
  }

  async previewLane1V21Market(ownerId, { instruction }, {
    accountHash = null, captureResponse = null,
  } = {}) {
    if (this.env.NUVO_LANE_1_SPY_ARMED !== 'OFF') {
      throw new Error('LANE_1_MARKET_PREVIEW_REQUIRES_ARMED_OFF');
    }
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const account = await this._laneAccountHash(ownerId, accountHash);
    const requestBody = buildLane1SchwabMarketOrder({ instruction });
    const requestSha256 = await digest(JSON.stringify(requestBody));
    const signal = instruction === 'BUY' ? 'LONG' : instruction === 'SELL_SHORT' ? 'SHORT'
      : instruction === 'SELL' || instruction === 'BUY_TO_COVER' ? 'EXIT' : 'UNKNOWN';
    const prefix = `SCHWAB_LANE_MARKET_PREVIEW_${signal}`;
    let raw = '';
    let response;
    try {
      response = await fetchLane1PreviewOnly(
        `${TRADER_URL}/accounts/${encodeURIComponent(account.accountHash)}/previewOrder`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${account.token}`,
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (captureResponse) {
        let capture;
        try { capture = await captureResponse(response, { requestSha256 }); }
        catch (error) { return { signal, instruction, status: 'DISABLED',
          faultCode: error?.message === 'LANE_1_PREVIEW_CAPTURE_LIMIT_EXCEEDED'
            ? error.message : 'LANE_1_PREVIEW_CAPTURE_FAILED', requestSha256,
          rawResponseSha256: null, warnings: [], validatedAt: new Date().toISOString() }; }
        if (capture.faultCode) return { signal, instruction, status: 'DISABLED',
          faultCode: capture.faultCode, requestSha256,
          rawResponseSha256: capture.evidence.sha256, warnings: [],
          validatedAt: new Date().toISOString() };
        raw = capture.raw;
      } else raw = await boundedText(response);
    } catch (error) {
      if (String(error?.message ?? error) === 'LANE_1_PREVIEW_DESTINATION_REFUSED') throw error;
      return { signal, instruction, status: 'DISABLED', faultCode: `${prefix}_TRANSPORT`,
        requestSha256, rawResponseSha256: await digest(raw), rawResponseBody: raw,
        warnings: [], accountMask: account.accountMask, validatedAt: new Date().toISOString() };
    }
    const rawResponseSha256 = await digest(raw);
    if (!response.ok) return { signal, instruction, status: 'DISABLED',
      faultCode: `${prefix}_${response.status}`, requestSha256, rawResponseSha256,
      rawResponseBody: raw, warnings: [], accountMask: account.accountMask,
      validatedAt: new Date().toISOString() };
    let preview;
    try { preview = JSON.parse(raw); }
    catch { return { signal, instruction, status: 'DISABLED',
      faultCode: `${prefix}_MALFORMED_JSON`, requestSha256, rawResponseSha256,
      rawResponseBody: raw, warnings: [], accountMask: account.accountMask,
      validatedAt: new Date().toISOString() }; }
    const validation = preview?.orderValidationResult;
    // Only omission is empty. Explicit null/scalars/objects remain malformed;
    // any reject or review still blocks, regardless of its message/severity.
    const listsValid = validation && typeof validation === 'object' && !Array.isArray(validation)
      && ['rejects', 'reviews', 'warns', 'alerts'].every((key) =>
        validation[key] === undefined || Array.isArray(validation[key]));
    if (!listsValid || (validation.rejects?.length ?? 0) > 0
      || (validation.reviews?.length ?? 0) > 0) {
      return { signal, instruction, status: 'DISABLED', faultCode: `${prefix}_NOT_CLEAR`,
        requestSha256, rawResponseSha256, rawResponseBody: raw, warnings: [],
        accountMask: account.accountMask, validatedAt: new Date().toISOString() };
    }
    const echoed = preview?.orderStrategy;
    // Bound to captured original 73646c14... (2026-08-31), not request-shaped
    // fixtures: quantity belongs to the order, symbol to the leg's instrument.
    // Order-level quantity is valid here ONLY together with exactly one leg.
    const leg = echoed?.orderLegs?.[0];
    const instrument = leg?.instrument;
    if (!echoed || echoed.orderType !== 'MARKET' || echoed.orderStrategyType !== 'SINGLE'
      || echoed.session !== 'NORMAL' || echoed.duration !== 'DAY'
      || !Array.isArray(echoed.orderLegs) || echoed.orderLegs.length !== 1
      || typeof echoed.quantity !== 'number' || echoed.quantity !== 1
      || echoed.orderLegCollection !== undefined
      || (echoed.childOrderStrategies !== undefined
        && (!Array.isArray(echoed.childOrderStrategies) || echoed.childOrderStrategies.length > 0))
      || leg?.instruction !== instruction
      || typeof instrument?.symbol !== 'string' || instrument.symbol !== 'SPY'
      || !LANE_1_PREVIEW_ASSET_TYPES.includes(leg?.assetType)
      || !LANE_1_PREVIEW_ASSET_TYPES.includes(instrument?.assetType)
      || leg.assetType !== instrument.assetType) {
      return { signal, instruction, status: 'DISABLED',
        faultCode: `${prefix}_CONTRACT_UNVERIFIED`, requestSha256, rawResponseSha256,
        rawResponseBody: raw, warnings: [], accountMask: account.accountMask,
        validatedAt: new Date().toISOString() };
    }
    return { signal, instruction, status: 'CLEAR', requestSha256, rawResponseSha256,
      rawResponseBody: raw, orderStrategyType: 'SINGLE',
      warnings: [...(validation.warns ?? []), ...(validation.alerts ?? [])],
      accountMask: account.accountMask, validatedAt: new Date().toISOString() };
  }

  async previewLane1V21Markets(ownerId, { accountHash = null } = {}) {
    const previews = [];
    for (const [signal, instruction] of [['LONG', 'BUY'], ['SHORT', 'SELL_SHORT']]) {
      const preview = await this.previewLane1V21Market(ownerId, { instruction }, { accountHash });
      if (signal === 'LONG' && preview.status !== 'CLEAR') {
        throw new Error(`${preview.faultCode}:${preview.rawResponseSha256}`);
      }
      previews.push(preview);
    }
    const longEnabled = previews.some((row) => row.signal === 'LONG' && row.status === 'CLEAR');
    const shortEnabled = previews.some((row) => row.signal === 'SHORT' && row.status === 'CLEAR');
    if (!longEnabled) throw new Error('LANE_1_MARKET_PREVIEW_LONG_NOT_CLEAR');
    return { contractVersion: LANE_1_SPY_MARKET_CONTRACT, longEnabled, shortEnabled,
      accountMask: previews[0]?.accountMask ?? null, previews, validatedAt: new Date().toISOString() };
  }

  async lane1V2NetSpyPosition(ownerId, { accountHash = null } = {}) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const account = await this._laneAccountHash(ownerId, accountHash);
    const packet = await this._read(`/accounts/${encodeURIComponent(account.accountHash)}?fields=positions`, account.token);
    return { ...readLane1SpyPosition(packet), acquiredAt: new Date().toISOString(),
      accountHash: account.accountHash };
  }

  async lane1V21SendSnapshot(ownerId, { accountHash = null } = {}) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const account = await this._laneAccountHash(ownerId, accountHash);
    return this._lane1V21SendSnapshot(account);
  }

  async _lane1V21SendSnapshot(account, ordersFrom = new Date(Date.now() - 60 * DAY_MS).toISOString()) {
    const readStartedAt = new Date().toISOString();
    const base = `/accounts/${encodeURIComponent(account.accountHash)}`;
    // Live reads, never D1. Bound: no working SPY orders entered within this
    // 60-day query. Older orders are NOT covered. Principal asserted on
    // 2026-08-31 that none exist in ...315 and none will be placed; not API proof.
    const query = new URLSearchParams({ fromEnteredTime: ordersFrom,
      toEnteredTime: new Date(Date.now() + 60_000).toISOString(), maxResults: '3000' });
    const [packet, orders] = await Promise.all([
      this._read(`${base}?fields=positions`, account.token),
      this._read(`${base}/orders?${query}`, account.token, { completeOrderList: true }),
    ]);
    const position = readLane1SpyPosition(packet);
    const orderStateSha256 = await digest(JSON.stringify(lane1OrderState(orders)));
    return { ...position, accountHash: account.accountHash, orderStateSha256,
      orderCheckBound: 'NO_WORKING_SPY_ORDER_IN_60_DAY_QUERY',
      ordersFrom, ordersTo: query.get('toEnteredTime'), readStartedAt, acquiredAt: new Date().toISOString() };
  }

  async placeLane1V2Bracket(ownerId, { signal }, { accountHash = null } = {}) {
    if (this.env.NUVO_LANE_1_SPY_ARMED !== 'ON') throw new Error('LANE_1_DISARMED');
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const requestBody = buildLane1SchwabBracket({ signal });
    const account = await this._laneAccountHash(ownerId, accountHash);
    const response = await fetch(`${TRADER_URL}/accounts/${encodeURIComponent(account.accountHash)}/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${account.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`SCHWAB_LANE_BRACKET_${response.status}`);
    return {
      brokerOrderId: schwabOrderIdFromLocation(response.headers.get('location')),
      accountHash: account.accountHash,
      acceptedAt: new Date().toISOString(),
      requestSha256: await digest(JSON.stringify(requestBody)),
    };
  }

  async placeLane1V21Market(ownerId, { instruction, clientOrderId }, {
    accountHash = null, durableArm = false, expectedSnapshot = null, readCoordinator = null,
  } = {}) {
    if (this.env.NUVO_LANE_1_SPY_ARMED !== 'ON' && durableArm !== true) {
      throw new Error('LANE_1_DISARMED');
    }
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const requestBody = buildLane1SchwabMarketOrder({ instruction });
    assertLane1SendSnapshot(expectedSnapshot);
    const expected = structuredClone(expectedSnapshot);
    assertLane1InstructionState({ instruction, positionSide: expected.positionSide, quantity: 1 });
    if (typeof readCoordinator !== 'function') throw new Error('LANE_1_DISPATCH_COORDINATOR_REQUIRED');
    const account = await this._laneAccountHash(ownerId, accountHash);
    if (account.accountHash !== expected.accountHash) throw new Error('LANE_1_POSITION_STATE_DRIFT:ACCOUNT_CHANGED');
    // Final reads run after token/account selection and before the only POST.
    // No retries, custody cache, optional-check fallback, or claim creation.
    const current = await this._lane1V21SendSnapshot(account, expected.ordersFrom);
    const state = await readCoordinator();
    assertLane1DispatchCoordinator(state, { instruction, clientOrderId, positionSide: expected.positionSide });
    assertLane1SnapshotUnchanged(expected, current);
    const response = await fetch(`${TRADER_URL}/accounts/${encodeURIComponent(account.accountHash)}/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${account.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`SCHWAB_LANE_MARKET_ORDER_${instruction}_${response.status}`);
    return { brokerOrderId: schwabOrderIdFromLocation(response.headers.get('location')),
      accountHash: account.accountHash, acceptedAt: new Date().toISOString(),
      requestSha256: await digest(JSON.stringify(requestBody)), instruction };
  }

  async readLane1V2BracketStop(ownerId, {
    signal, brokerOrderId, accountHash = null, attempts = 20, pollMs = 250,
  } = {}) {
    const account = await this._laneAccountHash(ownerId, accountHash);
    let lastFault = 'LANE_1_STOP_ORDER_ID_MISSING';
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const order = await this._read(`/accounts/${encodeURIComponent(account.accountHash)}/orders/${encodeURIComponent(brokerOrderId)}`, account.token);
      if (String(order?.orderStrategyType ?? '').toUpperCase() !== 'TRIGGER') {
        throw new Error('LANE_1_BRACKET_PARENT_CONTRACT_INVALID');
      }
      try {
        const stop = extractLane1BracketStop(order, signal);
        if (['CANCELED', 'EXPIRED', 'REJECTED', 'FILLED'].includes(stop.status)) {
          throw new Error(`LANE_1_PROTECTIVE_STOP_TERMINAL_${stop.status}`);
        }
        return { ...stop, acceptedAt: new Date().toISOString(), accountHash: account.accountHash };
      } catch (error) {
        if (error.message !== 'LANE_1_STOP_ORDER_ID_MISSING') throw error;
        lastFault = error.message;
      }
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(lastFault);
  }

  async placeLane1V2Exit(ownerId, { positionSide }, { accountHash = null } = {}) {
    if (this.env.NUVO_LANE_1_SPY_ARMED !== 'ON') throw new Error('LANE_1_DISARMED');
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const requestBody = buildLane1SchwabExit({ positionSide });
    const account = await this._laneAccountHash(ownerId, accountHash);
    const response = await fetch(`${TRADER_URL}/accounts/${encodeURIComponent(account.accountHash)}/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${account.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`SCHWAB_LANE_EXIT_${response.status}`);
    return {
      brokerOrderId: schwabOrderIdFromLocation(response.headers.get('location')),
      accountHash: account.accountHash,
      acceptedAt: new Date().toISOString(),
    };
  }

  async cancelLane1V2Stop(ownerId, { stopOrderId, accountHash = null } = {}) {
    if (this.env.NUVO_LANE_1_SPY_ARMED !== 'ON') throw new Error('LANE_1_DISARMED');
    const account = await this._laneAccountHash(ownerId, accountHash);
    const response = await fetch(`${TRADER_URL}/accounts/${encodeURIComponent(account.accountHash)}/orders/${encodeURIComponent(stopOrderId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${account.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`SCHWAB_LANE_STOP_CANCEL_${response.status}`);
    return { stopOrderId: String(stopOrderId), canceledAt: new Date().toISOString(),
      accountHash: account.accountHash };
  }

  async waitForLane1V2StopCancellation(ownerId, {
    stopOrderId, accountHash = null, attempts = 20, pollMs = 250,
  } = {}) {
    const account = await this._laneAccountHash(ownerId, accountHash);
    let lastStatus = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const order = await this._read(`/accounts/${encodeURIComponent(account.accountHash)}/orders/${encodeURIComponent(stopOrderId)}`, account.token);
      lastStatus = String(order?.status ?? 'UNKNOWN').toUpperCase();
      if (['CANCELED', 'REPLACED', 'EXPIRED'].includes(lastStatus)) {
        return { stopOrderId: String(stopOrderId), status: lastStatus,
          confirmedAt: new Date().toISOString(), accountHash: account.accountHash };
      }
      if (['FILLED', 'REJECTED'].includes(lastStatus)) {
        throw new Error(`LANE_1_STOP_CANCEL_TERMINAL_${lastStatus}`);
      }
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`LANE_1_STOP_CANCEL_TIMEOUT:${lastStatus ?? 'UNKNOWN'}`);
  }

  async placeLane1PrincipalFlattenOrder(ownerId, order, {
    accountHash = null, principalToken = null,
  } = {}) {
    if (this.env.NUVO_LANE_1_SPY_ARMED !== 'OFF') {
      throw new Error('LANE_1_FLATTEN_REQUIRES_ARMED_OFF');
    }
    if (principalToken !== 'FLATTEN_1_SPY' || order?.side !== 'SELL') {
      throw new Error('LANE_1_FLATTEN_AUTHORIZATION_REFUSED');
    }
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const requestBody = buildLane1SchwabOrder(order);
    const account = await this._laneAccountHash(ownerId, accountHash);
    const response = await fetch(`${TRADER_URL}/accounts/${encodeURIComponent(account.accountHash)}/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${account.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`SCHWAB_LANE_FLATTEN_ORDER_${response.status}`);
    return {
      brokerOrderId: schwabOrderIdFromLocation(response.headers.get('location')),
      accountHash: account.accountHash,
      acceptedAt: new Date().toISOString(),
    };
  }

  async waitForLane1PrincipalFlattenFill(ownerId, {
    brokerOrderId, clientOrderId, accountHash = null,
    attempts = 30, pollMs = 500,
  }) {
    if (this.env.NUVO_LANE_1_SPY_ARMED !== 'OFF') {
      throw new Error('LANE_1_FLATTEN_REQUIRES_ARMED_OFF');
    }
    const account = await this._laneAccountHash(ownerId, accountHash);
    let lastStatus = null;
    let lastIdentityFault = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const order = await this._read(`/accounts/${encodeURIComponent(account.accountHash)}/orders/${encodeURIComponent(brokerOrderId)}`, account.token);
      lastStatus = String(order?.status ?? 'UNKNOWN').toUpperCase();
      const acquiredAt = new Date().toISOString();
      const startDate = new Date(Date.parse(acquiredAt) - 60 * 60_000).toISOString();
      const transactions = await this._read(`/accounts/${encodeURIComponent(account.accountHash)}/transactions?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(acquiredAt)}&types=TRADE`, account.token);
      const matching = (transactions ?? []).filter((row) =>
        String(row?.orderId ?? '') === String(brokerOrderId));
      const composite = { ...order, transactionActivityCollection: matching };
      const rawBrokerEvidenceSha256 = await digest(JSON.stringify({ order, transactions: matching }));
      const brokerEvents = [
        ...flattenOrderEvents(order, account.accountMask, acquiredAt),
        ...matching.flatMap((row) => normalizeTransactions(row, account.accountMask, acquiredAt)),
      ];
      await this._persistBrokerEvents(ownerId, brokerEvents, acquiredAt);
      try {
        return extractLane1SchwabFill(composite, {
          brokerOrderId, clientOrderId, side: 'SELL', acquiredAt, rawBrokerEvidenceSha256,
        });
      } catch (error) {
        if (error.message === 'LANE_1_FILL_PENDING' || error.message === 'MISSING_FEE') {
          lastIdentityFault = error.message;
        } else {
          throw error;
        }
      }
      if (['CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED'].includes(lastStatus)) {
        throw new Error(`SCHWAB_LANE_FLATTEN_TERMINAL_${lastStatus}`);
      }
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(lastIdentityFault ?? `SCHWAB_LANE_FLATTEN_FILL_TIMEOUT:${lastStatus ?? 'UNKNOWN'}`);
  }

  async waitForLane1EquityFill(ownerId, {
    brokerOrderId, clientOrderId, side, accountHash = null,
    attempts = 20, pollMs = 500, durableArm = false,
  }) {
    if (this.env.NUVO_LANE_1_SPY_ARMED !== 'ON' && durableArm !== true) {
      throw new Error('LANE_1_DISARMED');
    }
    return this._waitForLane1Fill(ownerId, { brokerOrderId, clientOrderId, side,
      accountHash, attempts, pollMs });
  }

  /** Read-only reconciliation remains available after authority is disarmed. */
  async waitForLane1V2RecordedFill(ownerId, {
    brokerOrderId, clientOrderId, side, accountHash = null,
    attempts = 1, pollMs = 0,
  }) {
    return this._waitForLane1Fill(ownerId, { brokerOrderId, clientOrderId, side,
      accountHash, attempts, pollMs });
  }

  async _waitForLane1Fill(ownerId, {
    brokerOrderId, clientOrderId, side, accountHash = null,
    attempts = 20, pollMs = 500,
  }) {
    const account = await this._laneAccountHash(ownerId, accountHash);
    let lastStatus = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await fetch(`${TRADER_URL}/accounts/${encodeURIComponent(account.accountHash)}/orders/${encodeURIComponent(brokerOrderId)}`, {
        headers: { authorization: `Bearer ${account.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      const raw = await boundedText(response);
      if (!response.ok) throw new Error(`SCHWAB_LANE_ORDER_READ_${response.status}`);
      let order;
      try { order = JSON.parse(raw); } catch { throw new Error('SCHWAB_LANE_ORDER_MALFORMED_JSON'); }
      lastStatus = String(order?.status ?? 'UNKNOWN').toUpperCase();
      const acquiredAt = new Date().toISOString();
      const rawBrokerEvidenceSha256 = await digest(raw);
      try {
        return extractLane1SchwabFill(order, {
          brokerOrderId, clientOrderId, side, acquiredAt, rawBrokerEvidenceSha256,
        });
      } catch (error) {
        if (error.message !== 'LANE_1_FILL_PENDING') throw error;
      }
      if (['CANCELED', 'REJECTED', 'EXPIRED', 'REPLACED'].includes(lastStatus)) {
        throw new Error(`SCHWAB_LANE_ORDER_TERMINAL_${lastStatus}`);
      }
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`SCHWAB_LANE_FILL_TIMEOUT:${lastStatus ?? 'UNKNOWN'}`);
  }

  async _marketRead(path, token) {
    const response = await fetch(`${MARKETDATA_URL}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`SCHWAB_MARKET_DATA_${response.status}:${path.split('?')[0]}`);
    return response.json();
  }

  /**
   * Read-only real-time quote used by the authoritative Schwab market adapter
   * and retained as an independent timestamp check for the legacy Massive
   * fallback. Missing Schwab Market Data entitlement fails closed.
   */
  async marketQuote(ownerId, symbol) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const ticker = String(symbol ?? '').trim().toUpperCase();
    if (!ticker) throw new Error('SCHWAB_MARKET_SYMBOL_REQUIRED');
    const token = await this._accessToken(ownerId);
    const packet = await this._marketRead(`/quotes?symbols=${encodeURIComponent(ticker)}&fields=quote,reference`, token);
    const record = packet?.[ticker]
      ?? Object.values(packet ?? {}).find((candidate) => String(candidate?.symbol ?? '').toUpperCase() === ticker);
    const quote = record?.quote;
    if (!quote || record?.realtime !== true) throw new Error('SCHWAB_MARKET_DATA_NOT_REALTIME');
    const bid = finite(quote.bidPrice);
    const ask = finite(quote.askPrice);
    const lastTrade = finite(quote.lastPrice);
    const mark = finite(quote.mark);
    const twoSided = bid > 0 && ask >= bid;
    const last = mark > 0 ? mark : twoSided ? (bid + ask) / 2 : lastTrade;
    const asOf = Math.max(...[quote.quoteTime, quote.tradeTime, quote.bidTime, quote.askTime]
      .map((value) => epochMs(value)).filter(Number.isFinite));
    if (!(last > 0) || !Number.isFinite(asOf)) throw new Error('SCHWAB_MARKET_QUOTE_INCOMPLETE');
    return {
      value: {
        symbol: ticker,
        last,
        bid: twoSided ? bid : null,
        ask: twoSided ? ask : null,
        freshness: 'REAL_TIME',
        securityStatus: quote.securityStatus ?? null,
      },
      asOf,
      source: 'SCHWAB_MARKET_DATA_REALTIME',
    };
  }

  async marketOptionChain(ownerId, symbol, {
    fromDate,
    toDate,
    strikeCount = 80,
    strike = null,
  } = {}) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const ticker = String(symbol ?? '').trim().toUpperCase();
    if (!ticker) throw new Error('SCHWAB_MARKET_SYMBOL_REQUIRED');
    if (!fromDate || !toDate) throw new Error('SCHWAB_OPTION_CHAIN_DATE_RANGE_REQUIRED');
    const token = await this._accessToken(ownerId);
    const query = new URLSearchParams({
      symbol: ticker,
      contractType: 'ALL',
      includeUnderlyingQuote: 'true',
      strategy: 'SINGLE',
      fromDate,
      toDate,
    });
    if (finite(strike) > 0) query.set('strike', String(finite(strike)));
    else query.set('strikeCount', String(strikeCount));
    const packet = await this._marketRead(`/chains?${query}`, token);
    if (packet?.isDelayed !== false) throw new Error('SCHWAB_OPTION_CHAIN_NOT_REALTIME');
    if (packet?.isChainTruncated === true) throw new Error('SCHWAB_OPTION_CHAIN_TRUNCATED');
    return packet;
  }

  async marketOptionQuote(ownerId, symbol) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const compact = String(symbol ?? '').trim().toUpperCase().replaceAll(' ', '');
    if (!parseOcc(compact)) throw new Error('SCHWAB_OPTION_SYMBOL_INVALID');
    const requestSymbol = schwabOccSymbol(compact);
    const token = await this._accessToken(ownerId);
    const packet = await this._marketRead(`/quotes?symbols=${encodeURIComponent(requestSymbol)}&fields=quote,reference`, token);
    const record = packet?.[requestSymbol] ?? packet?.[compact]
      ?? Object.values(packet ?? {}).find((candidate) =>
        String(candidate?.symbol ?? '').toUpperCase().replaceAll(' ', '') === compact);
    const quote = record?.quote;
    if (!quote || record?.realtime !== true) throw new Error('SCHWAB_OPTION_QUOTE_NOT_REALTIME');
    const bid = finite(quote.bidPrice ?? quote.bid);
    const ask = finite(quote.askPrice ?? quote.ask);
    const mark = finite(quote.mark);
    const last = finite(quote.lastPrice ?? quote.last);
    const mid = bid > 0 && ask >= bid ? (bid + ask) / 2 : mark > 0 ? mark : last;
    const volatility = finite(quote.volatility ?? record.volatility);
    const iv = volatility > 3 ? volatility / 100 : volatility;
    const asOf = Math.max(...[quote.quoteTime, quote.quoteTimeInLong, quote.tradeTime, quote.tradeTimeInLong]
      .map((value) => epochMs(value)).filter(Number.isFinite));
    const value = {
      symbol: compact,
      bid,
      ask,
      mid,
      iv,
      delta: finite(quote.delta ?? record.delta),
      gamma: finite(quote.gamma ?? record.gamma),
      theta: finite(quote.theta ?? record.theta),
      vega: finite(quote.vega ?? record.vega),
      underlyingPrice: finite(quote.underlyingPrice ?? record.underlyingPrice),
      openInterest: finite(quote.openInterest ?? record.openInterest, 0),
      volume: finite(quote.totalVolume ?? record.totalVolume, 0),
      freshness: 'REAL_TIME',
    };
    if (![value.mid, value.iv, value.delta, value.gamma, value.theta, value.vega, asOf]
      .every(Number.isFinite)) throw new Error('SCHWAB_OPTION_QUOTE_INCOMPLETE');
    return { value, asOf, source: 'SCHWAB_MARKET_DATA_OPTION_QUOTE_REALTIME' };
  }

  async marketHistory(ownerId, symbol, { period = 2 } = {}) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const ticker = String(symbol ?? '').trim().toUpperCase();
    if (!ticker) throw new Error('SCHWAB_MARKET_SYMBOL_REQUIRED');
    const token = await this._accessToken(ownerId);
    const query = new URLSearchParams({
      symbol: ticker,
      periodType: 'year',
      period: String(period),
      frequencyType: 'daily',
      frequency: '1',
      needExtendedHoursData: 'false',
      needPreviousClose: 'true',
    });
    return this._marketRead(`/pricehistory?${query}`, token);
  }

  async marketHours(ownerId, { markets = ['equity', 'option'], date = null } = {}) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const token = await this._accessToken(ownerId);
    const query = new URLSearchParams({ markets: markets.join(',') });
    if (date) query.set('date', date);
    return this._marketRead(`/markets?${query}`, token);
  }

  async _persistBrokerEvents(ownerId, brokerEvents, observedAt) {
    const events = (brokerEvents ?? []).filter((event) => event.occurredAt);
    const eventStatements = events.map((event) => {
      const eventKey = normalizedBrokerEventKey(event);
      return this.env.DB.prepare(`INSERT INTO broker_events
        (owner_id,event_key,event_type,broker_order_id,transaction_id,transaction_leg_id,
         activity_id,account_mask,symbol,side,quantity,price,amount,state,occurred_at,
         raw_json,first_seen_at,last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,event_key) DO UPDATE SET
        broker_order_id=excluded.broker_order_id,transaction_id=excluded.transaction_id,
        transaction_leg_id=excluded.transaction_leg_id,activity_id=excluded.activity_id,
        account_mask=excluded.account_mask,symbol=excluded.symbol,side=excluded.side,
        quantity=excluded.quantity,price=excluded.price,amount=excluded.amount,state=excluded.state,
        occurred_at=excluded.occurred_at,raw_json=excluded.raw_json,last_seen_at=excluded.last_seen_at`).bind(
        ownerId, eventKey, event.type ?? 'BROKER_EVENT', event.brokerOrderId ?? null,
        event.transactionId ?? null, event.transactionLegId ?? null, event.activityId ?? null,
        event.accountMask ?? null, event.symbol ?? null, event.side ?? null,
        event.quantity ?? null, event.price ?? null, event.amount ?? null, event.state ?? null,
        event.occurredAt ?? null, JSON.stringify(event.raw ?? {}), observedAt, observedAt,
      );
    });
    for (let offset = 0; offset < eventStatements.length; offset += 50) {
      const chunk = eventStatements.slice(offset, offset + 50);
      if (typeof this.env.DB.batch === 'function') await this.env.DB.batch(chunk);
      else for (const statement of chunk) await statement.run();
    }
    return events.length;
  }

  async backfillLedger(ownerId, { maxWindows = 4, windowDays = 59 } = {}) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const token = await this._accessToken(ownerId);
    const directory = await this._read('/accounts/accountNumbers', token);
    const observedAt = new Date().toISOString();
    const historyFloor = iso(this.env.NUVO_LEDGER_HISTORY_START, '2000-01-01T00:00:00.000Z');
    const results = [];
    for (const number of directory) {
      const accountRef = String(number.hashValue);
      const accountMask = String(number.accountNumber ?? '').slice(-4).padStart(4, '•');
      const accountKey = await digest(accountRef);
      const state = await this.env.DB.prepare(`SELECT coverage_start,coverage_end,cursor_before,
        status,events_ingested,last_error FROM broker_ledger_sync_state
        WHERE owner_id=? AND account_key=?`).bind(ownerId, accountKey).first();
      const earliest = await this.env.DB.prepare(`SELECT MIN(occurred_at) AS earliest
        FROM broker_events WHERE owner_id=? AND account_mask=? AND transaction_id IS NOT NULL`).bind(
        ownerId, accountMask,
      ).first();
      let cursorBefore = state?.cursor_before ?? earliest?.earliest ?? observedAt;
      let ingested = Number(state?.events_ingested ?? 0);
      let status = ['COMPLETE', 'LIMITED'].includes(state?.status) ? state.status : 'RUNNING';
      let lastError = null;
      let windows = 0;
      while (status === 'RUNNING' && windows < Math.max(1, maxWindows)) {
        const window = historicalLedgerWindow(cursorBefore, historyFloor, windowDays);
        if (!window) { status = 'COMPLETE'; break; }
        try {
          const path = `/accounts/${encodeURIComponent(accountRef)}/transactions?startDate=${encodeURIComponent(window.start)}&endDate=${encodeURIComponent(window.end)}&types=${encodeURIComponent(TRANSACTION_TYPES)}`;
          const transactions = await this._read(path, token);
          const events = (transactions ?? []).flatMap((row) => normalizeTransactions(row, accountMask, observedAt));
          await this._persistBrokerEvents(ownerId, events, observedAt);
          cursorBefore = window.start;
          status = window.complete ? 'COMPLETE' : 'RUNNING';
          windows += 1;
        } catch (error) {
          lastError = String(error.message ?? error).slice(0, 240);
          status = /SCHWAB_READ_400/u.test(lastError) ? 'LIMITED' : 'FAILED';
          break;
        }
      }
      const stored = await this.env.DB.prepare(`SELECT COUNT(*) AS count FROM broker_events
        WHERE owner_id=? AND account_mask=? AND transaction_id IS NOT NULL`).bind(
        ownerId, accountMask,
      ).first();
      ingested = Number(stored?.count ?? ingested);
      await this.env.DB.prepare(`INSERT INTO broker_ledger_sync_state
        (owner_id,account_key,account_mask,coverage_start,coverage_end,cursor_before,status,
         events_ingested,last_error,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner_id,account_key) DO UPDATE SET
        account_mask=excluded.account_mask,coverage_start=excluded.coverage_start,
        coverage_end=excluded.coverage_end,cursor_before=excluded.cursor_before,
        status=excluded.status,events_ingested=excluded.events_ingested,
        last_error=excluded.last_error,updated_at=excluded.updated_at`).bind(
        ownerId, accountKey, accountMask, cursorBefore, observedAt, cursorBefore, status,
        ingested, lastError, observedAt,
      ).run();
      results.push({ accountMask, coverageStart: cursorBefore, coverageEnd: observedAt,
        status, eventsIngested: ingested, windows, lastError });
    }
    return { asOf: observedAt, historyFloor, accounts: results,
      complete: results.length > 0 && results.every((row) => row.status === 'COMPLETE') };
  }

  async ledgerStatus(ownerId) {
    const [states, totals, anomalies] = await Promise.all([
      this.env.DB.prepare(`SELECT account_mask,coverage_start,coverage_end,status,
        events_ingested,last_error,updated_at FROM broker_ledger_sync_state
        WHERE owner_id=? ORDER BY account_mask`).bind(ownerId).all(),
      this.env.DB.prepare(`SELECT COUNT(*) AS event_count,
        COUNT(DISTINCT transaction_id) AS transaction_count,
        MIN(CASE WHEN transaction_id IS NOT NULL THEN occurred_at END) AS earliest_transaction,
        MAX(CASE WHEN transaction_id IS NOT NULL THEN occurred_at END) AS latest_transaction
        FROM broker_events WHERE owner_id=?`).bind(ownerId).first(),
      this.env.DB.prepare(`SELECT COUNT(*) AS count FROM broker_observation_anomalies
        WHERE owner_id=?`).bind(ownerId).first(),
    ]);
    const accounts = states.results ?? [];
    return { accounts, ...totals,
      observation_chain_anomalies: Number(anomalies?.count ?? 0),
      complete: accounts.length > 0 && accounts.every((row) => row.status === 'COMPLETE') };
  }

  async snapshot(ownerId) {
    try { return await this._snapshot(ownerId); }
    catch (error) {
      const at = new Date().toISOString();
      await this.env.DB.prepare(`UPDATE broker_connections SET status='DEGRADED',
        last_error_code=?,updated_at=? WHERE owner_id=?`).bind(
        String(error.message ?? 'SCHWAB_READ_FAILED').slice(0, 240), at, ownerId,
      ).run().catch(() => {});
      throw error;
    }
  }

  async _snapshot(ownerId) {
    if (!this.configured()) throw new Error('SCHWAB_READ_ONLY_NOT_CONFIGURED');
    const token = await this._accessToken(ownerId);
    const [directory, accountPackets] = await Promise.all([
      this._read('/accounts/accountNumbers', token),
      this._read('/accounts?fields=positions', token),
    ]);
    const observedAt = new Date().toISOString();
    const accounts = directory.map((number) => {
      const packet = accountPackets.find((candidate) => String(candidate?.securitiesAccount?.accountNumber ?? '') === String(number.accountNumber));
      if (!packet) throw new Error('SCHWAB_ACCOUNT_SNAPSHOT_MISSING');
      const account = packet.securitiesAccount;
      // Retain each Schwab position object intact for the sealed observation.
      // Normalization below remains the operational projection, not the evidence source.
      const rawPositions = Array.isArray(account.positions) ? account.positions : [];
      const normalizedPositions = rawPositions.map(normalizePosition);
      if (normalizedPositions.some((position) => !position.symbol || !Number.isFinite(position.quantity))) {
        throw new Error('SCHWAB_POSITION_QUANTITY_INCOMPLETE');
      }
      const positions = normalizedPositions.filter((position) => position.quantity !== 0);
      const balances = account.currentBalances ?? {};
      const positionMarketValue = positions.every((position) => Number.isFinite(position.marketValue))
        ? positions.reduce((sum, position) => sum + position.marketValue, 0) : null;
      const dayProfitLoss = positions.every((position) => Number.isFinite(position.dayProfitLoss))
        ? cents(positions.reduce((sum, position) => sum + position.dayProfitLoss, 0)) : null;
      const nav = finite(balances.liquidationValue ?? balances.equity);
      const reportedCash = finite(balances.cashBalance ?? balances.moneyMarketFund ?? balances.availableFunds);
      // In a margin account Schwab may report cashBalance=0 while the marked
      // positions exceed liquidation value. Net liquidation less marked
      // positions is the actual cash/debit that must reconcile economically.
      const cash = nav != null && positionMarketValue != null
        ? nav - positionMarketValue : reportedCash;
      return {
        accountRef: String(number.hashValue),
        accountMask: String(number.accountNumber ?? '').slice(-4).padStart(4, '•'),
        cash, reportedCashBalance: reportedCash,
        buyingPower: finite(balances.buyingPower ?? balances.buyingPowerNonMarginableTrade),
        withdrawableCash: finite(balances.cashAvailableForWithdrawal ?? balances.availableFundsNonMarginableTrade
          ?? balances.cashAvailableForTrading),
        marginBalance: finite(balances.marginBalance),
        marginDebit: Math.max(0, -(finite(balances.marginBalance, cash) ?? 0)),
        nav, dayProfitLoss, dayProfitLossPositionCount: positions.length, positions, rawPositions,
      };
    });
    if (accounts.some((account) => ![account.cash, account.buyingPower, account.nav].every(Number.isFinite))) {
      throw new Error('SCHWAB_ACCOUNT_BALANCES_INCOMPLETE');
    }
    const latestTransaction = await this.env.DB.prepare(`SELECT MAX(occurred_at) AS latest
      FROM broker_events WHERE owner_id=? AND transaction_id IS NOT NULL`).bind(ownerId).first();
    const latestTransactionMs = Date.parse(latestTransaction?.latest ?? '');
    const ledgerFloorMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const transactionFromMs = Number.isFinite(latestTransactionMs)
      ? Math.max(ledgerFloorMs, latestTransactionMs - 3 * 24 * 60 * 60 * 1000)
      : ledgerFloorMs;
    const transactionFrom = new Date(transactionFromMs).toISOString();
    const orderFrom = new Date(ledgerFloorMs).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const brokerPackets = await Promise.all(accounts.map(async (account) => {
      const orders = await this._read(`/accounts/${encodeURIComponent(account.accountRef)}/orders?fromEnteredTime=${encodeURIComponent(orderFrom)}&toEnteredTime=${encodeURIComponent(to)}&maxResults=3000`, token);
      let transactions = [];
      try {
        transactions = await this._read(`/accounts/${encodeURIComponent(account.accountRef)}/transactions?startDate=${encodeURIComponent(transactionFrom)}&endDate=${encodeURIComponent(to)}&types=${encodeURIComponent(TRANSACTION_TYPES)}`, token);
      } catch (error) {
        // A complete ledger is a required truth source. Do not silently turn
        // an unavailable transaction endpoint into an empty ledger.
        throw new Error(`SCHWAB_TRANSACTION_LEDGER_UNAVAILABLE:${error.message}`);
      }
      return {
        orders: orders.flatMap((order) => flattenOrders(order, account.accountRef, observedAt)),
        events: [
          ...orders.flatMap((order) => flattenOrderEvents(order, account.accountMask, observedAt)),
          ...(transactions ?? []).flatMap((row) => normalizeTransactions(row, account.accountMask, observedAt)),
        ],
      };
    }));
    accounts.forEach((account, index) => {
      account.positions = account.positions.map((position) => reconcilePositionDayProfitLoss(
        position, brokerPackets[index]?.events ?? [], observedAt,
      ));
      account.rawDayProfitLoss = account.positions.every((position) => Number.isFinite(position.rawDayProfitLoss))
        ? cents(account.positions.reduce((sum, position) => sum + position.rawDayProfitLoss, 0)) : null;
      account.dayProfitLoss = account.positions.every((position) => Number.isFinite(position.dayProfitLoss))
        ? cents(account.positions.reduce((sum, position) => sum + position.dayProfitLoss, 0)) : null;
      account.dayProfitLossAdjustmentCount = account.positions.filter(
        (position) => position.dayProfitLossSource === 'SCHWAB_RECONCILED_CARRIED_CURRENT_DAY_COST',
      ).length;
    });
    const orderRows = brokerPackets.map((packet) => packet.orders);
    const brokerEvents = brokerPackets.flatMap((packet) => packet.events).filter((event) => event.occurredAt);
    const rawPositionPackets = accounts.map(({ accountMask, rawPositions }) => ({
      accountMask,
      positions: rawPositions,
    }));
    const snapshot = {
      asOf: Date.parse(observedAt),
      cash: accounts.reduce((sum, account) => sum + account.cash, 0),
      buyingPower: accounts.reduce((sum, account) => sum + account.buyingPower, 0),
      withdrawableCash: accounts.every((account) => Number.isFinite(account.withdrawableCash))
        ? accounts.reduce((sum, account) => sum + account.withdrawableCash, 0) : null,
      marginDebit: accounts.reduce((sum, account) => sum + account.marginDebit, 0),
      nav: accounts.reduce((sum, account) => sum + account.nav, 0),
      dayProfitLoss: accounts.every((account) => Number.isFinite(account.dayProfitLoss))
        ? cents(accounts.reduce((sum, account) => sum + account.dayProfitLoss, 0)) : null,
      dayProfitLossPositionCount: accounts.reduce(
        (sum, account) => sum + account.dayProfitLossPositionCount, 0,
      ),
      rawDayProfitLoss: accounts.every((account) => Number.isFinite(account.rawDayProfitLoss))
        ? cents(accounts.reduce((sum, account) => sum + account.rawDayProfitLoss, 0)) : null,
      dayProfitLossAdjustmentCount: accounts.reduce(
        (sum, account) => sum + account.dayProfitLossAdjustmentCount, 0,
      ),
      positions: aggregatePositions(accounts.flatMap((account) => account.positions)),
      rawPositionPackets,
      openOrders: orderRows.flat().filter(isOpenOrder),
      accounts: accounts.map(({ accountRef, accountMask, cash, reportedCashBalance, buyingPower,
        withdrawableCash, marginBalance, marginDebit, nav, rawDayProfitLoss, dayProfitLoss,
        dayProfitLossPositionCount, dayProfitLossAdjustmentCount }) => ({
        accountRef, accountMask, cash, reportedCashBalance, buyingPower,
        withdrawableCash, marginBalance, marginDebit, nav, rawDayProfitLoss, dayProfitLoss,
        dayProfitLossPositionCount, dayProfitLossAdjustmentCount,
      })),
      brokerEvents,
    };
    const account = {
      cash: snapshot.cash,
      buyingPower: snapshot.buyingPower,
      withdrawableCash: snapshot.withdrawableCash,
      marginDebit: snapshot.marginDebit,
      nav: snapshot.nav,
      dayProfitLoss: snapshot.dayProfitLoss,
      rawDayProfitLoss: snapshot.rawDayProfitLoss,
      dayProfitLossPositionCount: snapshot.dayProfitLossPositionCount,
      dayProfitLossAdjustmentCount: snapshot.dayProfitLossAdjustmentCount,
      dayProfitLossField: 'securitiesAccount.positions[].currentDayProfitLoss; carried currentDayCost reconciled with instrument.netChange x previousSession signed quantity x multiplier when the sealed same-session ledger has no trade',
      dayProfitLossSource: snapshot.dayProfitLoss == null
        ? 'INCOMPLETE_SCHWAB_POSITION_CURRENT_DAY_PROFIT_LOSS'
        : 'SCHWAB_SUM_RECONCILED_POSITION_DAY_PROFIT_LOSS',
      accounts: snapshot.accounts.map(({ accountMask, cash, reportedCashBalance, buyingPower,
        withdrawableCash, marginBalance, marginDebit, nav, rawDayProfitLoss, dayProfitLoss,
        dayProfitLossPositionCount, dayProfitLossAdjustmentCount }) => ({
        accountMask, cash, reportedCashBalance, buyingPower,
        withdrawableCash, marginBalance, marginDebit, nav, rawDayProfitLoss, dayProfitLoss,
        dayProfitLossPositionCount, dayProfitLossAdjustmentCount,
      })),
    };
    const snapshotHash = await digest(JSON.stringify({
      account, positions: snapshot.positions, rawPositionPackets, openOrders: snapshot.openOrders,
    }));
    await this.env.DB.prepare(`INSERT INTO custody_latest
      (owner_id,snapshot_hash,account_json,positions_json,orders_json,observed_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET
      snapshot_hash=excluded.snapshot_hash,account_json=excluded.account_json,
      positions_json=excluded.positions_json,orders_json=excluded.orders_json,
      observed_at=excluded.observed_at,updated_at=excluded.updated_at`).bind(
      ownerId, snapshotHash, JSON.stringify(account), JSON.stringify(snapshot.positions),
      JSON.stringify(snapshot.openOrders), observedAt, observedAt,
    ).run();
    const previousObservation = await this.env.DB.prepare(`SELECT chain_hash FROM broker_observations
      WHERE owner_id=? ORDER BY observed_at DESC LIMIT 1`).bind(ownerId).first();
    const previousChainHash = previousObservation?.chain_hash ?? `NUVO-GUARDIAN-GENESIS:${ownerId}`;
    const chainHash = await digest(`${previousChainHash}|${snapshotHash}|${observedAt}`);
    const observationId = crypto.randomUUID();
    await this.env.DB.prepare(`INSERT INTO broker_observations
      (owner_id,observation_id,snapshot_hash,previous_chain_hash,chain_hash,account_json,
       positions_json,raw_positions_json,orders_json,observed_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      ownerId, observationId, snapshotHash, previousChainHash, chainHash,
      JSON.stringify(account), JSON.stringify(snapshot.positions), JSON.stringify(rawPositionPackets),
      JSON.stringify(snapshot.openOrders), observedAt, observedAt,
    ).run();
    const persistedEventCount = await this._persistBrokerEvents(ownerId, brokerEvents, observedAt);
    const markStatements = snapshot.positions.map((position) => {
      const mark = Number.isFinite(position.marketValue) && position.quantity !== 0
        ? position.marketValue / (position.quantity * position.multiplier) : null;
      const signedCost = Number.isFinite(position.averagePrice)
        ? position.quantity * position.multiplier * position.averagePrice : null;
      const unrealizedPnl = mark == null || signedCost == null ? null : position.marketValue - signedCost;
      return this.env.DB.prepare(`INSERT INTO broker_position_marks
        (owner_id,observation_id,snapshot_hash,symbol,underlying,asset_class,quantity,
         multiplier,average_price,mark,market_value,unrealized_pnl,observed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        ownerId, observationId, snapshotHash, position.symbol, position.underlying,
        position.type, position.quantity, position.multiplier, position.averagePrice,
        mark, position.marketValue, unrealizedPnl, observedAt,
      );
    });
    if (markStatements.length) {
      if (typeof this.env.DB.batch === 'function') await this.env.DB.batch(markStatements);
      else for (const statement of markStatements) await statement.run();
    }
    const unrealizedValues = snapshot.positions.map((position) => Number.isFinite(position.marketValue)
      && Number.isFinite(position.averagePrice)
      ? position.marketValue - position.quantity * position.multiplier * position.averagePrice : null);
    const totalUnrealizedPnl = unrealizedValues.every(Number.isFinite)
      ? unrealizedValues.reduce((sum, value) => sum + value, 0) : null;
    await this.env.DB.prepare(`INSERT INTO broker_account_performance
      (owner_id,snapshot_hash,nav,cash,margin_debit,gross_position_value,unrealized_pnl,
       position_count,open_order_count,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
      ownerId, snapshotHash, snapshot.nav, snapshot.cash, snapshot.marginDebit,
      snapshot.positions.reduce((sum, position) => sum + Math.abs(position.marketValue ?? 0), 0),
      totalUnrealizedPnl, snapshot.positions.length, snapshot.openOrders.length, observedAt,
    ).run();
    const priorBaseline = await this.env.DB.prepare(`SELECT snapshot_hash FROM custody_baselines
      WHERE owner_id=? AND active=1`).bind(ownerId).first();
    await this.env.DB.prepare(`INSERT INTO custody_baselines
      (owner_id,snapshot_hash,account_json,positions_json,orders_json,observed_at,
       active,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)
      ON CONFLICT(owner_id) DO UPDATE SET snapshot_hash=excluded.snapshot_hash,
      account_json=excluded.account_json,positions_json=excluded.positions_json,
      orders_json=excluded.orders_json,observed_at=excluded.observed_at,active=1,
      updated_at=excluded.updated_at`).bind(
      ownerId, snapshotHash, JSON.stringify(account), JSON.stringify(snapshot.positions),
      JSON.stringify(snapshot.openOrders), observedAt, observedAt, observedAt,
    ).run();
    const reconciliationId = crypto.randomUUID();
    await this.env.DB.prepare(`INSERT INTO broker_reconciliation_runs
      (owner_id,reconciliation_id,snapshot_hash,prior_snapshot_hash,status,position_count,
       open_order_count,event_count,detail_json,reconciled_at)
      VALUES (?,?,?,?,'COMPLETE',?,?,?,?,?)`).bind(
      ownerId, reconciliationId, snapshotHash, priorBaseline?.snapshot_hash ?? null,
      snapshot.positions.length, snapshot.openOrders.length, persistedEventCount,
      JSON.stringify({ source: 'SCHWAB_CUSTODY_AND_TRANSACTION_LEDGER',
        accountCount: accounts.length, observationId, observationChainHash: chainHash,
        dayProfitLossField: account.dayProfitLossField,
        rawPositionRowsSealed: rawPositionPackets.reduce((sum, row) => sum + row.positions.length, 0) }),
      observedAt,
    ).run();
    await this.env.DB.prepare(`UPDATE broker_connections SET status='CONNECTED',
      last_successful_sync_at=?,last_error_code=NULL,updated_at=? WHERE owner_id=?`).bind(
      observedAt, observedAt, ownerId,
    ).run();
    return { ...snapshot, snapshotHash, observationChainHash: chainHash,
      reconciliationId, reconciliationStatus: 'COMPLETE' };
  }

  async status(ownerId) {
    const row = await this.env.DB.prepare(`SELECT status,last_successful_sync_at,last_error_code,updated_at
      FROM broker_connections WHERE owner_id=?`).bind(ownerId).first();
    return row ?? { status: 'DISCONNECTED', last_successful_sync_at: null, last_error_code: null };
  }
}
