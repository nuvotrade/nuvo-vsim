import { DataProvider } from './provider.js';

const DAY_MS = 86_400_000;
const RIGHTS = Object.freeze(['put', 'call']);

function numeric(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function timestamp(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function eventAt(event) {
  return timestamp(event.eventTimeUtc)
    ?? timestamp(event.date ? `${event.date}T16:00:00Z` : null);
}

function normalizedFreshness(value) {
  return String(value ?? '').trim().toUpperCase().replaceAll('_', '-').replaceAll(' ', '-');
}

function isRealtime(value) {
  return ['REALTIME', 'REAL-TIME', 'LIVE'].includes(normalizedFreshness(value));
}

function isExplicitlyDelayed(value) {
  return ['DELAYED', 'DAY-CLOSE', 'PREV-CLOSE', 'PREVIOUS-CLOSE']
    .includes(normalizedFreshness(value));
}

function normalizeMarketSession(value, now) {
  const status = String(value ?? '').trim().toUpperCase().replaceAll('_', '-').replaceAll(' ', '-');
  if (['OPEN', 'CLOSED', 'PRE', 'POST'].includes(status)) return status;
  if (['PRE-MARKET', 'PREMARKET'].includes(status)) return 'PRE';
  if (['AFTER-HOURS', 'AFTERHOURS', 'POST-MARKET', 'POSTMARKET'].includes(status)) return 'POST';
  if (['EXTENDED-HOURS', 'EXTENDEDHOURS'].includes(status)) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(now));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    const minutes = hour * 60 + minute;
    return minutes < 9 * 60 + 30 ? 'PRE' : 'POST';
  }
  return null;
}

/**
 * Massive/Polygon adapter backed by NUVO's private market-data Worker.
 *
 * The adapter intentionally accepts a fetch function instead of an API key.
 * Production supplies a Cloudflare service binding, keeping the Massive
 * credential inside the existing market Worker. Tests supply a deterministic
 * in-memory fetcher.
 */
export class MassiveProvider extends DataProvider {
  constructor({
    fetcher,
    now = () => Date.now(),
    dteTargets = [14, 30, 45],
    maxChainAgeMs = 120_000,
    maxQuoteAgeMs = 60_000,
    fundSymbols = [],
    underlyingQuoteFetcher = null,
    requireRealtimeUnderlying = true,
    vixSymbol = null,
  } = {}) {
    super('massive');
    if (typeof fetcher !== 'function') throw new Error('MassiveProvider requires fetcher.');
    this.fetcher = fetcher;
    this.now = now;
    this.dteTargets = [...dteTargets];
    this.maxChainAgeMs = maxChainAgeMs;
    this.maxQuoteAgeMs = maxQuoteAgeMs;
    this.fundSymbols = new Set(fundSymbols.map((symbol) => String(symbol).toUpperCase()));
    this.underlyingQuoteFetcher = underlyingQuoteFetcher;
    this.requireRealtimeUnderlying = requireRealtimeUnderlying;
    this.vixSymbol = vixSymbol ? String(vixSymbol).trim().toUpperCase() : null;
    this.cache = new Map();
    this.underlyingQuotes = new Map();
  }

  async _underlyingQuote(symbol) {
    const key = String(symbol).toUpperCase();
    if (!this.underlyingQuoteFetcher) return null;
    if (!this.underlyingQuotes.has(key)) {
      this.underlyingQuotes.set(key, Promise.resolve().then(() => this.underlyingQuoteFetcher(key)));
    }
    const quote = await this.underlyingQuotes.get(key);
    if (quote?.error) throw new Error(quote.error);
    const value = quote?.value ?? quote;
    const last = numeric(value?.last ?? value?.mark ?? value?.spot);
    const bid = numeric(value?.bid);
    const ask = numeric(value?.ask);
    const asOf = timestamp(quote?.asOf ?? value?.asOf ?? value?.as_of);
    const freshness = value?.freshness ?? value?.timeframe ?? quote?.freshness;
    const source = String(quote?.source ?? value?.source ?? 'UNDERLYING_QUOTE');
    const twoSided = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid;
    if (!(last > 0) || !Number.isFinite(asOf) || this.now() - asOf > this.maxQuoteAgeMs
      || asOf > this.now() + 10_000 || (this.requireRealtimeUnderlying && !isRealtime(freshness))) {
      throw new Error('UNDERLYING_QUOTE_NOT_REALTIME');
    }
    return {
      last, bid: twoSided ? bid : null, ask: twoSided ? ask : null,
      asOf, freshness, source,
    };
  }

  async _get(path, { cache = true } = {}) {
    if (cache && this.cache.has(path)) return this.cache.get(path);
    const pending = (async () => {
      let response;
      try {
        response = await this.fetcher(new Request(`https://market.internal${path}`));
      } catch (error) {
        throw new Error(`MASSIVE_SERVICE_UNAVAILABLE:${error?.message ?? error}`);
      }
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { throw new Error('MASSIVE_MALFORMED_JSON'); }
      if (!response.ok || body?.error) {
        throw new Error(String(body?.error ?? `MASSIVE_HTTP_${response.status}`));
      }
      return body;
    })();
    if (cache) this.cache.set(path, pending);
    return pending;
  }

  async _getRetry(path, { attempts = 2 } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try { return await this._get(path, { cache: false }); }
      catch (error) { lastError = error; }
    }
    throw lastError;
  }

  async history(symbol, { lookback = 400, minBars = 120 } = {}) {
    try {
      const body = await this._get(`/v1/bars?ticker=${encodeURIComponent(symbol)}&tf=1d&limit=${lookback}`);
      const bars = Array.isArray(body.bars) ? body.bars.map((bar) => ({
        t: numeric(bar.t), o: numeric(bar.o), h: numeric(bar.h),
        l: numeric(bar.l), c: numeric(bar.c), v: numeric(bar.v, 0),
      })).filter((bar) => [bar.t, bar.o, bar.h, bar.l, bar.c].every(Number.isFinite)) : [];
      if (bars.length < minBars) return { error: `MASSIVE_HISTORY_SHORT:${bars.length}` };
      return { value: bars, asOf: bars.at(-1).t, source: 'MASSIVE_POLYGON_AGGREGATES' };
    } catch (error) {
      return { error: error.message };
    }
  }

  /**
   * Mark-only quote for risk-managing an existing custody position.
   *
   * This is intentionally weaker than `quote()`: it may never underwrite an
   * executable order because it does not require a two-sided market. It
   * exists so a newly listed holding with a valid last trade can be included
   * in portfolio stress instead of disappearing from the book.
   */
  async markQuote(symbol) {
    try {
      const spot = await this._get(`/v1/spot?ticker=${encodeURIComponent(symbol)}`, { cache: false });
      const last = numeric(spot.last ?? spot.spot);
      const asOf = timestamp(spot.as_of, timestamp(spot.response_ts));
      if (!(last > 0) || !Number.isFinite(asOf)) return { error: 'MASSIVE_MARK_QUOTE_INCOMPLETE' };
      return {
        value: { symbol, last, sector: 'UNKNOWN', beta: null, freshness: spot.freshness ?? null },
        asOf,
        source: `MASSIVE_${String(spot.source ?? 'POLYGON_MARK').toUpperCase()}`,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async quote(symbol) {
    try {
      const liveUnderlying = await this._underlyingQuote(symbol);
      const [spot, history] = await Promise.all([
        this._get(`/v1/spot?ticker=${encodeURIComponent(symbol)}`),
        this.history(symbol, { lookback: 120 }),
      ]);
      if (history.error) return history;
      const last = liveUnderlying?.last ?? numeric(spot.last ?? spot.spot);
      const bid = liveUnderlying?.bid ?? numeric(spot.bid);
      const ask = liveUnderlying?.ask ?? numeric(spot.ask);
      const spotAsOf = timestamp(spot.as_of, timestamp(spot.response_ts));
      const asOf = liveUnderlying?.asOf ?? spotAsOf;
      const freshness = liveUnderlying?.freshness ?? spot.freshness ?? spot.timeframe;
      const adv = history.value.reduce((sum, bar) => sum + numeric(bar.v, 0), 0)
        / history.value.length;
      const hasTwoSidedUnderlying = Number.isFinite(bid) && Number.isFinite(ask);
      if (![last, asOf].every(Number.isFinite)
        || (hasTwoSidedUnderlying && (bid <= 0 || ask < bid))) {
        return { error: 'MASSIVE_QUOTE_INCOMPLETE' };
      }
      if (!liveUnderlying && this.requireRealtimeUnderlying
        && (isExplicitlyDelayed(freshness) || !isRealtime(freshness))) {
        return { error: `MASSIVE_UNDERLYING_NOT_REALTIME:${normalizedFreshness(freshness) || 'UNVERIFIED'}` };
      }
      return {
        value: {
          symbol, last, bid: hasTwoSidedUnderlying ? bid : null,
          ask: hasTwoSidedUnderlying ? ask : null,
          underlyingMarket: hasTwoSidedUnderlying ? 'TWO_SIDED' : 'MARK_ONLY',
          markTimestampBasis: liveUnderlying ? 'SCHWAB_MARKET_DATA_QUOTE' : 'MASSIVE_SPOT_RESPONSE',
          volume: numeric(history.value.at(-1)?.v, 0),
          adv,
          sector: 'UNKNOWN', beta: null,
          freshness: freshness ?? null,
        },
        asOf,
        source: liveUnderlying?.source
          ?? `MASSIVE_${String(spot.source ?? 'POLYGON_SPOT').toUpperCase()}`,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async optionChain(symbol, { expirations = this.dteTargets, rights = RIGHTS } = {}) {
    try {
      const requestedRights = [...new Set((Array.isArray(rights) ? rights : [])
        .map((right) => String(right).toLowerCase()))];
      if (!requestedRights.length || requestedRights.some((right) => !RIGHTS.includes(right))) {
        return { error: 'MASSIVE_OPTION_RIGHTS_INVALID' };
      }
      const [packets, liveUnderlying] = await Promise.all([
        Promise.all(expirations.flatMap((dte) => requestedRights.map(async (right) => {
          const path = `/v1/chain?ticker=${encodeURIComponent(symbol)}&dte=${dte}`
            + `&deltaTarget=0.25&type=${right}&strict=1`;
          return { targetDte: dte, right, body: await this._get(path, { cache: false }) };
        }))),
        this._underlyingQuote(symbol),
      ]);
      const now = this.now();
      const groups = packets.map((packet) => (packet.body.contracts ?? []).map((row) => {
        const asOf = timestamp(row.quote_as_of);
        return {
          symbol: String(row.contract ?? '').replace(/^O:/u, ''),
          underlying: symbol,
          right: String(row.type ?? '').toLowerCase(),
          strike: numeric(row.strike),
          expiration: row.expiration,
          dte: numeric(row.dte),
          bid: numeric(row.bid), ask: numeric(row.ask), mid: numeric(row.mid),
          iv: numeric(row.iv), delta: numeric(row.delta), gamma: numeric(row.gamma),
          theta: numeric(row.theta), vega: numeric(row.vega),
          openInterest: numeric(row.oi, 0), volume: numeric(row.volume, 0),
          multiplier: 100, quoteAsOf: asOf,
        };
      }).filter((row) => row.symbol && row.right === packet.right
        && [row.strike, row.dte, row.bid, row.ask, row.iv, row.delta, row.quoteAsOf]
          .every(Number.isFinite)
        && row.strike > 0 && row.dte >= 0 && row.iv > 0
        && Math.abs(row.delta) <= 1
        && (row.right === 'put' ? row.delta <= 0 : row.delta >= 0)
        && row.bid > 0 && row.ask >= row.bid
        && row.quoteAsOf <= now + 10_000
        && now - row.quoteAsOf <= this.maxChainAgeMs));
      const contracts = [...new Map(groups.flat().map((row) => [row.symbol, row])).values()];
      const requested = expirations.length * requestedRights.length;
      if (packets.length !== requested || groups.some((group) => group.length === 0)) {
        return { error: 'MASSIVE_EXECUTABLE_CHAIN_UNAVAILABLE' };
      }
      const massiveSpot = numeric(packets.find((packet) => numeric(packet.body.spot) != null)?.body.spot);
      const spot = liveUnderlying?.last ?? massiveSpot;
      if (!(spot > 0)) return { error: 'MASSIVE_CHAIN_SPOT_UNAVAILABLE' };
      const asOf = Math.min(...contracts.map((row) => row.quoteAsOf));
      // The chain-wide timestamp remains the oldest included contract so the
      // audit is conservative. Critically, an option quote timestamp is never
      // reused as the underlying stock timestamp: Massive can provide
      // real-time options alongside a 15-minute-delayed underlying asset.
      return {
        value: {
          underlying: symbol, spot, contracts, asOf,
          underlyingAsOf: liveUnderlying?.asOf ?? null,
          underlyingSource: liveUnderlying?.source ?? 'MASSIVE_OPTIONS_SNAPSHOT_UNDERLYING',
        },
        asOf,
        source: 'MASSIVE_POLYGON_OPTIONS_STRICT',
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async events(symbol) {
    try {
      const from = new Date(this.now() - 2 * DAY_MS).toISOString().slice(0, 10);
      const through = new Date(this.now() + 60 * DAY_MS).toISOString().slice(0, 10);
      // Exchange-traded funds have no corporate earnings. Calling an issuer
      // earnings calendar for them creates a false data-integrity failure;
      // their split/corporate-action clearance remains mandatory.
      const earningsPromise = this.fundSymbols.has(String(symbol).toUpperCase())
        ? Promise.resolve({ status: 'VERIFIED', source: 'FUND_NOT_CORPORATE_ISSUER', events: [] })
        : this._get(`/v1/earnings-events?ticker=${encodeURIComponent(symbol)}&from=${from}&through=${through}`, { cache: false });
      const [earnings, actions] = await Promise.all([
        earningsPromise,
        this._getRetry(`/v1/corporate-actions?ticker=${encodeURIComponent(symbol)}&through=${through}`),
      ]);
      if (earnings.status === 'INCOMPLETE' || actions.status === 'INCOMPLETE') {
        return { error: 'MASSIVE_EVENT_CLEARANCE_INCOMPLETE' };
      }
      const events = [
        ...(earnings.events ?? []).map((event) => ({ type: 'EARNINGS', at: eventAt(event), source: earnings.source })),
        ...(actions.splits ?? []).map((event) => ({
          type: 'CORPORATE_SPLIT', at: timestamp(`${event.executionDate}T16:00:00Z`), source: actions.source,
        })),
        ...(actions.dividends ?? []).map((event) => ({
          type: 'EX_DIVIDEND',
          at: timestamp(`${event.exDividendDate ?? event.ex_dividend_date ?? event.date}T16:00:00Z`),
          cash_amount: numeric(event.cashAmount ?? event.cash_amount ?? event.amount),
          source: actions.source,
        })),
      ];
      if (events.some((event) => !Number.isFinite(event.at)
        || (event.type === 'EX_DIVIDEND' && !(event.cash_amount >= 0)))) {
        return { error: 'MASSIVE_EVENT_DATE_UNVERIFIED' };
      }
      return {
        value: events,
        asOf: this.now(),
        source: 'MASSIVE_EVENT_CLEARANCE',
        coverage: {
          earnings: true,
          corporate_actions: true,
          dividends: Array.isArray(actions.dividends),
        },
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async marketState() {
    try {
      const [session, vix, indexBars, liveVix] = await Promise.all([
        this._getRetry('/v1/market-status'),
        this._getRetry('/v1/vix'),
        this._getRetry('/v1/bars?ticker=SPY&tf=1d&limit=252'),
        this.vixSymbol ? this._underlyingQuote(this.vixSymbol) : null,
      ]);
      if (session.status === 'INCOMPLETE') return { error: 'MASSIVE_MARKET_SESSION_UNVERIFIED' };
      const rawStatus = session.session ?? session.market ?? session.market_status ?? session.status;
      const status = String(rawStatus ?? '').toUpperCase();
      const normalized = normalizeMarketSession(rawStatus, this.now());
      const vixValue = liveVix?.last ?? numeric(vix.vix);
      const vix3m = numeric(vix.vix3m ?? vixValue);
      const closes = (indexBars.bars ?? []).map((bar) => numeric(bar.c)).filter(Number.isFinite);
      const peak = closes.length ? Math.max(...closes) : null;
      const drawdown = peak > 0 ? (closes.at(-1) - peak) / peak : null;
      const asOf = timestamp(session.as_of ?? session.observed_at, timestamp(session.response_ts, this.now()));
      if (!normalized || !Number.isFinite(vixValue) || !Number.isFinite(asOf)) {
        const missing = [
          !normalized ? `SESSION_STATUS_${status || 'EMPTY'}` : null,
          !Number.isFinite(vixValue) ? 'VIX' : null,
          !Number.isFinite(asOf) ? 'TIMESTAMP' : null,
        ].filter(Boolean);
        return { error: `MASSIVE_MARKET_STATE_INCOMPLETE:${missing.join(',')}` };
      }
      return {
        value: {
          status: normalized, vix: vixValue, vix3m, drawdown,
          vixSource: liveVix?.source ?? vix.source ?? 'MASSIVE_INDEX_DATA',
          vixAsOf: liveVix?.asOf ?? timestamp(vix.as_of, timestamp(vix.response_ts)),
        },
        asOf,
        source: 'MASSIVE_MARKET_STATUS',
      };
    } catch (error) {
      return { error: error.message };
    }
  }
}
