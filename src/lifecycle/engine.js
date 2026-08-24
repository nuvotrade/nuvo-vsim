/**
 * The Lifecycle Engine (§12, §13).
 *
 * NUVO does not repair trades. It REALLOCATES. When a position
 * deteriorates, the entry price is sunk and irrelevant; the only question
 * is which action has the highest forward expected value from here:
 *
 *   EV(hold) vs EV(close) vs EV(roll) vs EV(alternative)
 *
 * This removes anchoring, and with it the whole family of behaviours —
 * "wheel it until I recover", "I'll get back to breakeven" — that turn a
 * bad trade into a bad quarter.
 */
import { POSITION_STATE, capturedFraction, adverseSigma } from './contract.js';
import { evaluate } from '../underwriter/ev.js';
import { capitalProfile } from '../underwriter/capital.js';
import { isNum } from '../math/stats.js';

export const ACTION = Object.freeze({
  HOLD: 'HOLD',
  HARVEST: 'HARVEST',       // profit target reached
  CLOSE: 'CLOSE',           // forward EV says leave
  ROLL: 'ROLL',
  REDUCE: 'REDUCE',
  REUNDERWRITE: 'REUNDERWRITE',
  ASSIGN_DECISION: 'ASSIGN_DECISION',
});

/**
 * Forward expected value of HOLDING to expiry from the current state.
 *
 * Derived so the sunk entry credit cancels out exactly.
 *
 *   structure.payoff(S) = entryCredit - obligation(S)
 *   => obligation(S)    = entryCredit - structure.payoff(S)
 *
 * Holding from here means: keep the mark NUVO would otherwise pay to close
 * (`currentMarkDebit`), and owe the obligation at expiry. So
 *
 *   forwardPnl(S) = currentMarkDebit - obligation(S)
 *                 = structure.payoff(S) + currentMarkDebit - entryCredit
 *
 * which is the entry payoff shifted by a constant. The entry credit appears
 * only to be cancelled — it never influences the ranking, which is the
 * whole point of 13.
 */
export function evHold({
  structure, dist, diffusionDist, currentMarkDebit, costs, lambdas,
}) {
  // `position` is deliberately NOT a parameter. Nothing about what was paid
  // may reach this valuation, and the surest way to guarantee that is for
  // the function to have no access to it.
  // The shift is taken against the STRUCTURE's own credit, never against
  // position.entryCredit. They are normally the same number, but reading it
  // from the position would make anchor-freedom a coincidence that a
  // restated entry price could break. Taking it from the structure makes
  // the cancellation algebraic: whatever was actually paid cannot enter here.
  const shift = currentMarkDebit - structure.credit;
  const forwardStructure = {
    ...structure,
    payoff: (S) => structure.payoff(S) + shift,
    // Holding incurs no entry cost; only the eventual exit, which the
    // expiry case does not pay at all.
    legs: structure.legs,
  };
  const ev = evaluate({
    structure: forwardStructure,
    dist,
    diffusionDist,
    // Entry costs are sunk; only a future exit is chargeable, and a
    // position held to expiry does not pay one.
    costs: { ...costs, roundTrip: false, commissionPerContract: 0, exchangeFeePerContract: 0, slippageHalfSpreads: 0 },
    lambdas,
  });
  return {
    action: ACTION.HOLD,
    forwardEv: ev.ev,
    nev: ev.nev,
    cvar: ev.cvar,
    detail: ev,
  };
}

/**
 * Forward EV of CLOSING now: pay the mark plus exit costs, and free the
 * capital. Certainty has value — the CVaR of a closed position is zero.
 */
export function evClose({ currentMarkDebit, exitCost, freedCapital }) {
  return {
    action: ACTION.CLOSE,
    forwardEv: -currentMarkDebit - exitCost,
    nev: -currentMarkDebit - exitCost,
    cvar: 0,
    freedCapital,
    detail: { currentMarkDebit, exitCost },
  };
}

/**
 * Forward EV of ROLLING: close the current obligation and open a new one.
 * The new leg is underwritten from scratch — a roll is only justified if
 * the NEW position would be worth opening on its own merits. Rolling into
 * a position NUVO would not otherwise take is repair wearing a disguise.
 */
export function evRoll({ closeResult, newCandidate }) {
  if (!newCandidate || !newCandidate.admissible) {
    return {
      action: ACTION.ROLL,
      forwardEv: -Infinity,
      nev: -Infinity,
      rejected: true,
      reason: newCandidate
        ? `Roll target fails underwriting: ${newCandidate.violations[0]?.message}`
        : 'No admissible roll target.',
    };
  }
  return {
    action: ACTION.ROLL,
    forwardEv: closeResult.forwardEv + newCandidate.evaluation.ev,
    nev: closeResult.nev + newCandidate.evaluation.nev,
    cvar: newCandidate.evaluation.cvar,
    newCandidate,
  };
}

/**
 * Decide what to do with a position right now.
 *
 * Rules fire first (they are constitutional and pre-registered), then the
 * EV comparison decides among whatever remains.
 */
export function decide({
  position, structure, dist, diffusionDist, currentMarkDebit, currentSpot,
  currentIv, daysElapsed, exitCost, rollCandidate = null, costs, lambdas, limits, now,
}) {
  const reasons = [];
  const captured = capturedFraction(position, currentMarkDebit);
  const sigma = adverseSigma({
    entrySpot: position.entrySpot, currentSpot, iv: currentIv, daysElapsed,
  });
  const dteRemaining = position.dte - (daysElapsed ?? 0);

  // ── Pre-registered rules (§12) ──
  if (isNum(captured) && captured >= position.rules.profitExitPct) {
    return {
      action: ACTION.HARVEST,
      reason: `Captured ${(captured * 100).toFixed(0)}% of premium; rule threshold is ${(position.rules.profitExitPct * 100).toFixed(0)}%.`,
      captured, sigma, dteRemaining, ruleTriggered: 'profitExitPct',
    };
  }

  const breached = isNum(position.shortStrike) && isNum(currentSpot)
    && currentSpot < position.shortStrike;
  if (breached) reasons.push('Short strike is breached — mandatory re-underwriting.');
  if (isNum(sigma) && sigma <= -position.rules.reassessAdverseSigma) {
    reasons.push(`Adverse move of ${sigma.toFixed(2)} sigma exceeds the ${position.rules.reassessAdverseSigma} sigma reassessment trigger.`);
  }
  if (dteRemaining <= position.rules.minDteToHold) {
    reasons.push(`${dteRemaining} DTE remaining is inside the minimum hold window.`);
  }

  // ── The §13 comparison ──
  const hold = evHold({ structure, dist, diffusionDist, currentMarkDebit, costs, lambdas });
  const close = evClose({ currentMarkDebit, exitCost, freedCapital: position.buyingPower });
  const roll = evRoll({ closeResult: close, newCandidate: rollCandidate });

  const allOptions = [hold, close, roll];
  // Rank on NEV, not raw EV: the whole point is that the risk taken to earn
  // the remaining premium is part of the comparison. Options that cannot be
  // scored are excluded from RANKING but kept in the record — an evidence
  // package that silently omits the rejected roll cannot show why it lost.
  const rankable = allOptions.filter((o) => isNum(o.nev));
  rankable.sort((a, b) => b.nev - a.nev);
  const best = rankable[0];

  const forced = reasons.length > 0;
  let action = best.action;
  if (forced && action === ACTION.HOLD) {
    // A forced reassessment does not automatically mean exit — but holding
    // through a breach has to be an explicit, recorded re-underwriting
    // decision rather than a default.
    action = ACTION.REUNDERWRITE;
  }

  return {
    action,
    reason: forced
      ? reasons.join(' ')
      : `Forward NEV ranks ${best.action} highest (${best.nev.toFixed(2)}).`,
    captured,
    sigma,
    dteRemaining,
    breached,
    comparison: allOptions.map((o) => ({
      action: o.action, forwardEv: o.forwardEv, nev: o.nev, cvar: o.cvar,
      rejected: o.rejected ?? false, rejectReason: o.reason ?? null,
    })),
    /** The original entry price is deliberately absent from this decision. */
    anchorFree: true,
    now,
  };
}

/**
 * Assignment handling (§11).
 *
 * "Assignment creates a new asset state. Run a fresh decision."
 *
 * Notably this does NOT return COVERED_CALL by default. Being assigned is
 * not a reason to sell calls; it is a reason to ask what the best use of
 * the newly-held shares is, which may well be to sell them.
 */
export function onAssignment({ position, shares, costBasis, currentSpot, alternatives }) {
  const options = [];

  // 1. Sell immediately and recycle the capital.
  options.push({
    action: 'SELL_SHARES',
    forwardEv: 0, // liquidating realises the current mark, no forward edge
    freedCapital: shares * currentSpot,
    note: 'Liquidate and return capital to the allocator.',
  });

  // 2. Hold the shares outright.
  options.push({
    action: 'HOLD_SHARES',
    forwardEv: alternatives?.holdEv ?? null,
    capitalTied: shares * currentSpot,
    note: 'Only justified if long shares independently clear the hurdle.',
  });

  // 3. Covered call — evaluated, never assumed.
  if (alternatives?.coveredCall) {
    options.push({
      action: 'COVERED_CALL',
      forwardEv: alternatives.coveredCall.evaluation.ev,
      nev: alternatives.coveredCall.evaluation.nev,
      raroc: alternatives.coveredCall.capital.raroc,
      admissible: alternatives.coveredCall.admissible,
      note: alternatives.coveredCall.admissible
        ? 'Covered call clears underwriting on its own merits.'
        : `Covered call rejected: ${alternatives.coveredCall.violations[0]?.message}`,
    });
  }

  // 4. Reduce, 5. Hedge.
  if (alternatives?.reduce) options.push({ action: 'REDUCE', ...alternatives.reduce });
  if (alternatives?.hedge) options.push({ action: 'HEDGE', ...alternatives.hedge });

  const viable = options.filter((o) => o.admissible !== false && isNum(o.nev ?? o.forwardEv));
  viable.sort((a, b) => (b.nev ?? b.forwardEv) - (a.nev ?? a.forwardEv));

  return {
    positionId: position.id,
    shares,
    costBasis,
    currentSpot,
    unrealisedPnl: (currentSpot - costBasis) * shares,
    options,
    recommended: viable[0]?.action ?? 'SELL_SHARES',
    note: 'Yesterday\'s trade is irrelevant to today\'s optimal capital allocation. '
      + 'Cost basis is shown for accounting, not for the decision.',
  };
}

export { POSITION_STATE };
