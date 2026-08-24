import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NuvoEngine } from '../src/engine.js';
import { SyntheticProvider } from '../src/truth/providers/synthetic.js';
import { PaperBroker } from '../src/execution/broker/paper.js';
import { AUTHORITY } from '../src/constitution/authority.js';
import { SWITCH } from '../src/constitution/killswitch.js';
import { OUTCOME } from '../src/pipeline/cycle.js';
import { STRUCTURE } from '../src/structures/structure.js';
import { verifyEvidence } from '../src/evidence/package.js';
import { replay } from '../src/evidence/replay.js';
import { positionGreeks } from '../src/portfolio/governor.js';
import { structureGreeks } from '../src/structures/structure.js';
import { EvidenceStore, EvidencePersistence } from '../src/evidence/store.js';

const NOW = Date.UTC(2024, 5, 3, 15, 0);
const SYMBOLS = ['SPY', 'AAPL', 'XOM'];

/**
 * Integration runs use a reduced sampling budget and a narrower universe.
 * These tests assert on WHICH decision the layers reach and which rules
 * bind, not on the third decimal place of a Monte Carlo estimate — that is
 * what the unit suites are for.
 */
const FAST = { screenSamples: 1500, decisionSamples: 6000, refineTop: 6, dteTargets: [14, 30] };
const STRESSED_INDEX = {
  drawdown: -0.09, liquidityScore: 0.7, crossAssetStress: 0.4, volOfVol: 1.1,
};

function build({
  ivMult = 1.30, authority = AUTHORITY.AUTO_ENTRY, nav = 250_000,
  seed = 'it', evidenceStore = null,
} = {}) {
  const provider = new SyntheticProvider({
    now: NOW, seed, days: 700,
    symbols: {
      SPY: { spot: 450, atmIv: 0.17, sector: 'INDEX', adv: 80e6, oi: 12_000, optVolume: 9000, spreadPct: 0.005, ivMult },
      QQQ: { spot: 380, atmIv: 0.21, sector: 'INDEX', adv: 50e6, oi: 9000, optVolume: 6000, spreadPct: 0.006, ivMult },
      QQQ: { spot: 380, atmIv: 0.21, sector: 'INDEX', adv: 50e6, oi: 9000, optVolume: 6000, spreadPct: 0.006, ivMult },
      AAPL: { spot: 185, atmIv: 0.26, sector: 'TECH', adv: 55e6, oi: 5000, optVolume: 2000, spreadPct: 0.010, ivMult: ivMult * 0.96 },
      XOM: { spot: 108, atmIv: 0.25, sector: 'ENERGY', adv: 18e6, oi: 3000, optVolume: 900, spreadPct: 0.012, ivMult: ivMult * 0.94 },
    },
  });
  const broker = new PaperBroker({ cash: nav, seed: `${seed}-broker`, now: () => NOW });
  const eng = new NuvoEngine({
    provider, broker, nav, symbols: SYMBOLS, approved: SYMBOLS,
    authorityLevel: authority, clock: () => NOW,
    evidenceStore,
  });
  eng.registry.get('VSIM-001')
    .transition('VALIDATED', 'research gates cleared')
    .transition('SHADOW', 'paper observation')
    .transition('LIVE', 'promotion gate met');
  return { eng, provider, broker };
}

describe('the cycle produces a decision, never an exception', () => {
  test('a rich-premium market produces an order', async () => {
    const { eng } = build({ ivMult: 1.30 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.ORDER);
    assert.ok(r.selected);
    assert.ok(r.order.clientOrderId);
    assert.ok(r.sizing.contracts >= 1);
  });

  test('a market with no premium produces NO_TRADE with a reason', async () => {
    const { eng } = build({ ivMult: 1.00 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.NO_TRADE);
    assert.equal(r.decision, STRUCTURE.NO_TRADE);
    assert.ok(r.reason.length > 0, 'NO_TRADE must be explained');
    assert.match(r.note, /negative expectancy/);
  });

  test('more premium never produces a worse decision', async () => {
    const outcomes = [];
    for (const ivMult of [1.00, 1.15, 1.30, 1.45]) {
      const { eng } = build({ ivMult });
      const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
      outcomes.push({ ivMult, outcome: r.outcome, raroc: r.selected?.capital.raroc ?? null });
    }
    assert.equal(outcomes[0].outcome, OUTCOME.NO_TRADE, 'no premium, no trade');
    assert.ok(outcomes.slice(1).some((o) => o.outcome === OUTCOME.ORDER),
      'rich premium must eventually clear the bar');
  });

  test('every stage of the trace is recorded', async () => {
    const { eng } = build({ ivMult: 1.30 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    const names = r.trace.map((t) => t.name);
    for (const stage of ['killSwitches', 'truth', 'chainAudit', 'reconciliation', 'regime', 'universe']) {
      assert.ok(names.includes(stage), `missing trace stage ${stage}`);
    }
  });
});

describe('the machine fails closed (§18)', () => {
  test('a tripped kill switch refuses before any market data is touched', async () => {
    const { eng } = build({ ivMult: 1.45 });
    eng.killSwitches.trip(SWITCH.MANUAL, 'operator halt');
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.REFUSED);
    assert.ok(r.reasons.some((x) => x.includes('MANUAL')));
  });

  test('research-only authority cannot even rank opportunities', async () => {
    const { eng } = build({ ivMult: 1.45, authority: AUTHORITY.RESEARCH_ONLY });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.REFUSED);
    assert.equal(r.governingTier, 'TRUTH');
  });

  test('a broker that cannot report its state refuses the cycle', async () => {
    const { eng, broker } = build({ ivMult: 1.45 });
    broker.accountState = async () => ({ error: 'session expired' });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.REFUSED);
    assert.ok(eng.killSwitches.isTripped(SWITCH.DATA_INTEGRITY));
  });

  test('a durable evidence write failure removes mutation authority', async () => {
    class FailingPersistence extends EvidencePersistence {
      get durable() { return true; }
      async load() { return []; }
      async append() { throw new Error('disk unavailable'); }
    }
    const evidenceStore = new EvidenceStore({ persistence: new FailingPersistence() });
    const { eng } = build({ ivMult: 1.45, evidenceStore });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.REFUSED);
    assert.match(r.reason, /persisted/);
    assert.equal(eng.killSwitches.isTripped(SWITCH.DATA_INTEGRITY), true);
  });

  test('a stale option chain refuses the cycle', async () => {
    const { eng, provider } = build({ ivMult: 1.45 });
    const real = provider.optionChain.bind(provider);
    provider.optionChain = async (...a) => {
      const r = await real(...a);
      return { ...r, asOf: NOW - 3_600_000 };
    };
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.REFUSED);
  });

  test('an unverified event calendar on any scan symbol refuses the cycle', async () => {
    const { eng, provider } = build({ ivMult: 1.45 });
    const real = provider.events.bind(provider);
    provider.events = async (symbol) => symbol === 'XOM'
      ? { error: 'event feed unavailable' }
      : real(symbol);
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.REFUSED);
    assert.equal(r.trace.find((entry) => entry.name === 'truth')?.detail?.symbol, 'XOM');
  });

  test('an unconfident regime call blocks new exposure', async () => {
    const { eng, provider } = build({ ivMult: 1.45 });
    // Withhold the volatility-level inputs entirely, leaving the classifier
    // below its coverage floor. A regime call built on a third of its
    // inputs is a guess, and guesses do not get trading authority.
    provider.marketState = async () => ({
      value: { status: 'OPEN' }, asOf: NOW - 1000, source: 'test',
    });
    const r = await eng.cycle({ indexExtras: {}, ...FAST });
    assert.equal(r.outcome, OUTCOME.NO_TRADE);
    assert.match(r.reason, /inputs/);
  });

  test('a regime call with most inputs present is allowed to proceed', async () => {
    const { eng } = build({ ivMult: 1.45 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.notEqual(r.outcome, OUTCOME.REFUSED);
  });
});

describe('authority gates behaviour, not just labels', () => {
  test('SHADOW authority builds a proposal it may not submit', async () => {
    const { eng } = build({ ivMult: 1.45, authority: AUTHORITY.PROPOSE });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    if (r.outcome === OUTCOME.PROPOSAL) {
      assert.equal(r.requiresApproval, true);
      const s = await eng.submit(r);
      assert.equal(s.ok, false, 'a proposal must not be submittable');
    }
  });

  test('authority is re-checked at submission, not trusted from the cycle', async () => {
    const { eng } = build({ ivMult: 1.45 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.ORDER);
    eng.authorityLevel = AUTHORITY.SHADOW;
    const s = await eng.submit(r);
    assert.equal(s.ok, false);
    assert.match(s.reason, /authority/i);
  });

  test('broker drift between decision and submission quarantines capital', async () => {
    const { eng, broker } = build({ ivMult: 1.45 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.ORDER);
    const original = broker.positions.bind(broker);
    broker.positions = async () => {
      const snapshot = await original();
      return { ...snapshot, value: [...snapshot.value, {
        underlying: 'GME', symbol: 'GME_X', type: 'OPTION', right: 'put',
        strike: 10, expiration: '2024-07-19', quantity: -1, multiplier: 100,
      }] };
    };
    const s = await eng.submit(r);
    assert.equal(s.ok, false);
    assert.match(s.reason, /quarantined/i);
    assert.equal(eng.killSwitches.isTripped(SWITCH.RECONCILIATION), true);
  });

  test('an order altered after evidence was filed is never submitted', async () => {
    const { eng } = build({ ivMult: 1.45 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.ORDER);
    r.order.legs[0].quantity += 10;
    const s = await eng.submit(r);
    assert.equal(s.ok, false);
    assert.match(s.reason, /evidence/i);
    assert.equal(eng.killSwitches.isTripped(SWITCH.DATA_INTEGRITY), true);
  });

  test('demotion beats promotion when a breach is on the record', () => {
    const { eng } = build();
    eng.authorityLevel = AUTHORITY.AUTO_LIFECYCLE;
    eng.breaches.push({ code: 'TEST', message: 'x' });
    const r = eng.reviewAuthority();
    assert.equal(r.direction, 'DEMOTION');
    assert.ok(eng.authorityLevel < AUTHORITY.AUTO_LIFECYCLE);
  });

  test('paper and shadow observations cannot earn live authority', () => {
    const { eng } = build({ authority: AUTHORITY.SHADOW });
    for (let i = 0; i < 80; i += 1) eng.recordOutcome({
      position: {
        id: `shadow-${i}`, pTerminalBelowStrike: 0.2,
        strategyId: 'VSIM-001', evidenceMode: 'SHADOW',
      },
      realizedPnl: 10, finishedBelowStrike: false,
    });
    assert.equal(eng.authorityEvidence().liveObservations, 0);
    const review = eng.reviewAuthority();
    assert.equal(review.changed, false);
    assert.equal(eng.authorityLevel, AUTHORITY.SHADOW);
  });
});

describe('the book stays reconciled across fills', () => {
  test('a working order reserves capital and remains reconciled', async () => {
    const { eng, broker } = build({ ivMult: 1.35 });
    broker.fillProbability = 0;
    const first = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    const submitted = await eng.submit(first);
    assert.equal(submitted.filled, false);
    assert.ok(eng.ledger.snapshot().COMMITTED > 0);
    const second = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.notEqual(second.outcome, OUTCOME.REFUSED);
    assert.equal(eng.killSwitches.isTripped(SWITCH.RECONCILIATION), false);
  });

  test('a filled position does not quarantine the next cycle', async () => {
    const { eng } = build({ ivMult: 1.35 });
    const first = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(first.outcome, OUTCOME.ORDER);
    const s = await eng.submit(first);
    assert.equal(s.filled, true);

    const second = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.notEqual(second.outcome, OUTCOME.REFUSED,
      'the engine must recognise its own filled position at the broker');
    assert.equal(eng.killSwitches.isTripped(SWITCH.RECONCILIATION), false);
  });

  test('the leg mirror matches the broker exactly after a fill', async () => {
    const { eng, broker } = build({ ivMult: 1.35 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    await eng.submit(r);
    const mine = eng.brokerView();
    const theirs = (await broker.positions()).value;
    assert.equal(mine.length, theirs.length);
    for (const t of theirs) {
      const m = mine.find((x) => x.symbol === t.symbol);
      assert.ok(m, `engine is missing broker position ${t.symbol}`);
      assert.equal(m.quantity, t.quantity);
      assert.equal(m.strike, t.strike);
      assert.equal(m.right, t.right);
    }
  });

  test('a filled spread retains every leg and the sized portfolio Greeks', async () => {
    const { eng } = build({ ivMult: 1.35 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    const s = await eng.submit(r);
    assert.equal(s.filled, true);
    const open = eng.positions[0];
    assert.equal(open.legs.length, r.selected.structure.legs.length);
    const expected = structureGreeks(r.selected.structure, { contracts: r.sizing.contracts });
    const actual = positionGreeks(open);
    assert.ok(Math.abs(actual.delta - expected.delta) < 1e-9);
    assert.ok(Math.abs(actual.gamma - expected.gamma) < 1e-9);
  });

  test('closing a position unwinds the leg mirror', async () => {
    const { eng } = build({ ivMult: 1.35 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    await eng.submit(r);
    assert.ok(eng.brokerView().length > 0);
    eng.recordOutcome({ position: eng.positions[0], realizedPnl: 50, finishedBelowStrike: false });
    assert.equal(eng.brokerView().length, 0,
      'a stale leg would read as a phantom position on the next cycle');
  });

  test('an unexpected broker position still quarantines', async () => {
    const { eng, broker } = build({ ivMult: 1.35 });
    const real = broker.positions.bind(broker);
    broker.positions = async () => {
      const r = await real();
      return {
        ...r,
        value: [...r.value, {
          underlying: 'GME', symbol: 'GME_X', type: 'OPTION', right: 'put',
          strike: 10, expiration: '2024-07-19', quantity: -5, multiplier: 100,
        }],
      };
    };
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(r.outcome, OUTCOME.REFUSED);
    assert.equal(eng.killSwitches.isTripped(SWITCH.RECONCILIATION), true);
    assert.ok(eng.ledger.snapshot().QUARANTINED > 0);
  });
});

describe('portfolio limits bind end to end', () => {
  test('correlated positions eventually exhaust the cluster budget', async () => {
    const { eng } = build({ ivMult: 1.45 });
    let ordered = 0;
    for (let i = 0; i < 12; i += 1) {
      const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
      if (r.outcome !== OUTCOME.ORDER) break;
      const s = await eng.submit(r);
      if (!s.filled) break;
      ordered += 1;
    }
    // Either it filled the book and then stopped, or a limit bound earlier.
    assert.ok(ordered < 12, 'the governor must eventually refuse more exposure');
    assert.ok(eng.ledger.snapshot().consistent);
    assert.ok(eng.ledger.snapshot().reservePct >= 0.199, 'the reserve is never spent');
  });
});

describe('evidence is complete and tamper-evident (§19)', () => {
  test('a duplicate cycle identity is refused without extending the chain', async () => {
    const { eng } = build({ ivMult: 1.30 });
    await eng.cycle({ cycleId: 'SAME', indexExtras: STRESSED_INDEX, ...FAST });
    const duplicate = await eng.cycle({ cycleId: 'SAME', indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(duplicate.outcome, OUTCOME.REFUSED);
    assert.equal(duplicate.duplicateCycle, true);
    assert.equal(eng.evidence.length, 1);
  });

  test('every cycle files evidence, including refusals', async () => {
    const { eng } = build({ ivMult: 1.00 });
    await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    eng.killSwitches.trip(SWITCH.MANUAL, 'halt');
    await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(eng.evidence.length, 2, 'a refusal is evidence too');
    assert.equal(eng.evidence.verify().valid, true);
  });

  test('the package records rejected candidates, not just the winner', async () => {
    const { eng } = build({ ivMult: 1.30 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.ok(r.evidence.candidates.length > 10, 'the whole field must be recorded');
    assert.ok(r.evidence.rejectedCount > 0);
    const rejected = r.evidence.candidates.find((c) => !c.admissible);
    assert.ok(rejected.violations.length > 0, 'each rejection carries its reason');
  });

  test('the package is reconstructable: inputs, reasoning and decision', async () => {
    const { eng } = build({ ivMult: 1.30 });
    const r = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    const e = r.evidence;
    assert.ok(e.market.regime);
    assert.ok(e.market.regimeComponents.length > 0, 'the regime call must show its inputs');
    assert.ok(e.universe.tierA.length > 0);
    assert.ok(e.modelVersion && e.codeVersion && e.limitsVersion);
    assert.ok(e.truth.factsAsOf, 'every fact must carry its observation time');
    assert.equal(verifyEvidence(e), true);
  });

  test('altering a filed record breaks the chain', async () => {
    const { eng } = build({ ivMult: 1.30 });
    await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(eng.evidence.verify().valid, true);
    eng.evidence.records[0].decision = 'ALTERED';
    assert.equal(eng.evidence.verify().valid, false);
  });
});

describe('scoreboards enforce the hierarchy (§21, §27)', () => {
  test('a breach fails the scoreboard regardless of profit', async () => {
    const { eng } = build();
    eng.recordOutcome({ position: { id: 'p1', buyingPower: 1000, economicCapital: 500 }, realizedPnl: 50_000, finishedBelowStrike: false });
    eng.breaches.push({ code: 'UNAUTHORISED', message: 'traded above authority' });
    const sb = eng.scoreboard();
    assert.ok(sb.economic.realizedPnl > 0, 'the trade made money');
    assert.equal(sb.constitutional.passed, false);
    assert.equal(sb.overallPassed, false, 'a profitable unauthorised trade is still a failure');
  });

  test('calibration is UNCALIBRATED until live evidence accumulates', () => {
    const { eng } = build();
    assert.equal(eng.scoreboard().calibration.status, 'UNCALIBRATED');
    assert.equal(eng.scoreboard().calibration.sufficient, false);
  });

  test('a drawdown past the halt trips the kill switch automatically', () => {
    const { eng } = build({ nav: 100_000 });
    eng.recordOutcome({ position: { id: 'p1', buyingPower: 0, economicCapital: 0 }, realizedPnl: -20_000, finishedBelowStrike: true });
    assert.ok(eng.killSwitches.isTripped(SWITCH.DRAWDOWN));
    assert.equal(eng.scoreboard().survival.withinDrawdownLimit, false);
  });

  test('outcomes feed calibration so probabilities can be scored later', () => {
    const { eng } = build();
    eng.recordOutcome({
      position: {
        id: 'p1', buyingPower: 1000, economicCapital: 500,
        pTerminalBelowStrike: 0.2, strategyId: 'VSIM-001',
      },
      realizedPnl: 100, finishedBelowStrike: false,
    });
    assert.equal(eng.calibration.n, 1);
    const o = eng.calibration.observations[0];
    assert.equal(o.outcome, false);
    assert.ok(Math.abs(o.p - 0.2) < 1e-9, 'the scored forecast is P(finish below the strike)');
    assert.match(o.tag, /\|terminal$/, 'the event must be named in the tag');
  });

  test('terminal and touch forecasts are scored as separate events', () => {
    const { eng } = build();
    // Finished ABOVE the strike, but traded through it mid-life. The
    // terminal call was right and the touch call was wrong; conflating
    // them scores a correct forecast as a miss.
    eng.recordOutcome({
      position: {
        id: 'p1', buyingPower: 1000, economicCapital: 500,
        pTerminalBelowStrike: 0.18, pTouchStrike: 0.34, strategyId: 'VSIM-001',
      },
      realizedPnl: 120, finishedBelowStrike: false, touchedStrike: true,
    });
    assert.equal(eng.calibration.n, 2);
    const terminal = eng.calibration.observations.find((o) => o.tag.endsWith('|terminal'));
    const touch = eng.calibration.observations.find((o) => o.tag.endsWith('|touch'));
    assert.equal(terminal.outcome, false, 'the terminal-below event did not occur');
    assert.equal(touch.outcome, true, 'the touch event did occur');
    assert.notEqual(terminal.p, touch.p, 'the two events have different probabilities');
  });

  test('an ambiguous outcome is refused rather than guessed', () => {
    const { eng } = build();
    assert.throws(
      () => eng.recordOutcome({ position: { id: 'p1' }, realizedPnl: 1, breached: true }),
      /conflates terminal and touch/,
    );
  });

  test('the touch board is not fabricated from the terminal outcome', () => {
    const { eng } = build();
    eng.recordOutcome({
      position: { id: 'p1', pTerminalBelowStrike: 0.2, pTouchStrike: 0.4, strategyId: 'VSIM-001' },
      realizedPnl: 10, finishedBelowStrike: false, // touch NOT observed
    });
    assert.equal(eng.calibration.n, 1, 'an unobserved path must not be invented');
  });

  test('the calibration scoreboard reads the terminal board only', () => {
    const { eng } = build();
    for (let i = 0; i < 4; i += 1) {
      eng.recordOutcome({
        position: { id: `p${i}`, pTerminalBelowStrike: 0.2, pTouchStrike: 0.4, strategyId: 'VSIM-001' },
        realizedPnl: 1, finishedBelowStrike: false, touchedStrike: true,
      });
    }
    assert.equal(eng.calibration.n, 8, 'both boards recorded');
    assert.equal(eng.scoreboard().calibration.n, 4, 'only the terminal board is scored');
  });
});

describe('determinism', () => {
  test('the same seed and inputs produce the identical decision and hash', async () => {
    const a = build({ ivMult: 1.30, seed: 'det' });
    const b = build({ ivMult: 1.30, seed: 'det' });
    const ra = await a.eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    const rb = await b.eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    assert.equal(ra.outcome, rb.outcome);
    assert.equal(ra.evidence.hash, rb.evidence.hash,
      'an evidence package that cannot be reproduced is not evidence');
  });

  test('a non-empty calibrated book replays from captured state exactly', async () => {
    const { eng, broker } = build({ ivMult: 1.35, seed: 'it' });
    broker.fillProbability = 1;
    const first = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    const fill = await eng.submit(first);
    assert.equal(fill.filled, true, JSON.stringify(fill));
    for (let i = 0; i < 30; i += 1) eng.calibration.record({
      p: [0.1, 0.5, 0.9][i % 3], outcome: i % 2 === 0,
      tag: 'VSIM-001|terminal', at: NOW - i,
    });
    const second = await eng.cycle({ indexExtras: STRESSED_INDEX, ...FAST });
    const rr = await replay(second.evidence);
    assert.equal(rr.reproduced, true, rr.differences?.join('\n'));
  });
});
