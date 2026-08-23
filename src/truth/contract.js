/**
 * The Truth Contract (§18).
 *
 * "If NUVO cannot verify ... then NO NEW ORDER."
 *
 * The rule this file exists to enforce is narrow and absolute: absence of
 * data must never be representable as a value. There is no default vol, no
 * assumed Greek, no last-known-good chain quietly reused an hour later.
 * A missing field produces a REFUSAL, and the refusal names the field.
 */
import { TIER, violation } from '../constitution/hierarchy.js';
import { isNum } from '../math/stats.js';

/** Facts the engine must hold before it may construct an order. */
export const REQUIRED_FACTS = Object.freeze([
  'accountState',
  'marketStatus',
  'underlyingQuote',
  'optionChain',
  'greeks',
  'positions',
  'openOrders',
  'buyingPower',
  'modelVersion',
  'eventCalendar',
]);

export const VERDICT = Object.freeze({
  VERIFIED: 'VERIFIED',
  DEGRADED: 'DEGRADED',   // observable, but not tradeable
  REFUSED: 'REFUSED',     // fail closed
});

/**
 * A single verified fact. `value` is only readable once `ok` is true —
 * `require()` throws rather than handing back a placeholder.
 */
export class Fact {
  constructor(name, { value = undefined, asOf = null, source = null, error = null } = {}) {
    this.name = name;
    this._value = value;
    this.asOf = asOf;
    this.source = source;
    this.error = error;
  }

  get ok() {
    return this.error === null && this._value !== undefined && this._value !== null;
  }

  ageMs(now) {
    return isNum(this.asOf) ? now - this.asOf : Infinity;
  }

  /** Read the value, or fail loudly. Never returns a fabricated fallback. */
  require() {
    if (!this.ok) {
      throw new TruthViolationError(
        `Fact '${this.name}' is not verified${this.error ? `: ${this.error}` : ''}.`,
      );
    }
    return this._value;
  }

  /** Read the value only when you have already checked `ok`. */
  peek() {
    return this.ok ? this._value : undefined;
  }
}

export class TruthViolationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'TruthViolationError';
    this.detail = detail;
  }
}

/**
 * The result of verifying a snapshot. Note the two independent booleans:
 * `observable` (the UI may render) and `tradeable` (orders may be built).
 * Collapsing them is exactly the failure §18 forbids.
 */
export class TruthReport {
  constructor({ verdict, facts, violations, now, staleness }) {
    this.verdict = verdict;
    this.facts = facts;
    this.violations = violations;
    this.now = now;
    this.staleness = staleness;
  }

  get observable() {
    return true; // The dashboard always renders. Only authority is withdrawn.
  }

  get tradeable() {
    return this.verdict === VERDICT.VERIFIED;
  }

  get(name) {
    return this.facts[name];
  }

  /** Convenience: throws unless every required fact verified. */
  requireTradeable() {
    if (!this.tradeable) {
      throw new TruthViolationError('Snapshot is not tradeable.', {
        verdict: this.verdict,
        violations: this.violations.map(String),
      });
    }
    return this;
  }

  summary() {
    return {
      verdict: this.verdict,
      tradeable: this.tradeable,
      missing: Object.values(this.facts).filter((f) => !f.ok).map((f) => f.name),
      stale: Object.entries(this.staleness)
        .filter(([, s]) => s.stale)
        .map(([k, s]) => ({ fact: k, ageMs: s.ageMs, limitMs: s.limitMs })),
      violations: this.violations.map(String),
    };
  }
}

const FRESHNESS_LIMIT = {
  underlyingQuote: 'maxQuoteAgeMs',
  optionChain: 'maxChainAgeMs',
  greeks: 'maxChainAgeMs',
  accountState: 'maxAccountAgeMs',
  positions: 'maxAccountAgeMs',
  openOrders: 'maxAccountAgeMs',
  buyingPower: 'maxAccountAgeMs',
};

/**
 * Verify a raw snapshot into a TruthReport.
 *
 * `snapshot` maps fact name -> { value, asOf, source, error }.
 * Anything absent is treated as missing, not as zero.
 */
export function verify(snapshot, { limits, now, required = REQUIRED_FACTS }) {
  const facts = {};
  const violations = [];
  const staleness = {};

  for (const name of required) {
    const raw = snapshot?.[name];
    const fact = raw instanceof Fact ? raw : new Fact(name, raw ?? { error: 'absent' });
    facts[name] = fact;

    if (!fact.ok) {
      violations.push(violation(
        TIER.TRUTH, 'FACT_UNVERIFIED',
        `Required fact '${name}' could not be verified${fact.error ? ` (${fact.error})` : ''}.`,
        { fact: name, error: fact.error },
      ));
      continue;
    }

    const limitKey = FRESHNESS_LIMIT[name];
    if (limitKey) {
      const limitMs = limits[limitKey];
      const ageMs = fact.ageMs(now);
      const stale = ageMs > limitMs;
      staleness[name] = { ageMs, limitMs, stale };
      if (stale) {
        violations.push(violation(
          TIER.TRUTH, 'FACT_STALE',
          `Fact '${name}' is ${Math.round(ageMs / 1000)}s old; limit is ${Math.round(limitMs / 1000)}s.`,
          { fact: name, ageMs, limitMs },
        ));
      }
    }
  }

  // Carry any extra facts through unverified-but-present, for evidence.
  for (const [name, raw] of Object.entries(snapshot ?? {})) {
    if (!facts[name]) facts[name] = raw instanceof Fact ? raw : new Fact(name, raw);
  }

  const verdict = violations.length === 0
    ? VERDICT.VERIFIED
    : (violations.length >= required.length ? VERDICT.REFUSED : VERDICT.DEGRADED);

  return new TruthReport({ verdict, facts, violations, now, staleness });
}

/**
 * Structural sanity checks on an option chain. A chain that arrives
 * intact but incoherent (crossed markets, zero bids, missing Greeks) is
 * just as dangerous as a missing one, and far more convincing.
 */
export function auditChain(chain, { limits, now }) {
  const problems = [];
  if (!Array.isArray(chain?.contracts) || chain.contracts.length === 0) {
    problems.push(violation(TIER.TRUTH, 'CHAIN_EMPTY', 'Option chain contains no contracts.'));
    return problems;
  }
  if (isNum(chain.asOf) && now - chain.asOf > limits.maxChainAgeMs) {
    problems.push(violation(TIER.TRUTH, 'CHAIN_STALE',
      `Chain is ${Math.round((now - chain.asOf) / 1000)}s old.`, { asOf: chain.asOf }));
  }
  let crossed = 0;
  let missingGreeks = 0;
  let zeroBid = 0;
  for (const c of chain.contracts) {
    if (isNum(c.bid) && isNum(c.ask)) {
      if (c.ask < c.bid) crossed += 1;
      if (c.bid <= 0) zeroBid += 1;
    } else {
      missingGreeks += 1; // no two-sided market at all
    }
    if (!isNum(c.delta) || !isNum(c.iv)) missingGreeks += 1;
  }
  if (crossed > 0) {
    problems.push(violation(TIER.TRUTH, 'CHAIN_CROSSED',
      `${crossed} contracts quote a crossed market.`, { crossed }));
  }
  const missingRatio = missingGreeks / chain.contracts.length;
  if (missingRatio > 0.25) {
    problems.push(violation(TIER.TRUTH, 'CHAIN_INCOMPLETE',
      `${(missingRatio * 100).toFixed(0)}% of contracts lack Greeks or a two-sided quote.`,
      { missingRatio }));
  }
  return problems;
}
