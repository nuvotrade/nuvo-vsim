import { brierScore } from '../src/math/stats.js';

export const UNDERWRITE_FORECAST_EVENT = 'FINISH_ITM_AT_EXPIRY';
export const UNDERWRITE_SCORE_VERSION = 'UNDERWRITE_TERMINAL_BRIER_AND_REALIZED_NEV_V1';
export const UNDERWRITE_PRIMARY = 'bootstrap';

const YEAR_DAYS = 365;
const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;

function modelRecord(row, model) {
  const source = row?.models?.[model]
    ?? row?.one_contract_models?.[model]
    ?? row?.model_scores?.[model]
    ?? null;
  if (!source) return null;
  const probability = finite(source.p_finish_itm ?? source.probability);
  const rawNev0 = finite(source.raw_nev_0 ?? source.nev);
  if (probability === null && rawNev0 === null) return null;
  return { probability, predicted_raw_nev_0: rawNev0 };
}

function riskNeutralProbability(row) {
  return finite(row?.market_math?.risk_neutral_finish_itm_european
    ?? row?.risk_neutral_finish_itm
    ?? row?.market_implied_assignment);
}

function rowNetCredit(row) {
  return finite(row?.one_contract_economics?.net_credit
    ?? row?.one_contract_net_premium
    ?? row?.net_credit);
}

function rowRiskFreeRate(row, result) {
  return finite(row?.market_math?.risk_free_rate
    ?? row?.risk_free_rate
    ?? result?.rate_assumptions?.risk_free_rate
    ?? result?.method?.rate
    ?? result?.economics?.risk_free_rate);
}

function rowTimeYears(row) {
  return finite(row?.market_math?.model_time_to_expiry_years
    ?? row?.model_time_to_expiry_years
    ?? row?.time_to_expiry_years)
    ?? (finite(row?.dte) !== null ? finite(row.dte) / YEAR_DAYS : null);
}

function modelMap(row) {
  const models = {};
  for (const name of ['bootstrap', 'lognormal', 'studentT', 'jump', 'volatilityStress']) {
    const value = modelRecord(row, name);
    if (value) models[name] = value;
  }
  const rn = riskNeutralProbability(row);
  if (rn !== null) models.riskNeutral = {
    probability: rn,
    predicted_raw_nev_0: null,
    label: 'RISK_NEUTRAL_REFERENCE_NOT_PHYSICAL_PRIMARY',
  };
  return models;
}

export function sealedForecastProjection({ surface, row, result, asof }) {
  const right = String(surface === 'CSP_SINGLE_TICKER' || row?.structure === 'CSP'
    ? 'put' : 'call').toLowerCase();
  const riskFreeRate = rowRiskFreeRate(row, result);
  const tYears = rowTimeYears(row);
  const netCredit = rowNetCredit(row);
  const forecastAt = new Date(asof).toISOString();
  const expiration = String(row?.expiration ?? '');
  const models = modelMap(row);
  return {
    event: UNDERWRITE_FORECAST_EVENT,
    event_definition: right === 'put' ? 'S_T_STRICTLY_BELOW_K' : 'S_T_STRICTLY_ABOVE_K',
    equality_classification: 'OTM_FALSE',
    right,
    strike: finite(row?.strike),
    expiration,
    forecast_at: forecastAt,
    sealed_clock: {
      risk_free_rate: riskFreeRate,
      time_to_expiry_years: tYears,
      discount_factor: riskFreeRate !== null && tYears !== null
        ? Math.exp(-riskFreeRate * tYears) : null,
      time_source: 'FORECAST_MODEL_DTE_365_SEALED_AT_FORECAST',
      time_origin: forecastAt,
      time_destination: expiration,
      time_definition: 'MODEL_CALENDAR_DTE_FROM_FORECAST_SESSION_TO_EXPIRATION_DIVIDED_BY_365',
    },
    one_contract_net_credit: netCredit,
    models,
    primary_model: UNDERWRITE_PRIMARY,
    primary_is_provisional: true,
    calibration_eligible: Boolean(finite(models.bootstrap?.probability) !== null
      && finite(row?.strike) !== null && expiration && riskFreeRate !== null
      && tYears !== null && netCredit !== null),
    mutation_eligible: false,
  };
}

export function newYorkDate(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (name) => parts.find((item) => item.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function expirationIsMature(expiration, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(expiration ?? ''))) return false;
  const today = newYorkDate(now);
  if (String(expiration) < today) return true;
  if (String(expiration) > today) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(now));
  const part = (name) => Number(parts.find((item) => item.type === name)?.value);
  return part('hour') * 60 + part('minute') >= 16 * 60 + 15;
}

export function officialExpirationClose({ expiration, bars, source, now = Date.now() }) {
  if (!expirationIsMature(expiration, now)) return {
    status: 'NOT_MATURE', reason_code: 'EXPIRATION_SESSION_NOT_COMPLETE',
  };
  const matches = (Array.isArray(bars) ? bars : []).filter((bar) =>
    finite(bar?.t) !== null && newYorkDate(finite(bar.t)) === expiration
    && finite(bar?.c) !== null);
  if (matches.length !== 1) return {
    status: 'OUTCOME_UNAVAILABLE',
    reason_code: matches.length ? 'OFFICIAL_CLOSE_AMBIGUOUS' : 'OFFICIAL_EXPIRATION_CLOSE_MISSING',
  };
  const sourceName = String(source ?? '').trim();
  if (!sourceName) return {
    status: 'OUTCOME_UNAVAILABLE', reason_code: 'OFFICIAL_CLOSE_SOURCE_UNVERIFIED',
  };
  const bar = matches[0];
  return {
    status: 'VERIFIED', terminal_price: finite(bar.c),
    source: sourceName, source_timestamp: new Date(finite(bar.t)).toISOString(),
    timestamp_basis: 'SCHWAB_DAILY_CANDLE_TIMESTAMP_FOR_EXPIRATION_SESSION',
    source_bar: { t: finite(bar.t), o: finite(bar.o), h: finite(bar.h), l: finite(bar.l),
      c: finite(bar.c), v: finite(bar.v) },
  };
}

export function scoreSealedForecast(forecast, officialClose) {
  if (officialClose?.status !== 'VERIFIED') return {
    status: 'OUTCOME_UNAVAILABLE',
    reason_code: officialClose?.reason_code ?? 'OFFICIAL_EXPIRATION_CLOSE_UNVERIFIED',
  };
  if (!String(officialClose.source ?? '').trim()
    || !Number.isFinite(Date.parse(officialClose.source_timestamp))) return {
    status: 'OUTCOME_UNAVAILABLE', reason_code: 'OFFICIAL_CLOSE_PROVENANCE_INCOMPLETE',
  };
  const projection = forecast?.projection;
  const strike = finite(projection?.strike);
  const terminalPrice = finite(officialClose.terminal_price);
  const rate = finite(projection?.sealed_clock?.risk_free_rate);
  const tYears = finite(projection?.sealed_clock?.time_to_expiry_years);
  const netCredit = finite(projection?.one_contract_net_credit);
  if (!projection?.calibration_eligible || strike === null || terminalPrice === null
    || rate === null || tYears === null || netCredit === null) return {
    status: 'OUTCOME_UNAVAILABLE', reason_code: 'SEALED_FORECAST_FIELDS_INCOMPLETE',
  };
  const right = projection.right;
  const outcome = right === 'put' ? terminalPrice < strike : terminalPrice > strike;
  const intrinsic = right === 'put'
    ? Math.max(strike - terminalPrice, 0) : Math.max(terminalPrice - strike, 0);
  const discountFactor = Math.exp(-rate * tYears);
  const realizedLiability0 = discountFactor * intrinsic * 100;
  const realizedNev0 = netCredit - realizedLiability0;
  const scores = Object.entries(projection.models ?? {}).flatMap(([model, record]) => {
    const probability = finite(record?.probability);
    if (probability === null) return [];
    return [{
      model,
      probability,
      brier_score: brierScore([{ p: probability, outcome }]),
      predicted_raw_nev_0: finite(record?.predicted_raw_nev_0),
      realized_nev_0: realizedNev0,
      primary: model === projection.primary_model,
      diagnostic: model === 'jump',
      risk_neutral_reference: model === 'riskNeutral',
    }];
  });
  return {
    status: 'SETTLED',
    event: UNDERWRITE_FORECAST_EVENT,
    outcome,
    equality_classification: 'OTM_FALSE',
    terminal_price: terminalPrice,
    strike,
    right,
    source: officialClose.source,
    source_timestamp: officialClose.source_timestamp,
    source_timestamp_basis: officialClose.timestamp_basis
      ?? 'PROVIDER_TIMESTAMP_FOR_EXPIRATION_SESSION_CLOSE',
    sealed_rate: rate,
    sealed_time_to_expiry_years: tYears,
    discount_factor: discountFactor,
    realized_liability_0: realizedLiability0,
    one_contract_net_credit: netCredit,
    realized_nev_0: realizedNev0,
    scores,
    score_version: UNDERWRITE_SCORE_VERSION,
    mutation_eligible: false,
  };
}

export function calibrationStamp(uniqueSymbolExpiry) {
  const n = Number(uniqueSymbolExpiry ?? 0);
  if (n < 50) return 'UNCALIBRATED';
  if (n < 200) return 'PROVISIONAL';
  return 'CALIBRATED';
}
