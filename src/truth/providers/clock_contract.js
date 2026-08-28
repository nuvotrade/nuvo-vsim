export const PRODUCTION_CLOCK_CONTRACT_VERSION = 'PRODUCTION_CLOCK_DOMAINS_V1';

export const CLOCK_FAULT = Object.freeze({
  DECISION_TIME_MISSING: 'DECISION_TIME_MISSING',
  DECISION_TIME_INVALID: 'DECISION_TIME_INVALID',
  ACQUISITION_TIME_MISSING: 'RESPONSE_ACQUISITION_TIMESTAMP_MISSING',
  ACQUISITION_TIME_INVALID: 'RESPONSE_ACQUISITION_TIMESTAMP_INVALID',
  VENDOR_TIME_MISSING: 'VENDOR_QUOTE_TIMESTAMP_MISSING',
  VENDOR_TIME_INVALID: 'VENDOR_QUOTE_TIMESTAMP_INVALID',
  VENDOR_TIME_FUTURE: 'VENDOR_QUOTE_TIMESTAMP_FUTURE',
  VENDOR_TIME_STALE: 'VENDOR_QUOTE_STALE',
});

function epochMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric > 1e17) return Math.floor(numeric / 1e6);
    if (numeric > 1e14) return Math.floor(numeric / 1e3);
    if (numeric > 1e11) return numeric;
    if (numeric > 1e9) return numeric * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function requireDecisionTime(value) {
  if (value === null || value === undefined || value === '') {
    throw new Error(CLOCK_FAULT.DECISION_TIME_MISSING);
  }
  const decisionTime = epochMs(value);
  if (!Number.isFinite(decisionTime)) throw new Error(CLOCK_FAULT.DECISION_TIME_INVALID);
  return decisionTime;
}

/**
 * Evaluate quote freshness only in the acquisition clock domain.
 *
 * The vendor timestamp is mandatory. `acquiredAt` proves when VSIM had the
 * response in hand; it is never a substitute for the vendor's quote time.
 */
export function evaluateQuoteFreshness({
  vendorAsOf,
  acquiredAt,
  maxAgeMs,
  futureToleranceMs = 10_000,
} = {}) {
  if (vendorAsOf === null || vendorAsOf === undefined || vendorAsOf === '') {
    return { ok: false, error: CLOCK_FAULT.VENDOR_TIME_MISSING };
  }
  const quoteAsOf = epochMs(vendorAsOf);
  if (!Number.isFinite(quoteAsOf)) {
    return { ok: false, error: CLOCK_FAULT.VENDOR_TIME_INVALID };
  }
  if (acquiredAt === null || acquiredAt === undefined || acquiredAt === '') {
    return { ok: false, error: CLOCK_FAULT.ACQUISITION_TIME_MISSING };
  }
  const acquisitionTime = epochMs(acquiredAt);
  if (!Number.isFinite(acquisitionTime)) {
    return { ok: false, error: CLOCK_FAULT.ACQUISITION_TIME_INVALID };
  }
  const ageMs = acquisitionTime - quoteAsOf;
  if (ageMs < -futureToleranceMs) {
    return {
      ok: false,
      error: CLOCK_FAULT.VENDOR_TIME_FUTURE,
      quoteAsOf,
      acquiredAt: acquisitionTime,
      ageMs,
    };
  }
  if (!Number.isFinite(Number(maxAgeMs)) || Number(maxAgeMs) < 0 || ageMs > Number(maxAgeMs)) {
    return {
      ok: false,
      error: CLOCK_FAULT.VENDOR_TIME_STALE,
      quoteAsOf,
      acquiredAt: acquisitionTime,
      ageMs,
    };
  }
  return {
    ok: true,
    quoteAsOf,
    acquiredAt: acquisitionTime,
    ageMs,
    clockContractVersion: PRODUCTION_CLOCK_CONTRACT_VERSION,
  };
}
