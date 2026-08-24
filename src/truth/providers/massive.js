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
    fundSymbols = [],
  } = {}) {
    super('massive');
    if (typeof fetcher !== 'function') throw new Error('MassiveProvider requires fetcher.');
    this.fetcher = fetcher;
    this.now = now;
    this.dteTargets = [...dteTargets];
    this.maxChainAgeMs = maxChainAgeMs;
    this.fundSymbols = new Set(fundSymbols.map((symbol) => String(symbol).toUpperCase()));
    this.cache = new Map();
    this.chainMarks = new Map();
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
      const [spot, history] = await Promise.all([
        this._get(`/v1/spot?ticker=${encodeURIComponent(symbol)}`),
        this.history(symbol, { lookback: 120 }),
      ]);
      if (history.error) return history;
      const last = numeric(spot.last ?? spot.spot);
      const bid = numeric(spot.bid);
      const ask = numeric(spot.ask);
      const spotAsOf = timestamp(spot.as_of, timestamp(spot.response_ts));
      const chainMark = this.chainMarks.get(String(symbol).toUpperCase());
      const useChainMark = chainMark && Number.isFinite(chainMark.asOf)
        && (!Number.isFinite(spotAsOf) || chainMark.asOf > spotAsOf);
      const decisionLast = useChainMark ? chainMark.last : last;
      const asOf = useChainMark ? chainMark.asOf : spotAsOf;
      const adv = history.value.reduce((sum, bar) => sum + numeric(bar.v, 0), 0)
        / history.value.length;
      const hasTwoSidedUnderlying = Number.isFinite(bid) && Number.isFinite(ask);
      if (![decisionLast, asOf].every(Number.isFinite)
        || (hasTwoSidedUnderlying && (bid <= 0 || ask < bid))) {
        return { error: 'MASSIVE_QUOTE_INCOMPLETE' };
      }
      return {
        value: {
          symbol, last: decisionLast, bid: hasTwoSidedUnderlying ? bid : null,
          ask: hasTwoSidedUnderlying ? ask : null,
          underlyingMarket: hasTwoSidedUnderlying ? 'TWO_SIDED' : 'MARK_ONLY',
          markTimestampBasis: useChainMark ? 'FRESHEST_CONTRACT_IN_OPTIONS_SNAPSHOT' : 'SPOT_RESPONSE',
          volume: numeric(history.value.at(-1)?.v, 0),
          adv,
          sector: 'UNKNOWN', beta: null,
          freshness: spot.freshness ?? null,
        },
        asOf,
        source: useChainMark ? 'MASSIVE_POLYGON_OPTIONS_UNDERLYING_MARK'
          : `MASSIVE_${String(spot.source ?? 'POLYGON_SPOT').toUpperCase()}`,
      };
    } catch (error) {
      return { error: error.message };
    }
  }

  async optionChain(symbol, { expirations = this.dteTargets } = {}) {
    try {
      const packets = await Promise.all(expirations.flatMap((dte) => RIGHTS.map(async (right) => {
        const path = `/v1/chain?ticker=${encodeURIComponent(symbol)}&dte=${dte}`
          + `&deltaTarget=0.25&type=${right}&strict=1`;
        return { targetDte: dte, right, body: await this._get(path, { cache: false }) };
      })));
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
      const requested = expirations.length * RIGHTS.length;
      if (packets.length !== requested || groups.some((group) => group.length === 0)) {
        return { error: 'MASSIVE_EXECUTABLE_CHAIN_UNAVAILABLE' };
      }
      const spot = numeric(packets.find((packet) => numeric(packet.body.spot) != null)?.body.spot);
      if (!(spot > 0)) return { error: 'MASSIVE_CHAIN_SPOT_UNAVAILABLE' };
      const asOf = Math.min(...contracts.map((row) => row.quoteAsOf));
      // The chain-wide timestamp remains the oldest included contract so the
      // chain audit is conservative. The packet's underlying spot accompanies
      // the snapshot but the legacy service omits spot_as_of, so its timestamp
      // is explicitly inferred from the freshest contract in that same packet.
      const spotAsOf = Math.max(...contracts.map((row) => row.quoteAsOf));
      this.chainMarks.set(String(symbol).toUpperCase(), { last: spot, asOf: spotAsOf });
      return {
        value: { underlying: symbol, spot, contracts, asOf },
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
      ];
      if (events.some((event) => !Number.isFinite(event.at))) {
        return { error: 'MASSIVE_EVENT_DATE_UNVERIFIED' };
      }
      return { value: events, asOf: this.now(), source: 'MASSIVE_EVENT_CLEARANCE' };
    } catch (error) {
      return { error: error.message };
    }
  }

  async marketState() {
    try {
      const [session, vix, indexBars] = await Promise.all([
        this._getRetry('/v1/market-status'),
        this._getRetry('/v1/vix'),
        this._getRetry('/v1/bars?ticker=SPY&tf=1d&limit=252'),
      ]);
      if (session.status === 'INCOMPLETE') return { error: 'MASSIVE_MARKET_SESSION_UNVERIFIED' };
      const rawStatus = session.session ?? session.market ?? session.market_status ?? session.status;
      const status = String(rawStatus ?? '').toUpperCase();
      const normalized = normalizeMarketSession(rawStatus, this.now());
      const vixValue = numeric(vix.vix);
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
        value: { status: normalized, vix: vixValue, vix3m, drawdown },
        asOf,
        source: 'MASSIVE_MARKET_STATUS',
      };
    } catch (error) {
      return { error: error.message };
    }
  }
}
