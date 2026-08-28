const DAY_MS = 86_400_000;
const INDEX_OPTION_MARKET_SYMBOLS = Object.freeze({
  SPX: '$SPX',
  SPXW: '$SPX',
  RUT: '$RUT',
  RUTW: '$RUT',
  NDX: '$NDX',
  NDXP: '$NDX',
  VIX: '$VIX',
  VIXW: '$VIX',
});

const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;

function realizedVol(bars) {
  const closes = (bars ?? []).map((bar) => finite(bar.c)).filter((value) => value > 0);
  if (closes.length < 30) return null;
  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    / Math.max(1, returns.length - 1);
  return Math.sqrt(variance * 252);
}

function dailyReturns(bars) {
  const closes = (bars ?? []).map((bar) => finite(bar.c)).filter((value) => value > 0);
  return closes.slice(1).map((close, index) => Math.log(close / closes[index]));
}

function expirationDte(expiration, now) {
  const expiry = Date.parse(`${expiration}T20:00:00Z`);
  return Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - now) / DAY_MS)) : null;
}

function marketSymbol(underlying) {
  const normalized = String(underlying ?? '').trim().toUpperCase();
  return INDEX_OPTION_MARKET_SYMBOLS[normalized] ?? normalized;
}

/**
 * Convert reconciled broker legs into the conservative position shape used
 * by the Portfolio Governor. Unknown or undefined risk refuses the entire
 * map; a partial book must never look like the whole book.
 */
export async function mapCustodyRisk({ provider, positions, now = Date.now() }) {
  const sourcePositions = positions ?? [];
  const malformed = sourcePositions.filter((position) => finite(position.quantity) === null
    || !String(position.symbol ?? '').trim() || !String(position.underlying ?? '').trim());
  if (malformed.length) {
    return {
      ok: false,
      reasons: malformed.map((position) => `CUSTODY_POSITION_INCOMPLETE:${position.symbol ?? 'UNKNOWN'}`),
    };
  }
  const held = sourcePositions.filter((position) => finite(position.quantity) !== 0);
  const underlyings = [...new Set(held.map((position) => marketSymbol(position.underlying)).filter(Boolean))];
  const quoteBySymbol = new Map();
  const historyBySymbol = new Map();
  const reasons = [];

  await Promise.all(underlyings.map(async (symbol) => {
    const [quote, history] = await Promise.all([
      typeof provider.markQuote === 'function' ? provider.markQuote(symbol) : provider.quote(symbol),
      provider.history(symbol, { lookback: 400, minBars: 30 }),
    ]);
    if (quote?.error || !finite(quote?.value?.last)) reasons.push(`CUSTODY_QUOTE_UNAVAILABLE:${symbol}`);
    else quoteBySymbol.set(symbol, quote.value);
    if (history?.error || !Array.isArray(history?.value) || history.value.length < 30) {
      reasons.push(`CUSTODY_HISTORY_UNAVAILABLE:${symbol}`);
    } else historyBySymbol.set(symbol, history.value);
  }));

  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };

  const sharesAvailable = new Map();
  for (const position of held) {
    if (position.type === 'EQUITY' && finite(position.quantity) > 0) {
      const symbol = marketSymbol(position.underlying);
      sharesAvailable.set(symbol, (sharesAvailable.get(symbol) ?? 0) + finite(position.quantity));
    }
  }
  const chainCache = new Map();
  const riskPositions = [];

  for (const position of held) {
    const underlying = marketSymbol(position.underlying);
    const quantity = finite(position.quantity);
    const multiplier = finite(position.multiplier) ?? (position.type === 'OPTION' ? 100 : 1);
    const quote = quoteBySymbol.get(underlying);
    const history = historyBySymbol.get(underlying);
    const spot = finite(quote?.last);
    const sector = quote?.sector && quote.sector !== 'UNKNOWN' ? quote.sector : 'CUSTODY_UNCLASSIFIED';
    const base = {
      id: `CUSTODY:${position.symbol}`,
      symbol: position.symbol,
      underlying,
      sector,
      quantity,
      multiplier,
      spot,
      beta: finite(quote?.beta) ?? 1,
    };

    if (position.type === 'EQUITY') {
      const measuredVol = realizedVol(history);
      // Short-history IPOs can look deceptively calm. Until 120 sessions are
      // observed, force an 80% annualised stress-vol floor rather than
      // extrapolating a thin sample as if it were mature.
      const iv = history.length < 120 ? Math.max(measuredVol ?? 0, 0.80) : measuredVol;
      if (!(iv > 0)) {
        reasons.push(`CUSTODY_VOL_UNAVAILABLE:${position.symbol}`);
        continue;
      }
      const capital = Math.abs(quantity * spot * multiplier);
      riskPositions.push({
        ...base, type: 'EQUITY', right: 'shares', iv,
        delta: 1, gamma: 0, vega: 0, theta: 0,
        economicCapital: capital, buyingPower: capital,
      });
      continue;
    }

    if (position.type !== 'OPTION' || !position.expiration || !position.right
      || !finite(position.strike)) {
      reasons.push(`CUSTODY_INSTRUMENT_UNMAPPABLE:${position.symbol}`);
      continue;
    }

    const dte = expirationDte(position.expiration, now);
    if (!(dte > 0)) {
      reasons.push(`CUSTODY_OPTION_EXPIRY_INVALID:${position.symbol}`);
      continue;
    }
    const cacheKey = `${underlying}:${dte}:${position.strike}`;
    if (!chainCache.has(cacheKey)) {
      chainCache.set(cacheKey, provider.optionChain(underlying, {
        expirations: [dte], strikes: [position.strike], decisionTime: now,
      }));
    }
    const chain = await chainCache.get(cacheKey);
    if (chain?.error || !Array.isArray(chain?.value?.contracts)) {
      reasons.push(`CUSTODY_CHAIN_UNAVAILABLE:${position.symbol}`);
      continue;
    }
    let contract = chain.value.contracts.find((candidate) =>
      candidate.right === position.right
      && candidate.expiration === position.expiration
      && Math.abs(candidate.strike - position.strike) < 1e-6);
    if ((!contract || ![contract.iv, contract.delta, contract.gamma, contract.vega, contract.theta]
      .every((value) => finite(value) != null)) && typeof provider.optionQuote === 'function') {
      const exact = await provider.optionQuote(position.symbol);
      if (!exact?.error) contract = {
        ...exact.value,
        right: position.right,
        strike: position.strike,
        expiration: position.expiration,
      };
    }
    if (!contract || ![contract.iv, contract.delta, contract.gamma, contract.vega, contract.theta]
      .every((value) => finite(value) != null)) {
      reasons.push(`CUSTODY_GREEKS_UNAVAILABLE:${position.symbol}`);
      continue;
    }

    if (position.right === 'call' && quantity < 0) {
      const needed = Math.abs(quantity) * multiplier;
      const available = sharesAvailable.get(underlying) ?? 0;
      if (available < needed) {
        reasons.push(`CUSTODY_UNCOVERED_CALL_UNDEFINED_RISK:${position.symbol}`);
        continue;
      }
      sharesAvailable.set(underlying, available - needed);
    }

    let capital;
    if (quantity > 0) {
      capital = Math.max(0, finite(position.marketValue) ?? contract.mid * multiplier * quantity);
    } else if (position.right === 'put') {
      capital = position.strike * multiplier * Math.abs(quantity);
    } else {
      capital = spot * multiplier * Math.abs(quantity);
    }
    riskPositions.push({
      ...base, type: 'OPTION', right: position.right,
      strike: position.strike, expiration: position.expiration, dte,
      iv: contract.iv, delta: contract.delta, gamma: contract.gamma,
      vega: contract.vega, theta: contract.theta,
      economicCapital: capital, buyingPower: capital,
    });
  }

  if (reasons.length || riskPositions.length !== held.length) {
    return { ok: false, reasons: [...new Set(reasons.length ? reasons : ['CUSTODY_BOOK_PARTIAL'])] };
  }
  return {
    ok: true,
    positions: riskPositions,
    returnsBySymbol: Object.fromEntries(underlyings.map((symbol) => [symbol, dailyReturns(historyBySymbol.get(symbol))])),
    sectors: Object.fromEntries(underlyings.map((symbol) => [symbol,
      quoteBySymbol.get(symbol)?.sector && quoteBySymbol.get(symbol).sector !== 'UNKNOWN'
        ? quoteBySymbol.get(symbol).sector : 'CUSTODY_UNCLASSIFIED'])),
  };
}
