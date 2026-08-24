#!/usr/bin/env node
/**
 * NUVO VSIM command line.
 *
 *   nuvo cycle       run one decision cycle and render the dashboard
 *   nuvo simulate    run N cycles against the synthetic market
 *   nuvo research    run the research gates for a hypothesis
 *   nuvo registry    show the strategy registry
 *   nuvo evidence    verify the evidence chain and show a record
 *   nuvo constitution print the operative limits and authority ladder
 */
import { NuvoEngine } from '../src/engine.js';
import { SyntheticProvider } from '../src/truth/providers/synthetic.js';
import { PaperBroker } from '../src/execution/broker/paper.js';
import { AUTHORITY, AUTHORITY_NAME, PROMOTION_GATES } from '../src/constitution/authority.js';
import { DEFAULT_LIMITS, LIMIT_BASIS } from '../src/constitution/limits.js';
import { buildView, render } from '../src/dashboard/view.js';
import { StrategyRegistry } from '../src/registry/strategy_registry.js';
import { registerCatalogue } from '../src/registry/strategies/vsim_strategies.js';
import { Hypothesis, GATE_ORDER } from '../src/research/hypothesis.js';
import { bootstrapTrades } from '../src/research/backtest.js';
import { OUTCOME } from '../src/pipeline/cycle.js';
import { Rng } from '../src/math/random.js';
import { MANDATE, VERSION } from '../src/index.js';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const DEMO_SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'XOM', 'JNJ'];

function demoEngine({ ivMult = 1.30, nav = 250_000, authority = AUTHORITY.AUTO_ENTRY, now = Date.UTC(2024, 5, 3, 15, 0), seed = 'cli' } = {}) {
  const provider = new SyntheticProvider({
    now, seed, days: 700,
    symbols: {
      SPY: { spot: 450, atmIv: 0.17, sector: 'INDEX', adv: 80e6, oi: 12_000, optVolume: 9000, spreadPct: 0.005, ivMult },
      QQQ: { spot: 380, atmIv: 0.21, sector: 'INDEX', adv: 50e6, oi: 9000, optVolume: 6000, spreadPct: 0.006, ivMult },
      AAPL: { spot: 185, atmIv: 0.26, sector: 'TECH', adv: 55e6, oi: 5000, optVolume: 2000, spreadPct: 0.010, ivMult: ivMult * 0.96 },
      XOM: { spot: 108, atmIv: 0.25, sector: 'ENERGY', adv: 18e6, oi: 3000, optVolume: 900, spreadPct: 0.012, ivMult: ivMult * 0.94 },
      JNJ: { spot: 155, atmIv: 0.16, sector: 'HEALTH', adv: 9e6, oi: 2000, optVolume: 600, spreadPct: 0.012, ivMult: ivMult * 0.92 },
    },
  });
  const broker = new PaperBroker({ cash: nav, seed: `${seed}-broker`, now: () => now });
  const engine = new NuvoEngine({
    provider, broker, nav, symbols: DEMO_SYMBOLS, approved: DEMO_SYMBOLS,
    authorityLevel: authority, clock: () => now,
  });
  engine.registry.get('VSIM-001')
    .transition('VALIDATED', 'research gates cleared')
    .transition('SHADOW', 'paper observation')
    .transition('LIVE', 'promotion gate met');
  return { engine, provider, broker };
}

const INDEX_EXTRAS = { drawdown: -0.09, liquidityScore: 0.7, crossAssetStress: 0.4, volOfVol: 1.1 };

async function cmdCycle() {
  const ivMult = Number(flag('vrp', '1.30'));
  const { engine } = demoEngine({ ivMult });
  const r = await engine.cycle({ indexExtras: INDEX_EXTRAS });
  if (r.outcome === OUTCOME.ORDER) await engine.submit(r);
  console.log(render(buildView({ engine, cycle: r })));
  if (r.outcome === OUTCOME.NO_TRADE) {
    console.log(`\n  NO TRADE: ${r.reason}`);
    console.log(`  ${r.note}`);
  }
  if (r.outcome === OUTCOME.REFUSED) {
    console.log('\n  REFUSED (fail closed):');
    for (const x of r.reasons) console.log(`    ${x}`);
  }
  if (r.comparison) {
    console.log('\n  STRUCTURE COMPARISON (the §10 decision, recorded):');
    for (const c of r.comparison) {
      console.log(`    ${c.kind.padEnd(18)}RAROC ${c.raroc !== null ? `${(c.raroc * 100).toFixed(1)}%` : 'n/a'}`
        + `  NEV ${c.nev.toFixed(0).padStart(7)}  BP ${c.buyingPower.toFixed(0).padStart(7)}`
        + `  ${c.admissible ? 'ADMISSIBLE' : `blocked: ${c.blockedBy}`}`);
    }
  }
}

async function cmdSimulate() {
  const n = Number(flag('cycles', '10'));
  const ivMult = Number(flag('vrp', '1.30'));
  const { engine, provider, broker } = demoEngine({ ivMult });
  const DAY = 86_400_000;
  let clock = Date.UTC(2024, 5, 3, 15, 0);
  engine.clock = () => clock;
  broker.now = () => clock;

  console.log(`Simulating ${n} cycles against the synthetic market (VRP multiplier ${ivMult}).\n`);
  console.log('  CYCLE  REGIME       OUTCOME    DETAIL');
  for (let i = 0; i < n; i += 1) {
    provider.setNow(clock);
    const r = await engine.cycle({ indexExtras: INDEX_EXTRAS });
    let detail = '';
    if (r.outcome === OUTCOME.ORDER) {
      const s = await engine.submit(r);
      detail = `${r.selected.structure.kind} ${r.selected.underlying} `
        + `${r.selected.structure.shortStrike}${r.selected.structure.longStrike ? `/${r.selected.structure.longStrike}` : ''} `
        + `x${r.sizing.contracts} RAROC ${(r.selected.capital.raroc * 100).toFixed(0)}%`
        + (s.filled ? ` filled (edge kept ${(s.fillQuality.edgeRetained * 100).toFixed(0)}%)` : ' unfilled');
    } else {
      detail = String(r.reason ?? r.reasons?.[0] ?? '').slice(0, 72);
    }
    console.log(`  ${String(i + 1).padStart(5)}  ${String(r.regime ?? '—').padEnd(12)} ${r.outcome.padEnd(10)} ${detail}`);
    clock += 3 * DAY;
  }
  console.log(`\n${render(buildView({ engine }))}`);
}

function cmdRegistry() {
  const r = registerCatalogue(new StrategyRegistry());
  console.log('STRATEGY REGISTRY (§23)\n');
  console.log('NUVO itself never changes identity. Strategies compete for capital.\n');
  for (const s of r.all) {
    console.log(`  ${s.id}  ${s.name}`);
    console.log(`    state    ${s.state}${s.lineage?.length ? `  (successor to ${s.lineage.join(' -> ')})` : ''}`);
    console.log(`    claim    ${wrapText(s.hypothesis, 68, 13)}`);
    console.log(`    kills at ${describeKills(s.killCriteria)}`);
    if (s.state === 'REJECTED') console.log(`    reason   ${wrapText(s.history.at(-1).reason, 68, 13)}`);
    console.log('');
  }
}

const describeKills = (k) => Object.entries(k)
  .filter(([key]) => key !== 'minObservations')
  .map(([key, v]) => `${key}=${v}`).join(', ') + ` (after ${k.minObservations ?? 30} observations)`;

function cmdResearch() {
  console.log('RESEARCH LAB (§2) — a hypothesis must clear every gate, in order.\n');
  const h = new Hypothesis({
    id: 'H1', strategyId: 'VSIM-001',
    statement: 'Liquid index and high-quality single-name downside options become '
      + 'periodically overpriced relative to conditional realised downside risk during '
      + 'elevated fear regimes.',
    preRegistered: { minExpectancy: 5, minProfitFactor: 1.15, maxDrawdownPct: 0.15, minTrades: 40 },
  });
  console.log(`  ${h.id}: ${wrapText(h.statement, 70, 6)}\n`);
  console.log(`  pre-registered: ${JSON.stringify(h.preRegistered)}\n`);

  const rng = new Rng('research');
  for (const gate of GATE_ORDER) {
    // Out-of-sample gates are deliberately harder than training.
    const oos = ['holdout', 'walkForward', 'shadow'].includes(gate);
    const result = {
      expectancy: oos ? rng.uniform(2, 14) : rng.uniform(12, 25),
      profitFactor: oos ? rng.uniform(1.02, 1.45) : rng.uniform(1.3, 1.8),
      maxDrawdownPct: rng.uniform(0.05, 0.17),
      trades: Math.round(rng.uniform(45, 140)),
    };
    const r = h.recordGate(gate, result);
    console.log(`  ${gate.padEnd(16)} ${r.passed ? 'PASS' : 'FAIL'}  `
      + `expectancy ${result.expectancy.toFixed(1)}  PF ${result.profitFactor.toFixed(2)}  `
      + `maxDD ${(result.maxDrawdownPct * 100).toFixed(1)}%  n=${result.trades}`);
  }
  console.log(`\n  promotable: ${h.promotable}`);
  if (!h.promotable) {
    console.log(`  failed at: ${h.failedGates.join(', ')}`);
    console.log('  A hypothesis that fails a gate is not retried with adjusted thresholds.');
    console.log('  It becomes a new hypothesis with a new id (§24).');
  }

  console.log('\n  BOOTSTRAP — what an 85% win rate actually looks like:');
  const r2 = new Rng('trap');
  const trades = Array.from({ length: 200 }, () => ({
    realizedPnl: r2.next() < 0.85 ? r2.uniform(40, 120) : -r2.uniform(200, 900),
    capitalEmployed: 9000,
  }));
  const b = bootstrapTrades({ trades, startingCapital: 100_000, seed: 'demo' });
  console.log(`    win rate 85%, but ${(b.probabilityOfLoss * 100).toFixed(0)}% of resampled paths end below starting capital.`);
  console.log(`    median max drawdown ${(b.medianMaxDrawdown * 100).toFixed(1)}%, 95th percentile ${(b.p95MaxDrawdown * 100).toFixed(1)}%.`);
  console.log('    "80% POP means it is safe" is the doctrine §26 removes.');
}

function cmdConstitution() {
  console.log('THE CONSTITUTION\n');
  console.log('  TRUTH > SURVIVAL > EXPECTANCY > CAPITAL EFFICIENCY > INCOME\n');
  console.log(`  ${MANDATE}\n`);
  console.log('AUTHORITY LADDER (§17)\n');
  for (const [lvl, gate] of Object.entries(PROMOTION_GATES)) {
    console.log(`  ${lvl} ${AUTHORITY_NAME[lvl].padEnd(16)} ${gate.note}`);
    const reqs = Object.entries(gate).filter(([k]) => k !== 'note')
      .map(([k, v]) => `${k}=${v}`).join('  ');
    if (reqs) console.log(`      requires ${reqs}`);
  }
  console.log('\nHARD LIMITS\n');
  for (const [k, v] of Object.entries(DEFAULT_LIMITS)) {
    if (typeof v !== 'number') continue;
    const basis = LIMIT_BASIS[k];
    console.log(`  ${k.padEnd(28)} ${String(v).padStart(12)}${basis ? `\n      ${basis}` : ''}`);
  }
}

async function cmdEvidence() {
  const { engine } = demoEngine({ ivMult: 1.30 });
  const r = await engine.cycle({ indexExtras: INDEX_EXTRAS });
  const e = r.evidence;
  console.log('EVIDENCE PACKAGE (§19)\n');
  console.log(`  cycle       ${e.cycleId}`);
  console.log(`  hash        ${e.hash}`);
  console.log(`  decision    ${e.decision}`);
  console.log(`  model       ${e.modelVersion}   code ${e.codeVersion}   limits ${e.limitsVersion}`);
  console.log(`  regime      ${e.market.regime} (score ${e.market.regimeScore?.toFixed(2)}, confident ${e.market.regimeConfident})`);
  console.log('\n  REGIME INPUTS (every component that produced the call):');
  for (const c of e.market.regimeComponents ?? []) {
    console.log(`    ${String(c.name).padEnd(20)} ${String(c.value).padEnd(10)} score ${c.score}  ${c.note ?? ''}`);
  }
  console.log('\n  UNIVERSE:');
  console.log(`    tier A      ${e.universe.tierA.join(', ') || 'none'}`);
  console.log(`    prohibited  ${e.universe.prohibited.map((p) => `${p.symbol} (${p.reasons[0] ?? p.note})`).join('; ') || 'none'}`);
  console.log(`\n  CANDIDATES: ${e.candidates.length} scored, ${e.rejectedCount} rejected.`);
  const sample = e.candidates.filter((c) => !c.admissible).slice(0, 3);
  for (const c of sample) {
    console.log(`    rejected ${c.underlying} ${c.kind} ${c.shortStrike ?? ''} — ${c.violations[0]}`);
  }
  if (e.selected) {
    console.log(`\n  SELECTED: ${e.selected.underlying} ${e.selected.kind} ${e.selected.shortStrike}`
      + `${e.selected.longStrike ? `/${e.selected.longStrike}` : ''} @ ${e.selected.dte} DTE`);
    console.log(`    NEV ${e.selected.nev?.toFixed(2)}  RAROC ${(e.selected.raroc * 100).toFixed(1)}%  CVaR ${e.selected.cvar?.toFixed(0)}`);
    console.log(`    pMarket ${e.selected.probabilities?.pMarket?.toFixed(4)}  pModel ${e.selected.probabilities?.pModel?.toFixed(4)}  [${e.selected.probabilities?.calibration}]`);
  }
  console.log(`\n  chain: ${JSON.stringify(engine.evidence.verify())}`);
  console.log('  Every decision is reconstructable years later, or it is not evidence.');
}

function wrapText(text, w, indent) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    if ((cur + word).length > w) { lines.push(cur.trim()); cur = ''; }
    cur += `${word} `;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.join(`\n${' '.repeat(indent)}`);
}

function help() {
  console.log(`NUVO VSIM ${VERSION}

  ${MANDATE}

  nuvo cycle          run one decision cycle and render the dashboard
      --vrp <n>       IV/RV multiplier for the synthetic market (default 1.30)
  nuvo simulate       run repeated cycles against the synthetic market
      --cycles <n>    number of cycles (default 10)
      --vrp <n>       IV/RV multiplier (default 1.30)
  nuvo research       demonstrate the research gates and the bootstrap
  nuvo registry       show the strategy registry
  nuvo evidence       build and inspect an evidence package
  nuvo constitution   print the operative limits and the authority ladder
`);
}

const COMMANDS = {
  cycle: cmdCycle, simulate: cmdSimulate, registry: cmdRegistry,
  research: cmdResearch, constitution: cmdConstitution, evidence: cmdEvidence,
  help,
};

const run = COMMANDS[cmd] ?? help;
await run();
