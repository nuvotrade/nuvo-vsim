/**
 * Strike and structure optimisation (§9, §10).
 *
 * Never "sell the 20-delta put". The whole admissible chain is evaluated,
 * and delta is an INPUT to that evaluation rather than the decision rule.
 *
 * Then — and only then — the structure is chosen. A CSP and a spread on the
 * same thesis routinely disagree about which is better, and which one wins
 * depends on capital and tail shape, not on which one NUVO likes.
 */
import { cashSecuredPut, bullPutSpread, coveredCall, longShares, noTrade, STRUCTURE } from './structure.js';
import { underwrite } from '../underwriter/underwrite.js';
import { isPermitted, stanceFor, STANCE } from '../market/regime.js';
import { isNum } from '../math/stats.js';

/**
 * Utility function from §9:  U(K) = EV(K) - lambda*CVaR(K) - gamma*Capital(K)
 *
 * NEV already contains the CVaR penalty, so what remains is the explicit
 * capital charge — the cost of tying money up where it cannot work.
 */
export function utility(result, { gamma = 0.01, dte = 30 } = {}) {
  const nev = result.evaluation.nev;
  const bp = result.structure.buyingPower ?? 0;
  // gamma is an annual carrying charge on locked capital, pro-rated.
  const carry = gamma * bp * (dte / 365);
  return nev - carry;
}

/**
 * Enumerate every admissible candidate for one underlying.
 *
 * Returns ALL of them, admissible or not. The rejected candidates are
 * evidence (§19) — knowing what NUVO looked at and turned down is how a
 * decision becomes reconstructable.
 */
export function enumerateCandidates({
  underlyingState,
  chain,
  dist,
  diffusionDist,
  regime,
  limits,
  calibrationStore,
  strategyId,
  contracts = 1,
  deltaBand = [0.05, 0.45],
  maxSpreadWidth = 6,
  holdings = null,
}) {
  const candidates = [];
  const spot = underlyingState.spot;
  const [dLo, dHi] = deltaBand;

  const puts = chain.contracts
    .filter((c) => c.right === 'put' && isNum(c.delta) && Math.abs(c.delta) >= dLo && Math.abs(c.delta) <= dHi)
    .sort((a, b) => b.strike - a.strike);

  const score = (structure) => {
    if (!structure) return null;
    return underwrite({
      structure, dist, diffusionDist, underlyingState, regime, limits,
      calibrationStore, strategyId,
    });
  };

  // ── Cash-secured puts across the whole admissible chain ──
  if (isPermitted(regime?.regime, STRUCTURE.CSP)) {
    for (const put of puts) {
      const s = cashSecuredPut({ underlying: chain.underlying, put, contracts });
      const r = score(s);
      if (r) candidates.push(r);
    }
  }

  // ── Bull put spreads: every short strike against every valid long ──
  if (isPermitted(regime?.regime, STRUCTURE.BULL_PUT_SPREAD)) {
    const allPuts = chain.contracts.filter((c) => c.right === 'put').sort((a, b) => b.strike - a.strike);
    for (const shortPut of puts) {
      for (const longPut of allPuts) {
        if (longPut.strike >= shortPut.strike) continue;
        const width = shortPut.strike - longPut.strike;
        if (width > maxSpreadWidth * (spot > 200 ? 5 : 1)) continue;
        if (longPut.expiration !== shortPut.expiration) continue;
        const s = bullPutSpread({ underlying: chain.underlying, shortPut, longPut, contracts });
        const r = score(s);
        if (r) candidates.push(r);
      }
    }
  }

  // ── Covered calls, only where shares are actually held (§11) ──
  const shares = holdings?.shares ?? 0;
  if (shares >= 100 && isPermitted(regime?.regime, STRUCTURE.COVERED_CALL)) {
    const calls = chain.contracts
      .filter((c) => c.right === 'call' && isNum(c.delta) && c.delta >= 0.10 && c.delta <= 0.45);
    for (const call of calls) {
      const s = coveredCall({
        underlying: chain.underlying, call, shares,
        costBasis: holdings.costBasis ?? spot,
      });
      const r = score(s);
      if (r) candidates.push(r);
    }
  }

  // ── Shares, so "just own it" competes rather than being assumed away ──
  if (stanceFor(regime?.regime, STRUCTURE.SHARES) !== STANCE.FORBIDDEN) {
    const s = longShares({ underlying: chain.underlying, spot, shares: 100 });
    const r = score(s);
    if (r) candidates.push(r);
  }

  return candidates;
}

/**
 * Choose the best candidate — or NO TRADE.
 *
 * NO_TRADE is inserted as a real competitor with zero EV and zero capital.
 * Because every admissible candidate must have positive NEV, a field of
 * negative-NEV candidates genuinely loses to doing nothing. That is the
 * mechanism, not a slogan.
 */
export function selectBest(candidates, { gamma = 0.01, limits, reason } = {}) {
  const admissible = candidates.filter((c) => c.admissible);
  const ranked = admissible
    .map((c) => ({ ...c, utility: utility(c, { gamma, dte: c.dte }) }))
    .sort((a, b) => {
      // Primary key is RAROC (§20). Utility breaks ties, because two
      // candidates can share a RAROC while consuming very different capital.
      if (b.score !== a.score) return b.score - a.score;
      return b.utility - a.utility;
    });

  if (!ranked.length) {
    const best = candidates.slice().sort((a, b) => b.evaluation.nev - a.evaluation.nev)[0];
    return {
      selected: null,
      decision: STRUCTURE.NO_TRADE,
      structure: noTrade({
        reason: reason ?? (best
          ? `Best of ${candidates.length} candidates failed: ${best.violations[0]?.message ?? 'no admissible candidate'}`
          : 'No candidates generated.'),
      }),
      ranked: [],
      rejected: candidates,
      note: 'NO TRADE is the output. Idle capital beats negative expectancy.',
    };
  }

  return {
    selected: ranked[0],
    decision: ranked[0].structure.kind,
    structure: ranked[0].structure,
    ranked,
    rejected: candidates.filter((c) => !c.admissible),
  };
}

/**
 * Compare the winner against the best alternative of every OTHER structure
 * type. This is the §10 comparison made explicit and recorded: the
 * evidence package should show that the spread was considered and why the
 * CSP won, or vice versa.
 */
export function structureComparison(candidates) {
  const byKind = new Map();
  for (const c of candidates) {
    const cur = byKind.get(c.structure.kind);
    if (!cur || c.score > cur.score) byKind.set(c.structure.kind, c);
  }
  return [...byKind.entries()]
    .map(([kind, c]) => ({
      kind,
      admissible: c.admissible,
      nev: c.evaluation.nev,
      ev: c.evaluation.ev,
      cvar: c.evaluation.cvar,
      raroc: c.capital.raroc,
      buyingPower: c.structure.buyingPower,
      economicCapital: c.capital.economicCapital,
      shortStrike: c.structure.shortStrike,
      blockedBy: c.violations[0]?.message ?? null,
    }))
    .sort((a, b) => (b.raroc ?? -Infinity) - (a.raroc ?? -Infinity));
}
