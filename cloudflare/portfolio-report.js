const CURRENCY_ASSETS = new Set(['CURRENCY', 'CASH_EQUIVALENT']);

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const cents = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
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

export function performanceFromBrokerRows(rows, { currentUnrealized = null } = {}) {
  const fills = fillsFromBrokerRows(rows);
  const matched = matchRealizedTrades(fills);
  const realized = matched.trades.reduce((sum, trade) => sum + trade.realized_pnl, 0);
  const wins = matched.trades.filter((trade) => trade.realized_pnl > 0);
  const losses = matched.trades.filter((trade) => trade.realized_pnl < 0);
  const grossProfit = wins.reduce((sum, trade) => sum + trade.realized_pnl, 0);
  const grossLoss = losses.reduce((sum, trade) => sum + trade.realized_pnl, 0);
  const byTicker = new Map();
  const byStrategy = new Map();
  let cumulative = 0;
  const curve = matched.trades.slice().sort((a, b) => a.closed_at.localeCompare(b.closed_at)).map((trade) => {
    cumulative = cents(cumulative + trade.realized_pnl);
    return { at: trade.closed_at, value: cumulative, trade_id: trade.trade_id };
  });
  for (const trade of matched.trades) {
    const ticker = trade.underlying || trade.symbol;
    const current = byTicker.get(ticker) ?? { ticker, realized_pnl: 0, closed_trades: 0 };
    current.realized_pnl += trade.realized_pnl;
    current.closed_trades += 1;
    byTicker.set(ticker, current);
    const strategy = strategyOf(trade);
    byStrategy.set(strategy, (byStrategy.get(strategy) ?? 0) + trade.realized_pnl);
  }
  return {
    fills,
    trades: matched.trades.slice().sort((a, b) => b.closed_at.localeCompare(a.closed_at)),
    unmatched: matched.unmatched,
    open_lots: matched.open_lots,
    summary: {
      realized_pnl: cents(realized),
      unrealized_pnl: finite(currentUnrealized),
      total_pnl: finite(currentUnrealized) === null ? null : cents(realized + Number(currentUnrealized)),
      closed_trades: matched.trades.length,
      wins: wins.length,
      losses: losses.length,
      win_rate: matched.trades.length ? wins.length / matched.trades.length : null,
      profit_factor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null,
      history_complete: matched.unmatched.length === 0,
      unmatched_closures: matched.unmatched.length,
    },
    curve,
    by_ticker: [...byTicker.values()].map((row) => ({ ...row, realized_pnl: cents(row.realized_pnl) }))
      .sort((a, b) => b.realized_pnl - a.realized_pnl),
    by_strategy: [...byStrategy.entries()].map(([strategy, realized_pnl]) => ({ strategy, realized_pnl: cents(realized_pnl) }))
      .sort((a, b) => b.realized_pnl - a.realized_pnl),
  };
}

export function portfolioFromCustody(custody, optionAnalytics = new Map()) {
  const account = custody?.account ?? {};
  const positions = custody?.positions ?? [];
  const nav = finite(account.nav);
  const equities = positions.filter((position) => position.type === 'EQUITY');
  const shortOptions = positions.filter((position) => position.type === 'OPTION' && Number(position.quantity) < 0);
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
    return {
      symbol: position.symbol, quantity: position.quantity, average_price: finite(position.averagePrice),
      mark, market_value: finite(position.marketValue), unrealized_pnl: unrealized,
      portfolio_weight: nav > 0 && finite(position.marketValue) !== null ? Math.abs(position.marketValue) / nav : null,
      covered_call_capacity: Math.max(0, Math.floor(position.quantity / 100)
        - (callsByUnderlying.get(position.symbol) ?? 0)),
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
    return {
      symbol: position.underlying ?? position.symbol,
      option_symbol: position.symbol,
      type: right === 'call' ? 'COVERED_CALL' : right === 'put' ? 'CASH_SECURED_PUT' : 'SHORT_OPTION',
      strike: finite(position.strike), expiration: position.expiration ?? null,
      quantity: qty, entry_credit: openingCredit, mark, market_value: finite(position.marketValue),
      unrealized_pnl: unrealized, theta_per_day: thetaPerDay,
      capital_committed: right === 'put' && finite(position.strike) !== null
        ? position.strike * qty * multiplier : null,
      probability_otm: finite(analytics.probability_otm),
      quote_asof: analytics.asof ?? null,
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
  })).sort((a, b) => b.value - a.value);
  const bookedPremium = harvest.reduce((sum, row) => sum + (row.entry_credit ?? 0), 0);
  const incomeTheta = harvest.every((row) => row.theta_per_day !== null)
    ? harvest.reduce((sum, row) => sum + row.theta_per_day, 0) : null;
  const openPnlValues = [...inventory, ...harvest].map((row) => row.unrealized_pnl);
  const openPnl = openPnlValues.every((value) => value !== null)
    ? openPnlValues.reduce((sum, value) => sum + value, 0) : null;
  return {
    asof: custody?.observedAt ?? null,
    account: {
      nav, cash, margin_debit: finite(account.marginDebit) ?? Math.max(0, -(cash ?? 0)),
      buying_power: finite(account.buyingPower), withdrawable_cash: finite(account.withdrawableCash),
      gross_positions: positions.every((position) => finite(position.marketValue) !== null)
        ? positions.reduce((sum, position) => sum + Math.abs(position.marketValue), 0) : null,
      position_count: positions.length, open_contracts: shortOptions.reduce((sum, row) => sum + Math.abs(row.quantity), 0),
    },
    summary: { booked_premium: bookedPremium, income_theta_per_day: incomeTheta,
      net_theta_per_day: incomeTheta, open_pnl: openPnl },
    capital_committed: capitalCommitted,
    inventory,
    harvest,
  };
}
