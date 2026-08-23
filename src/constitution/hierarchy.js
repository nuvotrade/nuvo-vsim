/**
 * The permanent hierarchy (§27).
 *
 *   TRUTH > SURVIVAL > EXPECTANCY > CAPITAL EFFICIENCY > INCOME
 *
 * This is not documentation. Every rejection carries the tier it was
 * rejected at, and a lower tier can never overrule a higher one — a trade
 * with spectacular expectancy that violates a survival limit is dead, and
 * the record says SURVIVAL, not "low score".
 */
export const TIER = Object.freeze({
  TRUTH: 1,
  SURVIVAL: 2,
  EXPECTANCY: 3,
  CAPITAL_EFFICIENCY: 4,
  INCOME: 5,
});

export const TIER_NAME = Object.freeze(
  Object.fromEntries(Object.entries(TIER).map(([k, v]) => [v, k])),
);

/** Sort violations so the most fundamental reason is always reported first. */
export function bySeverity(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  return String(a.code).localeCompare(String(b.code));
}

/**
 * A structured refusal. NUVO never rejects with a bare boolean —
 * every "no" is attributable years later (§19).
 */
export class Violation {
  constructor(tier, code, message, detail = {}) {
    this.tier = tier;
    this.tierName = TIER_NAME[tier];
    this.code = code;
    this.message = message;
    this.detail = detail;
  }

  toString() {
    return `[${this.tierName}/${this.code}] ${this.message}`;
  }
}

export const violation = (tier, code, message, detail) =>
  new Violation(tier, code, message, detail);

/** Highest-priority (numerically lowest) tier present in a violation list. */
export function governingTier(violations) {
  if (!violations.length) return null;
  return violations.reduce((m, v) => Math.min(m, v.tier), Infinity);
}
