export const MONEY_CENTS_ROUNDING_RULE =
  'NET_EXACT_SUBCENT_THEN_HALF_AWAY_FROM_ZERO_TO_CENT';

function invariant(condition, code) {
  if (!condition) throw new Error(`MONEY_CENTS:${code}`);
}

function decimal(value, label) {
  invariant((typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== ''), `${label}_DECIMAL_REQUIRED`);
  const source = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u.exec(source);
  invariant(match, `${label}_DECIMAL_INVALID`);
  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  invariant(Number.isSafeInteger(exponent), `${label}_EXPONENT_INVALID`);
  let units = BigInt(`${match[2]}${fraction}` || '0') * sign;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return { units, scale };
}

function rescale(value, scale) {
  invariant(scale >= value.scale, 'SCALE_REDUCTION_FORBIDDEN');
  return value.units * (10n ** BigInt(scale - value.scale));
}

function roundToCents(units, scale) {
  if (scale <= 2) return units * (10n ** BigInt(2 - scale));
  const divisor = 10n ** BigInt(scale - 2);
  const magnitude = units < 0n ? -units : units;
  let cents = magnitude / divisor;
  const remainder = magnitude % divisor;
  if (remainder * 2n >= divisor) cents += 1n;
  return units < 0n ? -cents : cents;
}

function safeCents(value) {
  const cents = Number(value);
  invariant(Number.isSafeInteger(cents), 'SAFE_INTEGER_CENTS_REQUIRED');
  return cents;
}

/**
 * Add exact decimal terms first, then apply the named rounding rule once.
 * Each multiplier must be an integer (for example, signed share quantity).
 */
export function netMoneyCents(terms) {
  invariant(Array.isArray(terms) && terms.length > 0, 'TERMS_REQUIRED');
  const parsed = terms.map((term, index) => {
    const multiplier = term?.multiplier ?? 1;
    invariant(Number.isSafeInteger(multiplier), `TERM_${index}_INTEGER_MULTIPLIER_REQUIRED`);
    const value = decimal(term?.value, `TERM_${index}`);
    return { units: value.units * BigInt(multiplier), scale: value.scale };
  });
  const scale = Math.max(...parsed.map((value) => value.scale));
  const exact = parsed.reduce((total, value) => total + rescale(value, scale), 0n);
  return safeCents(roundToCents(exact, scale));
}

export function moneyCents(value) {
  return netMoneyCents([{ value }]);
}

export function centsToUsd(cents) {
  invariant(Number.isSafeInteger(cents), 'SAFE_INTEGER_CENTS_REQUIRED');
  return cents / 100;
}

export function centsToDecimal(cents) {
  invariant(Number.isSafeInteger(cents), 'SAFE_INTEGER_CENTS_REQUIRED');
  const sign = cents < 0 ? '-' : '';
  const magnitude = Math.abs(cents);
  return `${sign}${Math.trunc(magnitude / 100)}.${String(magnitude % 100).padStart(2, '0')}`;
}

export function formatCents(cents, { absolute = false } = {}) {
  invariant(Number.isSafeInteger(cents), 'SAFE_INTEGER_CENTS_REQUIRED');
  const value = absolute ? Math.abs(cents) : cents;
  const decimalValue = centsToDecimal(value);
  return decimalValue.startsWith('-') ? `-$${decimalValue.slice(1)}` : `$${decimalValue}`;
}

export function formatExecutionPrice(value) {
  const number = Number(value);
  invariant(Number.isFinite(number) && number > 0, 'EXECUTION_PRICE_REQUIRED');
  return `$${number.toFixed(3)}`;
}
