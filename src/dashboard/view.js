/**
 * The dashboard (§20).
 *
 * "The dashboard should not be the product. NUVO is the engine."
 *
 * Five panels, everything else drill-down. Opportunities are ranked by
 * RAROC, not premium — the ordering the operator sees is the ordering the
 * engine actually used, so the screen cannot imply a decision rule the
 * system does not follow.
 */
import { AUTHORITY_NAME } from '../constitution/authority.js';
import { isNum } from '../math/stats.js';

const pct = (v, d = 1) => (isNum(v) ? `${(v * 100).toFixed(d)}%` : '—');
const money = (v) => (isNum(v) ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—');
const num = (v, d = 2) => (isNum(v) ? v.toFixed(d) : '—');

/** Build the five-panel view model from an engine and its latest cycle. */
export function buildView({ engine, cycle = null }) {
  const led = engine.ledger.snapshot();
  const sb = engine.scoreboard();
  const regime = cycle?.marketState?.regime ?? null;
  const index = cycle?.marketState?.index ?? null;

  return {
    capital: {
      nav: led.nav,
      available: led.AVAILABLE,
      reserved: led.RESERVE,
      atRisk: led.AT_RISK,
      committed: led.COMMITTED,
      assigned: led.ASSIGNED,
      quarantined: led.QUARANTINED,
      deployedPct: led.deployedPct,
      consistent: led.consistent,
    },
    environment: {
      regime: regime?.regime ?? 'UNKNOWN',
      regimeConfident: regime?.confident ?? false,
      regimeScore: regime?.score ?? null,
      vix: index?.vix ?? null,
      vrp: cycle ? summariseVrp(cycle.marketState) : null,
      breadthCorrelation: cycle?.marketState?.breadthCorrelation ?? null,
      marketStatus: cycle?.marketState?.marketStatus ?? 'UNKNOWN',
    },
    // The ranking is annotated with what the Governor did with each entry.
    // A screen that shows a RAROC ordering without saying which one was
    // taken invites the operator to assume the top row was — and when the
    // Governor declined it for size, that assumption is wrong in a way the
    // screen caused.
    opportunities: annotate(cycle).slice(0, 10).map((c) => ({
      underlying: c.underlying,
      structure: c.structure.kind,
      strikes: c.structure.longStrike
        ? `${c.structure.shortStrike}/${c.structure.longStrike}`
        : String(c.structure.shortStrike ?? '—'),
      dte: c.dte,
      raroc: c.capital.raroc,
      nev: c.evaluation.nev,
      cvar: c.evaluation.cvar,
      economicCapital: c.capital.economicCapital,
      buyingPower: c.structure.buyingPower,
      pMarket: c.probabilities?.pMarket ?? null,
      pModel: c.probabilities?.pModel ?? null,
      calibration: c.probabilities?.calibration ?? null,
      status: c.governorStatus,
      statusReason: c.governorReason,
    })),
    decision: cycle?.outcome ?? null,
    decisionReason: cycle?.reason ?? null,
    positions: engine.positions.map((p) => ({
      id: p.id,
      underlying: p.underlying,
      strategy: p.strategy,
      strikes: p.longStrike ? `${p.shortStrike}/${p.longStrike}` : String(p.shortStrike ?? '—'),
      expiration: p.expiration,
      contracts: p.contracts,
      entryCredit: p.entryCredit,
      currentEv: p.expectedValue,
      remainingRisk: p.cvar,
      thesis: p.thesis,
      thesisState: p.state,
    })),
    system: {
      authority: `${engine.authorityLevel} (${AUTHORITY_NAME[engine.authorityLevel]})`,
      dataHealth: cycle ? (cycle.outcome === 'REFUSED' ? 'REFUSED' : 'VERIFIED') : 'UNKNOWN',
      brokerHealth: led.QUARANTINED > 0 ? 'QUARANTINED' : 'OK',
      modelCalibration: sb.calibration.status,
      calibrationN: sb.calibration.n,
      killSwitches: engine.killSwitches.tripped.map((k) => k.name),
      cycles: engine.cycles,
      evidenceRecords: engine.evidence.length,
      evidenceChainValid: engine.evidence.verify().valid,
    },
    scoreboard: sb,
  };
}

/** Merge the Governor's verdict into the ranked list. */
function annotate(cycle) {
  const ranked = cycle?.ranked ?? [];
  const attempts = cycle?.governanceAttempts ?? [];
  const takenKey = cycle?.selected
    ? `${cycle.selected.underlying}|${cycle.selected.structure.shortStrike}|${cycle.selected.structure.longStrike ?? ''}`
    : null;
  return ranked.map((c) => {
    const key = `${c.underlying}|${c.structure.shortStrike}|${c.structure.longStrike ?? ''}`;
    if (takenKey && key === takenKey) {
      return { ...c, governorStatus: 'TAKEN', governorReason: null };
    }
    const a = attempts.find((x) => x.underlying === c.underlying
      && x.shortStrike === c.structure.shortStrike && !x.approved);
    if (a) return { ...c, governorStatus: 'DECLINED', governorReason: shortReason(a.reasons[0]) };
    return { ...c, governorStatus: 'NOT REACHED', governorReason: null };
  });
}

const shortReason = (r) => String(r ?? '').replace(/^\[[^\]]+\]\s*/, '');

function summariseVrp(marketState) {
  const us = Object.values(marketState?.underlyings ?? {});
  const ratios = us.map((u) => u.vrp?.ratio).filter(isNum);
  if (!ratios.length) return null;
  return {
    meanRatio: ratios.reduce((a, b) => a + b, 0) / ratios.length,
    attractive: us.filter((u) => u.vrp?.assessment?.attractive).length,
    total: us.length,
  };
}

/** Render the view as text. The terminal is the reference implementation. */
export function render(view, { width = 78 } = {}) {
  const L = [];
  const rule = (ch = '─') => L.push(ch.repeat(width));
  const head = (t) => { rule(); L.push(t); rule(); };

  L.push('NUVO VSIM'.padEnd(width - 20) + `authority ${view.system.authority}`);
  L.push('Compound capital by selling mispriced risk only when compensation exceeds');
  L.push('modelled risk after costs.');

  head('CAPITAL');
  const c = view.capital;
  L.push(`  NAV ${money(c.nav)}   available ${money(c.available)}   reserved ${money(c.reserved)}`);
  L.push(`  at risk ${money(c.atRisk)}   assigned ${money(c.assigned)}   quarantined ${money(c.quarantined)}`);
  L.push(`  deployed ${pct(c.deployedPct)}${c.consistent ? '' : '   *** LEDGER INCONSISTENT ***'}`);

  head('ENVIRONMENT');
  const e = view.environment;
  L.push(`  regime ${e.regime}${e.regimeConfident ? '' : ' (LOW CONFIDENCE)'}   score ${num(e.regimeScore)}   VIX ${num(e.vix, 1)}`);
  if (e.vrp) L.push(`  VRP ratio ${num(e.vrp.meanRatio)}   attractive ${e.vrp.attractive}/${e.vrp.total} underlyings`);
  L.push(`  breadth correlation ${num(e.breadthCorrelation)}   market ${e.marketStatus}`);

  head('OPPORTUNITIES  (ranked by RAROC, not premium)');
  if (!view.opportunities.length) {
    L.push(`  none — decision: ${view.decision ?? 'n/a'}`);
    if (view.decisionReason) L.push(`  ${wrap(view.decisionReason, width - 4)}`);
  } else {
    L.push('  UNDERLYING  STRUCTURE         STRIKES     DTE   RAROC  ECON CAP  GOVERNOR');
    for (const o of view.opportunities) {
      L.push('  '
        + o.underlying.padEnd(12)
        + o.structure.padEnd(17)
        + o.strikes.padEnd(12)
        + String(o.dte ?? '—').padEnd(5)
        + pct(o.raroc).padStart(7)
        + money(o.economicCapital).padStart(10)
        + '  ' + (o.status === 'TAKEN' ? 'TAKEN' : o.status === 'DECLINED' ? 'declined' : '·'));
    }
    const declined = view.opportunities.filter((o) => o.status === 'DECLINED');
    if (declined.length) {
      L.push(`  ${declined.length} higher-ranked candidate(s) declined by the Governor:`);
      L.push(`    ${declined[0].statusReason}`);
    }
  }

  head('POSITIONS');
  if (!view.positions.length) L.push('  none open');
  for (const p of view.positions) {
    L.push(`  ${p.underlying.padEnd(8)}${p.strategy.padEnd(18)}${p.strikes.padEnd(12)}${p.expiration ?? ''}  x${p.contracts}`);
    L.push(`    EV ${money(p.currentEv)}   remaining risk ${money(p.remainingRisk)}   ${p.thesisState}`);
  }

  head('SYSTEM');
  const s = view.system;
  L.push(`  data ${s.dataHealth}   broker ${s.brokerHealth}   calibration ${s.modelCalibration} (n=${s.calibrationN})`);
  L.push(`  cycles ${s.cycles}   evidence ${s.evidenceRecords} records, chain ${s.evidenceChainValid ? 'VALID' : 'BROKEN'}`);
  if (s.killSwitches.length) L.push(`  *** KILL SWITCHES ACTIVE: ${s.killSwitches.join(', ')} ***`);

  head('SCOREBOARDS');
  const sb = view.scoreboard;
  L.push(`  economic      ${sb.economic.sufficient ? `expectancy ${money(sb.economic.expectancy)}  PF ${num(sb.economic.profitFactor)}  win ${pct(sb.economic.winRate)}` : `n=${sb.economic.n ?? 0}, insufficient`}`);
  L.push(`  calibration   ${sb.calibration.status}  brier ${num(sb.calibration.brierScore, 3)}  slope ${num(sb.calibration.calibrationSlope)}`);
  L.push(`  execution     ${sb.execution.sufficient ? `edge retained ${pct(sb.execution.edgeRetained)}  slippage ${pct(sb.execution.meanSlippagePct)}` : `n=${sb.execution.n}, insufficient`}`);
  L.push(`  constitution  ${sb.constitutional.passed ? 'CLEAN' : `${sb.constitutional.breaches} BREACHES`}`);
  L.push(`  survival      max DD ${pct(sb.survival.maxDrawdownPct)}  cluster ${pct(sb.survival.maxClusterPct)}  ${sb.survival.passed ? 'within limits' : 'LIMIT EXCEEDED'}`);
  rule('═');
  L.push(sb.overallPassed ? '  STATUS: operating within the constitution.' : `  STATUS: ${sb.blockingIssues.join(' ')}`);
  rule('═');

  return L.join('\n');
}

function wrap(text, w) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    if ((cur + word).length > w) { lines.push(cur.trim()); cur = ''; }
    cur += `${word} `;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.join('\n  ');
}
