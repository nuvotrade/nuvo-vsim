import { dteToT, probItm } from '../src/math/black_scholes.js';
import {
  buildUnderwriteModelSet, evaluateShortOptionModel, presentValueCashCarryCost,
  UNDERWRITE_MODEL_DEFINITIONS, UNDERWRITE_PRIMARY_MODEL, UNDERWRITE_STRESS_MODEL,
} from './underwrite-model-engine.js';
import { logReturns } from '../src/math/stats.js';
import { volatilityProfile } from '../src/market/realized_vol.js';

export const CASH_SECURED_PUT_DTE_TARGETS = Object.freeze([7, 14, 21]);
export const CASH_SECURED_PUT_COSTS = Object.freeze({
  version: 'schwab-equity-option-observed-2026-09-02',
  commissionPerContract: 0.65,
  exchangeFeePerContract: 0,
  slippagePerContract: 0,
});
export const CASH_SECURED_PUT_MODELS = UNDERWRITE_MODEL_DEFINITIONS;
export const CASH_SECURED_PUT_PRIMARY_MODEL = UNDERWRITE_PRIMARY_MODEL;
export const CASH_SECURED_PUT_STRESS_MODEL = UNDERWRITE_STRESS_MODEL;

const DAY_MS = 86_400_000;
const finite = (value) => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Number(value) : null;
const available = (value) => Number.isFinite(value) ? value : null;

export function configuredCashSecuredPutDteTargets(value) {
  if (value === null || value === undefined || value === '') return [...CASH_SECURED_PUT_DTE_TARGETS];
  const tokens = Array.isArray(value) ? value : String(value).split(',');
  const parsed = tokens.map((token) => Number(String(token).trim()));
  if (!parsed.length || parsed.some((dte) => !Number.isInteger(dte) || dte <= 0 || dte > 365)) {
    return null;
  }
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function eventLabels(events, now, dte) {
  const through = now + dte * DAY_MS;
  return (events ?? []).filter((event) => {
    const at = finite(event?.at);
    return at !== null && at >= now && at <= through;
  }).map((event) => ({ type: String(event.type ?? 'EVENT'), at: finite(event.at), source: event.source ?? null }));
}

function quoteWarnings(contract, eventsInsideLife) {
  const bid = finite(contract.bid);
  const ask = finite(contract.ask);
  const mid = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : finite(contract.mid);
  const spreadPct = mid > 0 && ask !== null && bid !== null ? (ask - bid) / mid : null;
  const warnings = [];
  if (!(bid > 0)) warnings.push('NON_POSITIVE_BID');
  if (ask === null || ask < bid) warnings.push('ASK_UNAVAILABLE_OR_BELOW_BID');
  if (!(finite(contract.iv) > 0)) warnings.push('STRIKE_IV_UNAVAILABLE');
  if (spreadPct !== null && spreadPct > 0.08) warnings.push('SPREAD_ABOVE_8_PERCENT_OF_MID');
  if ((finite(contract.openInterest) ?? 0) < 250) warnings.push('OPEN_INTEREST_BELOW_250');
  if ((finite(contract.volume) ?? 0) < 50) warnings.push('VOLUME_BELOW_50');
  if (eventsInsideLife.length) warnings.push('EVENT_IN_TENOR');
  return { warnings, mid, spreadPct };
}

/**
 * One ticker in, one-contract cash-secured-put math out.
 *
 * This function has no portfolio, cash, Governor, universe, ranking, approval,
 * refusal, or order inputs. Every put with the core row inputs remains visible;
 * missing analytics are represented by null cells and named warnings.
 */
export function calculateCashSecuredPutRows({
  symbol, spot, contracts, historyBars = [], events = [], now = Date.now(),
  rate = 0.045, dividendYield = 0, alternativeCashRate = null,
  collateralCashRate = null, alternativeCashRateVerified = false,
  collateralCashRateVerified = false, brokerCashRequirement = null,
  brokerCashRequirementVerified = false, targetBasis = null,
  costs = CASH_SECURED_PUT_COSTS, samples = 8_000, seed = 'csp-single-ticker',
} = {}) {
  const ticker = String(symbol ?? '').trim().toUpperCase();
  const underlying = finite(spot);
  const puts = (Array.isArray(contracts) ? contracts : []).filter((contract) =>
    String(contract?.right ?? '').toLowerCase() === 'put'
    && finite(contract?.strike) > 0 && finite(contract?.dte) > 0
    && finite(contract?.bid) !== null);
  if (!ticker || !(underlying > 0) || !puts.length) {
    return {
      ok: false, outcome: 'CSP_MATH_UNAVAILABLE', symbol: ticker || null,
      reason_code: !ticker ? 'SYMBOL_INVALID' : !(underlying > 0)
        ? 'UNDERLYING_SPOT_UNAVAILABLE' : 'PUT_ROWS_WITH_BID_UNAVAILABLE',
      execution: 'READ_ONLY_MATH_NO_ORDER_ROUTE',
    };
  }

  const usableBars = (Array.isArray(historyBars) ? historyBars : []).filter((bar) =>
    [bar?.o, bar?.h, bar?.l, bar?.c].every((value) => finite(value) > 0)).slice(-400);
  const returns = logReturns(usableBars.map((bar) => finite(bar.c)));
  const volProfile = usableBars.length >= 61 ? volatilityProfile(usableBars) : null;
  const rateUsed = finite(rate) ?? 0;
  const yieldUsed = finite(dividendYield) ?? 0;
  const cashRate = finite(alternativeCashRate);
  const collateralRate = finite(collateralCashRate);
  const target = finite(targetBasis);
  const fees = (finite(costs?.commissionPerContract) ?? 0)
    + (finite(costs?.exchangeFeePerContract) ?? 0)
    + (finite(costs?.slippagePerContract) ?? 0);
  const dteModels = new Map();
  const modelSetFor = (dte) => {
    if (!dteModels.has(dte)) {
      const forecastVol = volProfile?.garchOk
        ? finite(volProfile.garch?.forecast(dte)) : null;
      dteModels.set(dte, {
        forecastVol,
        models: buildUnderwriteModelSet({
          spot: underlying, dte, forecastVol, returns, samples,
          seed: `${seed}:${ticker}`,
        }),
      });
    }
    return dteModels.get(dte);
  };

  const rows = puts.map((contract) => {
    const strike = finite(contract.strike);
    const dte = finite(contract.dte);
    const bid = finite(contract.bid);
    const ask = finite(contract.ask);
    const iv = finite(contract.iv);
    const t = dteToT(dte);
    const discount = Math.exp(-rateUsed * t);
    const grossCredit = bid * 100;
    const netCredit = grossCredit - fees;
    const grossObligation = strike * 100;
    const modeledNetTiedCash = grossObligation - netCredit;
    const verifiedBrokerRequirement = brokerCashRequirementVerified
      ? finite(brokerCashRequirement) : null;
    const netTiedCash = verifiedBrokerRequirement ?? modeledNetTiedCash;
    const assignedBasis = strike - netCredit / 100;
    const maxLoss = grossObligation - netCredit;
    const insideLife = eventLabels(events, now, dte);
    const { warnings, mid, spreadPct } = quoteWarnings(contract, insideLife);
    const { forecastVol, models } = modelSetFor(dte);
    warnings.push('JUMP_DIAGNOSTIC_UNCALIBRATED_POSSIBLE_DOUBLE_COUNT');
    if (!models.bootstrap) warnings.push('PRIMARY_BLOCK_BOOTSTRAP_UNAVAILABLE');
    if (!(forecastVol > 0)) warnings.push('PARAMETRIC_MODEL_VOLATILITY_UNAVAILABLE');
    const modelResults = Object.fromEntries(Object.entries(models).map(([name, dist]) => [
      name, evaluateShortOptionModel(dist, {
        right: 'put', strike, netCredit, discount, capital: grossObligation,
      }),
    ]));
    const riskNeutralFinishItm = iv > 0 ? probItm({
      type: 'put', spot: underlying, strike, vol: iv, t, rate: rateUsed, yield: yieldUsed,
    }) : null;
    const cashCarryCost0 = presentValueCashCarryCost({
      netTiedCash, t, discount, alternativeRate: cashRate,
      collateralRate, alternativeRateVerified: alternativeCashRateVerified,
      collateralRateVerified: collateralCashRateVerified,
    });
    const marketValue = mid !== null ? mid * 100 : null;
    const modelComparisons = Object.fromEntries(Object.entries(modelResults).map(([name, result]) => [
      name, result ? {
        market_mid_minus_model_value: marketValue !== null ? marketValue - result.model_value : null,
        raw_nev_0: result.raw_nev_0,
        cash_carry_cost_0: cashCarryCost0,
        cash_adj_nev_0: cashCarryCost0 === null ? null : result.raw_nev_0 - cashCarryCost0,
      } : null,
    ]));
    return {
      symbol: ticker,
      contract: contract.symbol ?? null,
      expiration: contract.expiration ?? null,
      dte,
      strike,
      quote: {
        bid, ask, mid, spread: ask !== null ? ask - bid : null, spread_pct_of_mid: spreadPct,
        quote_asof: finite(contract.quoteAsOf), open_interest: finite(contract.openInterest),
        volume: finite(contract.volume), strike_iv: iv, delta: finite(contract.delta),
        gamma: finite(contract.gamma), vega: finite(contract.vega), theta: finite(contract.theta),
        greek_units: contract.greekUnits ?? null,
      },
      one_contract_economics: {
        gross_credit_at_executable_bid: grossCredit,
        verified_fees: fees,
        net_credit: netCredit,
        gross_obligation: grossObligation,
        net_tied_cash: netTiedCash,
        net_tied_cash_source: verifiedBrokerRequirement === null
          ? 'STRIKE_TIMES_100_MINUS_NET_CREDIT' : 'VERIFIED_BROKER_REQUIREMENT',
        assigned_basis: assignedBasis,
        max_loss_to_zero: maxLoss,
        simple_premium_to_collateral: grossObligation > 0 ? netCredit / grossObligation : null,
        simple_annualized_premium_to_collateral: grossObligation > 0
          ? (netCredit / grossObligation) * 365 / dte : null,
        alternative_cash_rate: cashRate,
        collateral_cash_rate: collateralRate,
        cash_carry_cost_0: cashCarryCost0,
        cash_adj_status: cashCarryCost0 === null ? 'UNAVAILABLE_RATE_PAIR_UNVERIFIED' : 'CALCULATED',
        target_basis: target,
        target_basis_met: target !== null ? assignedBasis <= target : null,
      },
      market_math: {
        risk_neutral_finish_itm_european: available(riskNeutralFinishItm),
        risk_free_rate: rateUsed,
        continuous_dividend_yield: yieldUsed,
        model_time_to_expiry_years: t,
        expiry_level_forecast_vol: forecastVol,
        signed_distance_in_expiry_vols: forecastVol > 0
          ? (strike - underlying) / (underlying * forecastVol * Math.sqrt(t)) : null,
      },
      models: modelResults,
      headline_models: {
        primary: CASH_SECURED_PUT_PRIMARY_MODEL,
        primary_nev: modelResults[CASH_SECURED_PUT_PRIMARY_MODEL]?.nev ?? null,
        primary_monte_carlo_standard_error:
          modelResults[CASH_SECURED_PUT_PRIMARY_MODEL]?.monte_carlo_standard_error ?? null,
        primary_cash_adj_nev_0: modelResults[CASH_SECURED_PUT_PRIMARY_MODEL] && cashCarryCost0 !== null
          ? modelResults[CASH_SECURED_PUT_PRIMARY_MODEL].raw_nev_0 - cashCarryCost0 : null,
        stress: CASH_SECURED_PUT_STRESS_MODEL,
        stress_nev: modelResults[CASH_SECURED_PUT_STRESS_MODEL]?.nev ?? null,
        stress_monte_carlo_standard_error:
          modelResults[CASH_SECURED_PUT_STRESS_MODEL]?.monte_carlo_standard_error ?? null,
        stress_veto: 'NOT_REGISTERED_MATH_ONLY_CALCULATOR_HAS_NO_DECISION',
      },
      model_comparisons: modelComparisons,
      events_in_tenor: insideLife,
      warnings: [...new Set(warnings)],
      labels: {
        risk_neutral_probability: 'EUROPEAN_RISK_NEUTRAL_FINISH_ITM_NOT_PHYSICAL_ASSIGNMENT_PROBABILITY',
        early_assignment: 'AMERICAN_EQUITY_OPTION_EARLY_ASSIGNMENT_NOT_MODELED',
        annualization: 'SIMPLE_NON_COMPOUNDED_365_OVER_DTE_NOT_A_FORECAST',
        cash_carry: cashCarryCost0 === null
          ? 'UNAVAILABLE_UNLESS_ALTERNATIVE_AND_COLLATERAL_YIELDS_ARE_BOTH_VERIFIED'
          : 'PRESENT_VALUE_DIFFERENCE_BETWEEN_VERIFIED_ALTERNATIVE_AND_COLLATERAL_YIELDS',
      },
    };
  }).sort((a, b) => String(a.expiration ?? '').localeCompare(String(b.expiration ?? ''))
    || a.dte - b.dte || a.strike - b.strike);

  return {
    ok: true,
    outcome: 'CSP_MATH_CALCULATED',
    symbol: ticker,
    spot: underlying,
    contracts: 1,
    rows,
    row_count: rows.length,
    execution: 'READ_ONLY_MATH_NO_ORDER_ROUTE',
    mutation_eligible: false,
    selection: 'NONE_ALL_ROWS_VISIBLE_DEFAULT_SORT_EXPIRY_THEN_STRIKE',
    governance: 'NOT_CONSULTED',
    account_state: 'NOT_READ',
    rate_assumptions: {
      risk_free_rate: rateUsed,
      risk_free_rate_source: 'CONSTITUTION_RISK_FREE_RATE',
      continuous_dividend_yield: yieldUsed,
      dividend_yield_source: yieldUsed === 0
        ? 'INTENTIONAL_ZERO_NO_VERIFIED_CONTINUOUS_DIVIDEND_YIELD' : 'CALLER_SUPPLIED',
      alternative_cash_rate: cashRate,
      alternative_cash_rate_verified: Boolean(alternativeCashRateVerified),
      collateral_cash_rate: collateralRate,
      collateral_cash_rate_verified: Boolean(collateralCashRateVerified),
    },
    rate_contract: {
      raw_nev_0: 'C_NET_MINUS_EXP_NEG_R_T_TIMES_EXPECTED_PUT_LIABILITY',
      cash_carry_cost_0:
        'EXP_NEG_R_T_TIMES_C_TIED_TIMES_EXP_Y_ALT_T_MINUS_EXP_Y_COLL_T',
      cash_adj_nev_0: 'RAW_NEV_0_MINUS_CASH_CARRY_COST_0',
      default_c_tied: 'STRIKE_TIMES_100_MINUS_NET_CREDIT',
      broker_requirement_override: 'ONLY_WHEN_FETCHED_AND_VERIFIED',
      cash_yields_in_risk_neutral_probability: 'NEVER',
    },
    fee_assumptions: { ...costs, total_per_contract: fees, credit_source: 'EXECUTABLE_BID_NO_EXTRA_SLIPPAGE' },
    physical_model_status: rows.some((row) => row.models.bootstrap)
      ? 'PRIMARY_MODELED_UNCALIBRATED' : 'PRIMARY_UNAVAILABLE',
    calibration: {
      status: 'UNCALIBRATED',
      n: 0,
      unlock_condition: 'SEALED_ROWS_WITH_OBSERVED_TERMINAL_S_T_REQUIRED',
    },
    sample_count_per_member: samples,
    history_sessions: usableBars.length,
    model_definitions: CASH_SECURED_PUT_MODELS,
    model_assumptions: {
      primary: {
        model: CASH_SECURED_PUT_PRIMARY_MODEL,
        status: 'PROVISIONAL_UNCALIBRATED',
        reason: 'Ticker-specific empirical returns preserve observed skew and five-session volatility clustering without imposing an unfit global jump law.',
        drift: 'ZERO_ARITHMETIC_DRIFT_EXACT_SAMPLE_NORMALIZATION',
        volatility: 'EMPIRICAL_CENTERED_DAILY_LOG_RETURN_BLOCKS_NO_PARAMETRIC_SIGMA',
      },
      lognormal: {
        drift: 'ZERO_ARITHMETIC_PRICE_DRIFT',
        volatility: 'ANNUALIZED_GARCH_1_1_DTE_FORECAST_FROM_DAILY_CLOSE_LOG_RETURNS',
      },
      studentT: {
        drift: 'ZERO_ARITHMETIC_DRIFT_EXACT_SAMPLE_NORMALIZATION',
        volatility: 'SAME_ANNUALIZED_GARCH_1_1_DTE_FORECAST_WITH_DF5_SHOCK_NORMALIZED_TO_UNIT_VARIANCE',
      },
      jump: {
        drift: 'ZERO_ARITHMETIC_DRIFT_THEORETICAL_JUMP_COMPENSATOR',
        volatility: 'SAME_ANNUALIZED_GARCH_1_1_DTE_DIFFUSION_VOL_PLUS_GLOBAL_UNCALIBRATED_POISSON_JUMPS',
        caution: 'GARCH_INPUT_RETURNS_ALREADY_CONTAIN_HISTORICAL_JUMPS_SO_ADDITIVE_JUMPS_CAN_DOUBLE_COUNT_JUMP_VARIANCE',
      },
      volatilityStress: {
        drift: 'ZERO_ARITHMETIC_PRICE_DRIFT',
        volatility: 'ONE_POINT_TWO_FIVE_TIMES_ANNUALIZED_GARCH_1_1_DTE_FORECAST',
        decision_effect: 'DISPLAY_ONLY_NO_REGISTERED_VETO',
      },
    },
    time_basis: 'TODAY_DOLLARS_PREMIUM_TODAY_MINUS_DISCOUNTED_TERMINAL_ASSIGNMENT_LIABILITY',
  };
}
