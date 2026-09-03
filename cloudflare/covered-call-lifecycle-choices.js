import { DEFAULT_LIMITS } from '../src/constitution/limits.js';
import { dteToT } from '../src/math/black_scholes.js';
import { logReturns } from '../src/math/stats.js';
import { volatilityProfile } from '../src/market/realized_vol.js';
import {
  buildUnderwriteModelSet, evaluateShortOptionModel,
  UNDERWRITE_MODEL_DEFINITIONS, UNDERWRITE_PRIMARY_MODEL, UNDERWRITE_STRESS_MODEL,
} from './underwrite-model-engine.js';

const DAY_MS = 86_400_000;

const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;

function newYorkDate(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function calendarDte(expiration, now) {
  const end = Date.parse(`${expiration}T00:00:00.000Z`);
  const start = Date.parse(`${newYorkDate(now)}T00:00:00.000Z`);
  return Number.isFinite(end) ? Math.max(0, Math.round((end - start) / DAY_MS)) : null;
}

function eventTimestamp(event) {
  const raw = event?.at ?? event?.date ?? event?.ex_dividend_date ?? event?.exDividendDate;
  if (Number.isFinite(Number(raw)) && Number(raw) > 10_000_000_000) return Number(raw);
  const parsed = Date.parse(raw ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function newYorkSessionClose(expiration) {
  const [year, month, day] = String(expiration).split('-').map(Number);
  if (![year, month, day].every(Number.isInteger)) return null;
  const noonUtc = Date.UTC(year, month - 1, day, 12);
  const zone = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'longOffset',
  }).formatToParts(new Date(noonUtc)).find((part) => part.type === 'timeZoneName')?.value ?? '';
  const match = zone.match(/^GMT([+-])(\d{2}):(\d{2})$/u);
  if (!match) return null;
  const offsetMinutes = (match[1] === '-' ? -1 : 1)
    * (Number(match[2]) * 60 + Number(match[3]));
  return Date.UTC(year, month - 1, day, 16, 0) - offsetMinutes * 60_000;
}

function eventsThrough(events, now, expiration) {
  const end = newYorkSessionClose(expiration);
  if (!Number.isFinite(end)) return [];
  return (Array.isArray(events) ? events : []).filter((event) => {
    const at = eventTimestamp(event);
    return at !== null && at >= Number(now) && at <= end;
  }).map((event) => ({
    type: String(event?.type ?? event?.event_type ?? 'EVENT').toUpperCase(),
    at: new Date(eventTimestamp(event)).toISOString(),
    cash_amount: finite(event?.cash_amount ?? event?.cashAmount ?? event?.amount),
  }));
}

function roundMoney(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function unavailable(reasonCode, detail = {}) {
  return {
    ok: false,
    outcome: 'NOT_EVALUATED',
    reason_code: reasonCode,
    ...detail,
    mutation_eligible: false,
  };
}

/**
 * Compare the remaining option overlay on an already-open covered call.
 *
 * Shares and the original option credit are common/sunk across the choices and
 * are deliberately excluded. Every path is valued at the same t0:
 *
 * HOLD_NEV_0  = -exp(-rT0) E[(S_T0-K0)+] Q
 * CLOSE_NEV_0 = -(ask0 Q + close fees)
 * ROLL_NEV_0  = CLOSE_NEV_0 + (bid1 Q - open fees)
 *               - exp(-rT1) E[(S_T1-K1)+] Q
 *
 * PRIMARY is the same centered block bootstrap used by the U1 calculators.
 * No result is selected, recommended, sized, or routed to a broker.
 */
export function compareCoveredCallLifecycleChoices({
  currentOption,
  currentQuote,
  rollContracts,
  historyBars,
  shareBasis = null,
  events = [],
  eventCoverage = {},
  valuationAt = Date.now(),
  quotesCurrent = false,
  samples = 8_000,
  seed = 'covered-call-lifecycle-choices',
  rate = DEFAULT_LIMITS.riskFreeRate,
  rateSource = `${DEFAULT_LIMITS.version}:riskFreeRate`,
  costs = {},
} = {}) {
  if (!quotesCurrent) return unavailable('TRUTH/EXECUTABLE_QUOTES_NOT_CURRENT');
  const quantity = finite(currentOption?.quantity ?? currentOption?.qty);
  const contracts = quantity < 0 ? Math.abs(quantity) : 0;
  const multiplier = finite(currentOption?.multiplier) ?? 100;
  const strike = finite(currentOption?.strike);
  const expiration = String(currentOption?.expiration ?? '');
  const currentAsk = finite(currentQuote?.ask);
  const currentBid = finite(currentQuote?.bid);
  const currentDte = calendarDte(expiration, valuationAt);
  const valuationMs = Number.isFinite(Number(valuationAt))
    ? Number(valuationAt) : Date.parse(valuationAt);
  const valuationIso = Number.isFinite(valuationMs)
    ? new Date(valuationMs).toISOString() : null;
  if (multiplier !== 100) return unavailable('CONTRACT/OPTION_MULTIPLIER_UNSUPPORTED', {
    observed_multiplier: multiplier,
    required_multiplier: 100,
  });
  if (!(contracts > 0) || !Number.isInteger(contracts)
    || String(currentOption?.right ?? '').toLowerCase() !== 'call'
    || !(strike > 0) || !(currentDte > 0)
    || !(currentAsk >= 0) || (currentBid !== null && !(currentAsk >= currentBid)) || !valuationIso
    || !Array.isArray(rollContracts) || !Array.isArray(historyBars)
    || !Number.isInteger(samples) || samples < 100) {
    return unavailable('CALCULATOR/LIFECYCLE_CHOICE_INPUT_INCOMPLETE');
  }

  const usableBars = historyBars.filter((bar) => [bar?.o, bar?.h, bar?.l, bar?.c]
    .every((value) => finite(value) > 0));
  const returns = logReturns(usableBars.map((bar) => finite(bar.c)));
  const volProfile = volatilityProfile(usableBars);
  if (usableBars.length < 121 || returns.length < 120 || !volProfile.garchOk
    || !(finite(volProfile.realized) > 0)
    || !(finite(volProfile.estimatorSpread) <= 0.60)) {
    return unavailable('FORECAST/HISTORY_OR_GARCH_UNAVAILABLE', {
      history_sessions: usableBars.length,
      garch_ok: Boolean(volProfile.garchOk),
      estimator_spread: finite(volProfile.estimatorSpread),
    });
  }

  const registeredRate = finite(rate);
  const closeCommission = finite(costs.closeCommissionPerContract
    ?? costs.commissionPerContract) ?? 0;
  const closeExchange = finite(costs.closeExchangeFeePerContract
    ?? costs.exchangeFeePerContract) ?? 0;
  const openCommission = finite(costs.openCommissionPerContract
    ?? costs.commissionPerContract) ?? 0;
  const openExchange = finite(costs.openExchangeFeePerContract
    ?? costs.exchangeFeePerContract) ?? 0;
  if (!(registeredRate >= 0) || [closeCommission, closeExchange, openCommission, openExchange]
    .some((value) => !(value >= 0))) {
    return unavailable('CALCULATOR/LIFECYCLE_CHOICE_COST_OR_RATE_INVALID');
  }

  const distributions = new Map();
  const modelsFor = (dte) => {
    if (!distributions.has(dte)) {
      const forecastVol = finite(volProfile.garch?.forecast(dte));
      distributions.set(dte, {
        forecastVol,
        models: buildUnderwriteModelSet({
          spot: finite(currentOption?.spot ?? currentQuote?.underlyingPrice),
          dte,
          forecastVol,
          returns,
          samples,
          seed: `${seed}:${String(currentOption?.underlying ?? '')}`,
        }),
      });
    }
    return distributions.get(dte);
  };

  const spot = finite(currentOption?.spot ?? currentQuote?.underlyingPrice);
  if (!(spot > 0)) return unavailable('TRUTH/UNDERLYING_PRICE_UNAVAILABLE');
  const currentForecast = modelsFor(currentDte);
  const currentT = dteToT(currentDte);
  const currentDiscount = Math.exp(-registeredRate * currentT);
  const currentPrimary = evaluateShortOptionModel(
    currentForecast.models[UNDERWRITE_PRIMARY_MODEL],
    {
      right: 'call', strike, netCredit: 0,
      discount: currentDiscount,
      capital: spot * multiplier,
    },
  );
  if (!currentPrimary) return unavailable('FORECAST/PRIMARY_UNAVAILABLE');

  const coveredShares = contracts * multiplier;
  const closeFees = contracts * (closeCommission + closeExchange);
  const closeDebit = currentAsk * coveredShares + closeFees;
  const holdNev0 = currentPrimary.raw_nev_0 * contracts;
  const holdSe = currentPrimary.monte_carlo_standard_error * contracts;
  const closeNev0 = -closeDebit;
  const displayedHoldNev0 = roundMoney(holdNev0);
  const displayedCloseNev0 = roundMoney(closeNev0);
  const currentEvents = eventsThrough(events, valuationMs, expiration);
  const sharedWarnings = [
    'AMERICAN_EARLY_EXERCISE_NOT_MODELED',
    'TAX_EFFECTS_OMITTED_NO_VERIFIED_TAX_INPUT',
  ];
  if (eventCoverage.eventsVerified !== true) sharedWarnings.push('EVENT_CALENDAR_UNVERIFIED');
  if (eventCoverage.dividendsVerified !== true) sharedWarnings.push('DIVIDEND_DATA_UNVERIFIED');
  const eventWarnings = (rows) => rows.map((event) => {
    const cash = event.cash_amount === null ? '' : `:$${event.cash_amount}/share`;
    return `${event.type}_IN_TENOR:${event.at}${cash}`;
  });

  const hold = {
    path: 'HOLD',
    expiration,
    dte: currentDte,
    time_to_expiry_years: currentT,
    discount_factor: currentDiscount,
    strike,
    executable_cash_now_0: 0,
    expected_call_liability_pv_0: -displayedHoldNev0,
    path_nev_0: displayedHoldNev0,
    versus_hold_0: 0,
    primary_p_finish_itm: currentPrimary.p_finish_itm,
    quote_asof: currentQuote?.underlyingAsOf ?? null,
    path_monte_carlo_standard_error: holdSe,
    versus_hold_monte_carlo_standard_error: 0,
    events_in_tenor: currentEvents,
    warnings: eventWarnings(currentEvents),
  };
  const close = {
    path: 'CLOSE',
    expiration: valuationIso.slice(0, 10),
    dte: 0,
    time_to_expiry_years: 0,
    discount_factor: 1,
    strike,
    executable_cash_now_0: roundMoney(-closeDebit),
    expected_call_liability_pv_0: 0,
    path_nev_0: displayedCloseNev0,
    versus_hold_0: roundMoney(displayedCloseNev0 - displayedHoldNev0),
    path_monte_carlo_standard_error: 0,
    versus_hold_monte_carlo_standard_error: holdSe,
    executable_ask_per_share: currentAsk,
    quote_asof: currentQuote?.asof ?? null,
    buyback_principal: roundMoney(currentAsk * coveredShares),
    close_fees: roundMoney(closeFees),
    warnings: ['EXECUTABLE_ASK_SNAPSHOT_NOT_A_FILL'],
  };

  const rollRows = [];
  const unavailableRows = [];
  const uniqueContracts = [...new Map(rollContracts.map((contract) => [
    String(contract?.symbol ?? ''), contract,
  ])).values()];
  for (const contract of uniqueContracts) {
    if (String(contract?.right ?? '').toLowerCase() !== 'call') continue;
    const rollStrike = finite(contract.strike);
    const rollExpiration = String(contract.expiration ?? '');
    const rollDte = calendarDte(rollExpiration, valuationMs);
    const brokerReportedDte = finite(contract.dte);
    const bid = finite(contract.bid);
    const ask = finite(contract.ask);
    const symbol = String(contract.symbol ?? '').replaceAll(' ', '');
    if (rollDte === null) {
      unavailableRows.push({ symbol: symbol || null, reason_code: 'CONTRACT/ROLL_EXPIRATION_UNAVAILABLE' });
      continue;
    }
    if (!(rollDte > currentDte) || symbol === String(currentOption?.symbol ?? '').replaceAll(' ', '')) continue;
    const rollMultiplier = finite(contract.multiplier) ?? 100;
    const rollUnderlying = String(contract.underlying ?? currentOption?.underlying ?? '').toUpperCase();
    if (rollMultiplier !== multiplier || rollUnderlying !== String(currentOption?.underlying ?? '').toUpperCase()) {
      unavailableRows.push({
        symbol: symbol || null,
        reason_code: rollMultiplier !== multiplier
          ? 'CONTRACT/ROLL_MULTIPLIER_MISMATCH' : 'CONTRACT/ROLL_UNDERLYING_MISMATCH',
      });
      continue;
    }
    if (!(rollStrike > 0) || !(bid >= 0) || (ask !== null && !(ask >= bid))) {
      unavailableRows.push({ symbol: symbol || null, reason_code: 'TRUTH/ROLL_QUOTE_INCOMPLETE' });
      continue;
    }
    const forecast = modelsFor(rollDte);
    const rollT = dteToT(rollDte);
    const rollDiscount = Math.exp(-registeredRate * rollT);
    const openFees = contracts * (openCommission + openExchange);
    const netCreditPerContract = bid * multiplier - (openCommission + openExchange);
    const primary = evaluateShortOptionModel(forecast.models[UNDERWRITE_PRIMARY_MODEL], {
      right: 'call', strike: rollStrike, netCredit: netCreditPerContract,
      discount: rollDiscount,
      capital: spot * multiplier,
    });
    if (!primary) {
      unavailableRows.push({ symbol: symbol || null, reason_code: 'FORECAST/ROLL_PRIMARY_UNAVAILABLE' });
      continue;
    }
    const stress = evaluateShortOptionModel(forecast.models[UNDERWRITE_STRESS_MODEL], {
      right: 'call', strike: rollStrike, netCredit: netCreditPerContract,
      discount: Math.exp(-registeredRate * dteToT(rollDte)),
      capital: spot * multiplier,
    });
    const newNetCredit = netCreditPerContract * contracts;
    const displayedNetCredit = roundMoney(newNetCredit);
    const displayedNewLiability = roundMoney(newNetCredit - primary.raw_nev_0 * contracts);
    const displayedRollNev0 = roundMoney(displayedCloseNev0 + displayedNetCredit
      - displayedNewLiability);
    const rollSe = primary.monte_carlo_standard_error * contracts;
    const versusHoldSe = Math.hypot(rollSe, holdSe);
    const warnings = ['EXECUTABLE_BID_AND_ASK_SNAPSHOT_NOT_A_FILL'];
    if (brokerReportedDte !== null && brokerReportedDte !== rollDte) {
      warnings.push(`BROKER_DTE_DIFFERS_FROM_NEW_YORK_CALENDAR:${brokerReportedDte}!=${rollDte}`);
    }
    if (finite(shareBasis) !== null && rollStrike < finite(shareBasis)) {
      warnings.push(`BELOW_BASIS:${rollStrike}<${finite(shareBasis)}`);
    }
    const rowEvents = eventsThrough(events, valuationMs, rollExpiration);
    warnings.push(...eventWarnings(rowEvents));
    rollRows.push({
      path: 'ROLL',
      symbol,
      expiration: rollExpiration,
      dte: rollDte,
      broker_reported_dte: brokerReportedDte,
      time_to_expiry_years: rollT,
      discount_factor: rollDiscount,
      strike: rollStrike,
      executable_bid_per_share: bid,
      executable_ask_per_share: ask,
      quote_asof: Number.isFinite(Number(contract.quoteAsOf))
        ? new Date(Number(contract.quoteAsOf)).toISOString() : null,
      close_debit_0: roundMoney(closeDebit),
      new_gross_credit_0: roundMoney(bid * coveredShares),
      new_open_fees_0: roundMoney(openFees),
      new_net_credit_0: displayedNetCredit,
      executable_cash_now_0: roundMoney(newNetCredit - closeDebit),
      expected_call_liability_pv_0: displayedNewLiability,
      path_nev_0: displayedRollNev0,
      versus_hold_0: roundMoney(displayedRollNev0 - displayedHoldNev0),
      path_monte_carlo_standard_error: rollSe,
      versus_hold_monte_carlo_standard_error: versusHoldSe,
      primary_p_finish_itm: primary.p_finish_itm,
      primary_monte_carlo_standard_error: rollSe,
      stress_path_nev_0: stress ? roundMoney(displayedCloseNev0
        + roundMoney(stress.raw_nev_0 * contracts)) : null,
      forecast_volatility: forecast.forecastVol,
      events_in_tenor: rowEvents,
      warnings,
    });
  }
  rollRows.sort((left, right) => String(left.expiration).localeCompare(String(right.expiration))
    || left.strike - right.strike || left.symbol.localeCompare(right.symbol));

  return {
    ok: true,
    outcome: 'LIFECYCLE_CHOICES_CALCULATED',
    underlying: String(currentOption?.underlying ?? '').toUpperCase(),
    current_option_symbol: String(currentOption?.symbol ?? '').replaceAll(' ', ''),
    contracts,
    multiplier,
    covered_shares: coveredShares,
    spot,
    share_basis: finite(shareBasis),
    valuation_at: valuationIso,
    quote_snapshot: {
      current_option_asof: currentQuote?.asof ?? null,
      roll_chain_asof: currentQuote?.rollChainAsOf ?? null,
      underlying_asof: currentQuote?.underlyingAsOf ?? null,
      current: true,
    },
    rate: registeredRate,
    rate_source: rateSource,
    sample_count: samples,
    history_sessions: usableBars.length,
    primary_model: UNDERWRITE_PRIMARY_MODEL,
    primary_definition: UNDERWRITE_MODEL_DEFINITIONS[UNDERWRITE_PRIMARY_MODEL],
    challenger_models: UNDERWRITE_MODEL_DEFINITIONS,
    global_warnings: sharedWarnings,
    hold,
    close,
    rolls: rollRows,
    unavailable_rolls: unavailableRows,
    method: {
      valuation_clock: 'ALL_PATHS_PRESENT_VALUE_AT_VALUATION_AT',
      hold_identity: 'HOLD_NEV_0=-EXP(-r*T0)*E[(S_T0-K0)+]*Q',
      close_identity: 'CLOSE_NEV_0=-(ASK0*Q+CLOSE_FEES)',
      roll_identity: 'ROLL_NEV_0=CLOSE_NEV_0+(BID1*Q-OPEN_FEES)-EXP(-r*T1)*E[(S_T1-K1)+]*Q',
      versus_hold_identity: 'PATH_NEV_0-HOLD_NEV_0',
      versus_hold_standard_error: 'SQRT(PATH_SE^2+HOLD_SE^2)_INDEPENDENT_DTE_SEEDS',
      original_credit: 'SUNK_EXCLUDED_FROM_ALL_PATHS',
      shares: 'COMMON_BASELINE_EXCLUDED_FROM_ALL_PATHS',
      fill_prices: 'CURRENT_EXECUTABLE_ASK_TO_CLOSE_AND_BID_TO_OPEN',
      option_contract_unit: 'US_EQUITY_OPTION_100_SHARES_REQUIRED',
      early_exercise: 'NOT_MODELED_LABELED_ON_GLASS',
      taxes: 'OMITTED_NO_VERIFIED_TAX_INPUT',
      max_of_models: 'REMOVED',
      mixture: 'NONE',
      selection: 'NONE_ROWS_SORTED_BY_EXPIRATION_THEN_STRIKE',
      recommendation: 'NONE',
      order_route: 'NONE',
    },
    cost_assumptions: {
      close_commission_per_contract: closeCommission,
      close_exchange_fee_per_contract: closeExchange,
      open_commission_per_contract: openCommission,
      open_exchange_fee_per_contract: openExchange,
      source: costs.version ?? 'EXPLICIT_INPUT',
    },
    mutation_eligible: false,
  };
}
