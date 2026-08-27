import { contentHash } from '../src/execution/order.js';
import { authorityValue } from '../src/constitution/authority.js';

const PERMITTED_ACTIONS = Object.freeze([
  'run_shadow_cycle', 'get_account_truth', 'get_market_state', 'get_cycle',
  'list_cycles', 'list_ranked_opportunities', 'explain_candidate',
  'explain_rejection', 'replay_evidence', 'list_evidence',
  'create_trade_proposal', 'review_order_ticket',
]);

const isFiniteNumber = (value) => value !== null && value !== undefined
  && Number.isFinite(Number(value));

const structureName = (kind) => kind === 'BULL_PUT_SPREAD' ? 'BULL_PUT' : kind;

function contextFingerprint(context) {
  return contentHash({
    account_snapshot_hash: context.account_snapshot_hash,
    quote_timestamps: context.quote_timestamps,
    engine_version: context.engine_version,
    constitution_version: context.constitution_version,
    candidates: context.candidates,
    decision: context.decision,
    proposal_template: context.proposal_template,
  });
}

export function candidateId(candidate) {
  return contentHash({
    symbol: candidate.underlying,
    structure: candidate.kind,
    expiry: candidate.expiration,
    shortStrike: candidate.shortStrike,
    longStrike: candidate.longStrike,
  }).slice(0, 24);
}

function sameCandidate(a, b) {
  return a && b && a.underlying === b.underlying && a.kind === b.kind
    && a.expiration === b.expiration && a.shortStrike === b.shortStrike
    && a.longStrike === b.longStrike;
}

function candidateRows(evidence, result) {
  const attempts = result?.governanceAttempts ?? [];
  const selected = evidence?.selected ?? null;
  const approved = Boolean(result?.governance?.approved);
  const multipliers = result?.governance?.sizing?.multipliers ?? {};
  const reduced = Object.values(multipliers).some((value) => isFiniteNumber(value) && Number(value) < 0.999999);
  const sorted = [...(evidence?.candidates ?? [])].sort((a, b) => {
    const ar = isFiniteNumber(a.raroc) ? Number(a.raroc) : -Infinity;
    const br = isFiniteNumber(b.raroc) ? Number(b.raroc) : -Infinity;
    if (br !== ar) return br - ar;
    return Number(b.nev ?? -Infinity) - Number(a.nev ?? -Infinity);
  });

  return sorted.map((candidate, index) => {
    const attempt = attempts.find((row) => row.underlying === candidate.underlying
      && row.kind === candidate.kind && row.shortStrike === candidate.shortStrike);
    const isSelected = sameCandidate(candidate, selected);
    const calibration = candidate.probabilities?.calibration ?? 'UNCALIBRATED';
    const calibrated = calibration !== 'UNCALIBRATED';
    const governor = isSelected && approved ? (reduced ? 'REDUCED' : 'PASS') : 'REJECT';
    const violations = candidate.violations ?? [];
    const governorReasons = attempt?.reasons ?? [];
    return {
      candidate_id: candidateId(candidate),
      rank: index + 1,
      symbol: candidate.underlying,
      structure: structureName(candidate.kind),
      expiry: candidate.expiration,
      strikes: candidate.longStrike == null
        ? String(candidate.shortStrike) : `${candidate.shortStrike} / ${candidate.longStrike}`,
      short_strike: candidate.shortStrike,
      long_strike: candidate.longStrike,
      dte: candidate.dte,
      p_market: candidate.probabilities?.pMarket ?? null,
      p_model: candidate.probabilities?.pModel ?? null,
      p_cal: calibrated ? candidate.probabilities?.pCal ?? null : null,
      p_cal_status: calibrated ? 'ACTIVE' : 'UNCALIBRATED',
      model_confidence: candidate.probabilities?.confidence ?? null,
      probability_of_profit_model: candidate.success?.p_model ?? null,
      probability_of_profit_market: candidate.success?.p_market ?? null,
      breakeven: candidate.success?.breakeven ?? null,
      probability_of_profit_direction: candidate.success?.direction ?? null,
      entry_credit: candidate.credit ?? null,
      buying_power: candidate.buyingPower ?? null,
      ev: candidate.ev ?? null,
      cvar: candidate.cvar ?? null,
      gap_risk: candidate.gapRisk ?? null,
      liquidity_risk: candidate.liquidityRisk ?? null,
      nev: candidate.nev ?? null,
      nev_per_day: isFiniteNumber(candidate.nev) && isFiniteNumber(candidate.dte) && Number(candidate.dte) > 0
        ? Number(candidate.nev) / Number(candidate.dte) : null,
      raroc: candidate.raroc ?? null,
      economic_capital: candidate.economicCapital ?? null,
      governor,
      verdict: isSelected && approved ? 'ELIGIBLE'
        : candidate.admissible ? 'DECLINED' : 'REFUSED',
      violations,
      governor_reasons: governorReasons,
      pass_reasons: isSelected && approved ? [
        'TRUTH_VERIFIED', 'UNIVERSE_ELIGIBLE', 'UNDERWRITING_ADMISSIBLE', 'GOVERNOR_APPROVED',
      ] : [],
      portfolio_risk: isSelected ? {
        before: result?.governance?.portfolioBefore ?? null,
        after: result?.governance?.portfolio ?? null,
      } : null,
    };
  });
}

function sessionName(value) {
  const state = String(value ?? '').toUpperCase();
  return state === 'OPEN' ? 'RTH' : ['PRE', 'POST', 'CLOSED'].includes(state) ? state : null;
}

export function decisionName(outcome) {
  if (outcome === 'REFUSED') return 'REFUSED';
  if (outcome === 'NO_TRADE') return 'NO_TRADE';
  if (outcome === 'PROPOSAL') return 'SHADOW_PROPOSAL';
  return outcome === 'ORDER' ? 'ELIGIBLE' : 'NO_TRADE';
}

export function buildCycleContext({ result, summary, snapshotHash = null }) {
  const evidence = result?.evidence ?? null;
  const raw = evidence?.inputs?.data ?? {};
  const account = raw.account ?? null;
  const positions = raw.brokerPositions ?? [];
  const openOrders = raw.brokerOpenOrders ?? [];
  const quoteTimestamps = Object.fromEntries(Object.entries(raw.symbols ?? {}).map(([symbol, packet]) => [symbol, {
    quote: packet.quoteAsOf ?? null,
    chain: packet.chainAsOf ?? null,
  }]));
  const candidates = candidateRows(evidence, result);
  const rejections = [
    ...candidates.flatMap((candidate) => [
      ...candidate.violations.map((detail) => ({ code: 'CANDIDATE_REJECTED', detail })),
      ...candidate.governor_reasons.map((detail) => ({ code: 'GOVERNOR_REJECTED', detail })),
    ]),
    ...(result?.trace ?? []).filter((entry) => !entry.ok)
      .map((entry) => ({ code: String(entry.name).toUpperCase(), detail: JSON.stringify(entry.detail ?? null) })),
  ];
  const accountSnapshotHash = snapshotHash ?? contentHash({ account, positions, openOrders });
  const decision = decisionName(summary.outcome);
  const selectedCandidate = candidates.find((candidate) => candidate.verdict === 'ELIGIBLE') ?? null;
  const proposalTemplate = result?.order && selectedCandidate ? {
    candidate_id: selectedCandidate.candidate_id,
    client_order_id: result.order.clientOrderId,
    strategy: result.order.intent?.strategy ?? result.selected?.structure?.kind ?? null,
    underlying: result.order.intent?.underlying ?? result.selected?.underlying ?? null,
    legs: result.order.legs ?? [],
    recommended_limit_price: result.order.limitPrice ?? null,
    order_type: result.order.orderType ?? 'NET_LIMIT',
    time_in_force: result.order.timeInForce ?? 'DAY',
    maximum_quantity: result.sizing?.contracts ?? null,
    expectation: result.order.expectation ?? null,
  } : null;

  return {
    cycle_id: summary.cycleId,
    authority_level: evidence?.authorityLevel ?? 1,
    engine_version: evidence?.codeVersion ?? null,
    model_version: evidence?.modelVersion ?? null,
    constitution_version: evidence?.limitsVersion ?? null,
    account_snapshot_hash: accountSnapshotHash,
    nav: account?.nav ?? null,
    cash: account?.cash ?? null,
    positions,
    open_orders: openOrders,
    session: sessionName(raw.indexState?.status),
    massive_status: raw.indexError ? 'BLOCKED' : 'LIVE',
    quote_timestamps: quoteTimestamps,
    universe: Object.keys(raw.symbols ?? {}),
    candidates,
    rejections,
    governor: evidence?.governance ?? null,
    trace: result?.trace ?? [],
    decision,
    reason_code: summary.reasonCode ?? null,
    reason: summary.reason ?? null,
    evidence_fingerprint: evidence?.decisionFingerprint ?? null,
    evidence_hash: evidence?.hash ?? null,
    proposal_template: proposalTemplate,
    permitted_actions: [...PERMITTED_ACTIONS],
    created_at: new Date(summary.at).toISOString(),
  };
}

export function buildBlockedCycleContext({ summary, detail = {}, codeVersion, constitutionVersion,
  authorityLevel }) {
  return {
    cycle_id: summary.cycleId,
    authority_level: authorityValue(authorityLevel),
    engine_version: codeVersion,
    model_version: 'nuvo-model-5.0.1-execution-cost-v2',
    constitution_version: constitutionVersion,
    account_snapshot_hash: detail.accountSnapshotHash ?? null,
    nav: detail.nav ?? null,
    cash: detail.cash ?? null,
    positions: detail.positions ?? [],
    open_orders: detail.openOrders ?? [],
    session: detail.session ?? null,
    massive_status: detail.massiveStatus ?? 'BLOCKED',
    quote_timestamps: detail.quoteTimestamps ?? {},
    universe: ['SPY', 'QQQ', 'IWM'],
    candidates: [],
    rejections: [{ code: summary.reasonCode ?? 'REFUSED', detail: summary.reason ?? 'Cycle refused.' }],
    governor: null,
    trace: [],
    decision: 'REFUSED',
    reason_code: summary.reasonCode ?? null,
    reason: summary.reason ?? null,
    evidence_fingerprint: summary.evidence?.decisionFingerprint ?? null,
    evidence_hash: summary.evidence?.hash ?? null,
    permitted_actions: [...PERMITTED_ACTIONS],
    created_at: new Date(summary.at).toISOString(),
  };
}

export class D1R2CycleContextStore {
  constructor({ db, bucket, ownerId }) {
    this.db = db;
    this.bucket = bucket;
    this.ownerId = ownerId;
  }

  async put(context) {
    const objectKey = `owners/${this.ownerId}/cycles/${context.cycle_id}.json`;
    const fingerprint = contextFingerprint(context);
    const record = Object.freeze({ ...structuredClone(context), context_hash: fingerprint });
    if (await this.bucket.head(objectKey)) return this.get(context.cycle_id);
    await this.bucket.put(objectKey, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { cycleId: context.cycle_id, contextHash: fingerprint },
    });
    try {
      await this.db.prepare(`INSERT INTO cycle_context_index
        (owner_id,cycle_id,authority_level,engine_version,constitution_version,
         account_snapshot_hash,session,massive_status,decision,evidence_fingerprint,
         context_hash,object_key,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,cycle_id) DO NOTHING`).bind(
        this.ownerId, context.cycle_id, context.authority_level, context.engine_version,
        context.constitution_version, context.account_snapshot_hash, context.session,
        context.massive_status, context.decision, context.evidence_fingerprint,
        fingerprint, objectKey, context.created_at,
      ).run();
    } catch (error) {
      await this.bucket.delete(objectKey).catch(() => {});
      throw error;
    }
    return record;
  }

  async get(cycleId) {
    const row = await this.db.prepare(`SELECT object_key,context_hash FROM cycle_context_index
      WHERE owner_id=? AND cycle_id=?`).bind(this.ownerId, cycleId).first();
    if (!row) return null;
    const object = await this.bucket.get(row.object_key);
    if (!object) throw new Error(`CYCLE_CONTEXT_OBJECT_MISSING:${row.object_key}`);
    const record = await object.json();
    if (!record?.context_hash || contextFingerprint(record) !== record.context_hash
      || record.context_hash !== row.context_hash) {
      throw new Error(`CYCLE_CONTEXT_DRIFT:${cycleId}`);
    }
    return record;
  }

  async latest() {
    const row = await this.db.prepare(`SELECT cycle_id FROM cycle_context_index
      WHERE owner_id=? ORDER BY created_at DESC LIMIT 1`).bind(this.ownerId).first();
    return row ? this.get(row.cycle_id) : null;
  }
}
