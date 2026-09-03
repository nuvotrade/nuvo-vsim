import { DataProvider } from './provider.js';

const DAY_MS = 86_400_000;
const RIGHTS = Object.freeze(['put', 'call']);

function numeric(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function timestamp(value, fallback = null) {
  const number = numeric(value);
  if (number != null) {
    if (number > 1e17) return Math.floor(number / 1e6);
    if (number > 1e14) return Math.floor(number / 1e3);
    if (number > 1e11) return number;
    if (number > 1e9) return number * 1000;
  }
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ymd(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function ivDecimal(value) {
  const parsed = numeric(value);
  if (!(parsed > 0)) return null;
  return parsed > 3 ? parsed / 100 : parsed;
}

function flattenExpirationMap(map, right) {
  return Object.values(map ?? {}).flatMap((strikes) => Object.values(strikes ?? {}).flat())
    .map((row) => ({ ...row, _right: right }));
}

function nearestListedDtes(rows, targets) {
  const available = [...new Set(rows.map((row) => numeric(row.daysToExpiration))
    .filter((value) => Number.isFinite(value) && value >= 0))];
  return new Set(targets.map((target) => available.slice()
    .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)[0])
    .filter(Number.isFinite));
}

function marketNodes(packet) {
  const nodes = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.isOpen === 'boolean' && value.sessionHours) nodes.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(packet);
  return nodes;
}

export function sessionStatus(packet, now) {
  const nodes = marketNodes(packet);
  const option = nodes.find((node) => String(node.marketType ?? node.category ?? '').toUpperCase().includes('OPTION'))
    ?? nodes.find((node) => String(node.product ?? '').toUpperCase().includes('OPTION'))
    ?? nodes[0];
  if (!option) return null;
  const current = now;
  const intervals = (name) => (option.sessionHours?.[name] ?? []).map((period) => ({
    start: timestamp(period.start), end: timestamp(period.end),
  })).filter((period) => Number.isFinite(period.start) && Number.isFinite(period.end));
  const contains = (periods) => periods.some((period) => current >= period.start && current <= period.end);
  const regular = intervals('regularMarket');
  const pre = intervals('preMarket');
  const post = intervals('postMarket');
  if (contains(regular)) return 'OPEN';
  if (contains(pre)) return 'PRE';
  if (contains(post)) return 'POST';
  // Schwab's top-level isOpen can become true before the options regular
  // session begins. When timestamped session intervals are present they are
  // the authority; never promote an out-of-interval instant to OPEN.
  if (regular.length || pre.length || post.length) return 'CLOSED';
  return option.isOpen ? 'OPEN' : 'CLOSED';
}

/**
 * Read-only Schwab market-data adapter.
 *
 * Schwab computes no VSIM decisions. This class only normalizes authenticated
 * Market Data Production responses into the deterministic DataProvider
 * contract. Any delayed, truncated, stale, or incomplete packet is refused.
 */
export class SchwabMarketProvider extends DataProvider {
  constructor({
    client,
    ownerId,
    now = () => Date.now(),
    dteTargets = [14, 30, 45],
    maxChainAgeMs = 120_000,
    maxQuoteAgeMs = 60_000,
    eventProvider = null,
    vixSymbol = '$VIX',
  } = {}) {
    super('schwab');
    if (!client) throw new Error('SchwabMarketProvider requires client.');
    if (!ownerId) throw new Error('SchwabMarketProvider requires ownerId.');
    this.client = client;
    this.ownerId = ownerId;
    this.now = now;
    this.dteTargets = [...dteTargets];
    this.maxChainAgeMs = maxChainAgeMs;
    this.maxQuoteAgeMs = maxQuoteAgeMs;
    this.eventProvider = eventProvider;
    this.vixSymbol = String(vixSymbol).trim().toUpperCase();
    this.quoteCache = new Map();
    this.historyCache = new Map();
  }

  async _quote(symbol) {
    const key = String(symbol).toUpperCase();
    if (!this.quoteCache.has(key)) {
      this.quoteCache.set(key, this.client.marketQuote(this.ownerId, key));
    }
    const quote = await this.quoteCache.get(key);
    if (!Number.isFinite(quote?.asOf) || this.now() - quote.asOf > this.maxQuoteAgeMs
      || quote.asOf > this.now() + 10_000) throw new Error('SCHWAB_MARKET_QUOTE_STALE');
    return quote;
  }

  async markQuote(symbol) {
    try { return await this._quote(symbol); }
    catch (error) { return { error: error.message }; }
  }

  async history(symbol, { lookback = 400, minBars = 120 } = {}) {
    try {
      const key = String(symbol).toUpperCase();
      if (!this.historyCache.has(key)) {
        this.historyCache.set(key, this.client.marketHistory(this.ownerId, key, { period: 2 }));
      }
      const packet = await this.historyCache.get(key);
      const bars = (packet?.candles ?? []).map((bar) => ({
        t: timestamp(bar.datetime), o: numeric(bar.open), h: numeric(bar.high),
        l: numeric(bar.low), c: numeric(bar.close), v: numeric(bar.volume, 0),
      })).filter((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c].every(Number.isFinite))
        .sort((a, b) => a.t - b.t)
        .filter((bar, index, rows) => index === 0 || bar.t !== rows[index - 1].t)
        .slice(-lookback);
      if (packet?.empty === true || bars.length < minBars) {
        return { error: `SCHWAB_HISTORY_SHORT:${bars.length}` };
      }
      return { value: bars, asOf: bars.at(-1).t, source: 'SCHWAB_MARKET_DATA_PRICE_HISTORY' };
    } catch (error) {
      return { error: error.message };
    }
  }

  async quote(symbol) {
    try {
      const [quote, history] = await Promise.all([
        this._quote(symbol),
        this.history(symbol, { lookback: 120 }),
      ]);
      if (history.error) return history;
      const adv = history.value.reduce((sum, bar) => sum + numeric(bar.v, 0), 0)
        / history.value.length;
      return {
        value: {
          ...quote.value,
          volume: numeric(history.value.at(-1)?.v, 0),
          adv,
          sector: 'UNKNOWN',
          beta: null,
          underlyingMarket: Number.isFinite(quote.value.bid) && Number.isFinite(quote.value.ask)
            ? 'TWO_SIDED' : 'MARK_ONLY',
          markTimestampBasis: 'SCHWAB_MARKET_DATA_QUOTE',
        },
        asOf: quote.asOf,
        source: quote.source,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async optionChain(symbol, {
    expirations = this.dteTargets, strikes = [], rights = RIGHTS, includePartial = false,
  } = {}) {
    try {
      const requestedRights = [...new Set((Array.isArray(rights) ? rights : [])
        .map((right) => String(right).toLowerCase()))];
      if (!requestedRights.length || requestedRights.some((right) => !RIGHTS.includes(right))) {
        return { error: 'SCHWAB_OPTION_RIGHTS_INVALID' };
      }
      const start = Math.max(0, Math.min(...expirations) - 5);
      const end = Math.max(...expirations) + 8;
      const [packet, underlying] = await Promise.all([
        this.client.marketOptionChain(this.ownerId, symbol, {
          fromDate: ymd(this.now() + start * DAY_MS),
          toDate: ymd(this.now() + end * DAY_MS),
          strike: strikes.length === 1 ? numeric(strikes[0]) : null,
        }),
        this._quote(symbol),
      ]);
      const raw = [
        ...flattenExpirationMap(packet.putExpDateMap, 'put'),
        ...flattenExpirationMap(packet.callExpDateMap, 'call'),
      ];
      const selectedDtes = nearestListedDtes(raw, expirations);
      const now = this.now();
      const rows = raw.map((row) => {
        const right = String(row.putCall ?? row._right).toLowerCase();
        const dte = numeric(row.daysToExpiration);
        const bid = numeric(row.bid ?? row.bidPrice);
        const ask = numeric(row.ask ?? row.askPrice);
        const quoteAsOf = timestamp(row.quoteTimeInLong ?? row.quoteTime ?? row.tradeTimeInLong);
        return {
          symbol: String(row.symbol ?? '').replaceAll(' ', ''),
          underlying: String(symbol).toUpperCase(),
          right,
          strike: numeric(row.strikePrice),
          expiration: row.expirationDate
            ? ymd(timestamp(row.expirationDate)) : null,
          dte,
          bid,
          ask,
          mid: bid > 0 && ask >= bid ? (bid + ask) / 2 : numeric(row.mark),
          iv: ivDecimal(row.volatility ?? row.theoreticalVolatility),
          delta: numeric(row.delta),
          gamma: numeric(row.gamma),
          theta: numeric(row.theta),
          vega: numeric(row.vega),
          greekUnits: {
            delta: 'PER_SHARE_EQUIVALENT',
            gamma: 'PER_SHARE_EQUIVALENT_PER_UNDERLYING_DOLLAR',
            vega: 'PREMIUM_DOLLARS_PER_SHARE_PER_VOL_POINT',
            theta: 'PREMIUM_DOLLARS_PER_SHARE_PER_CALENDAR_DAY',
          },
          openInterest: numeric(row.openInterest, 0),
          volume: numeric(row.totalVolume, 0),
          multiplier: numeric(row.multiplier, 100),
          quoteAsOf,
        };
      }).filter((row) => {
        const core = row.symbol && requestedRights.includes(row.right) && selectedDtes.has(row.dte)
          && [row.strike, row.dte, row.bid, row.quoteAsOf].every(Number.isFinite)
          && row.strike > 0 && row.bid >= 0
          && row.quoteAsOf <= now + 10_000 && now - row.quoteAsOf <= this.maxChainAgeMs;
        if (!core || includePartial) return core;
        return [row.ask, row.iv, row.delta].every(Number.isFinite)
          && row.iv > 0 && Math.abs(row.delta) <= 1
          && (row.right === 'put' ? row.delta <= 0 : row.delta >= 0)
          && row.bid > 0 && row.ask >= row.bid;
      });
      const contracts = [...new Map(rows.map((row) => [row.symbol, row])).values()];
      const complete = [...selectedDtes].every((dte) => requestedRights.every((right) =>
        contracts.some((contract) => contract.dte === dte && contract.right === right)));
      if ((!includePartial && !complete) || contracts.length === 0) {
        return { error: 'SCHWAB_EXECUTABLE_CHAIN_UNAVAILABLE' };
      }
      const asOf = Math.min(...contracts.map((row) => row.quoteAsOf));
      return {
        value: {
          underlying: String(symbol).toUpperCase(),
          spot: underlying.value.last,
          contracts,
          asOf,
          underlyingAsOf: underlying.asOf,
          underlyingSource: underlying.source,
        },
        asOf,
        source: 'SCHWAB_MARKET_DATA_OPTIONS_REALTIME',
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async optionQuote(symbol) {
    try {
      const quote = await this.client.marketOptionQuote(this.ownerId, symbol);
      if (!Number.isFinite(quote?.asOf) || this.now() - quote.asOf > this.maxChainAgeMs
        || quote.asOf > this.now() + 10_000) return { error: 'SCHWAB_OPTION_QUOTE_STALE' };
      return quote;
    } catch (error) {
      return { error: error.message };
    }
  }

  async events(symbol) {
    if (!this.eventProvider) return { error: 'SCHWAB_EVENT_CLEARANCE_NOT_CONFIGURED' };
    return this.eventProvider.events(symbol);
  }

  async marketState() {
    try {
      const date = ymd(this.now());
      const [hours, vix, history] = await Promise.all([
        this.client.marketHours(this.ownerId, { date }),
        this._quote(this.vixSymbol),
        this.history('SPY', { lookback: 252 }),
      ]);
      if (history.error) return history;
      const status = sessionStatus(hours, this.now());
      const closes = history.value.map((bar) => numeric(bar.c)).filter(Number.isFinite);
      const peak = closes.length ? Math.max(...closes) : null;
      const drawdown = peak > 0 ? (closes.at(-1) - peak) / peak : null;
      if (!status) return { error: 'SCHWAB_MARKET_SESSION_UNVERIFIED' };
      return {
        value: {
          status,
          vix: vix.value.last,
          vix3m: null,
          drawdown,
          vixSource: vix.source,
          vixAsOf: vix.asOf,
        },
        asOf: this.now(),
        source: 'SCHWAB_MARKET_HOURS',
      };
    } catch (error) {
      return { error: error.message };
    }
  }
}
