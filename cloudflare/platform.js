import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';
import { executeShadowWorkflow } from './worker.js';
import { SchwabD1Client } from './schwab-client.js';
import {
  CUSTODY_REFRESH_DEBOUNCE_MS, performCustodyRefresh, queueCustodyRefresh,
} from './custody-refresh.js';

const LOCK_TTL_MS = 15 * 60 * 1000;

export class VsimAccountCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.snapshotTail = Promise.resolve();

    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS active_cycle (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          cycle_id TEXT NOT NULL,
          state TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS cycle_lock_history (
          cycle_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          detail TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lane_1_spy_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          armed INTEGER NOT NULL CHECK (armed IN (0, 1)),
          armed_at TEXT,
          expires_at TEXT,
          stage TEXT NOT NULL,
          buy_json TEXT,
          sell_json TEXT,
          latest_unit_json TEXT,
          fault_json TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lane_1_spy_history (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lane_1_spy_v2_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          armed INTEGER NOT NULL CHECK (armed IN (0, 1)),
          armed_at TEXT,
          expires_at TEXT,
          stage TEXT NOT NULL,
          position_side TEXT NOT NULL CHECK (position_side IN ('FLAT','LONG','SHORT')),
          open_json TEXT,
          exit_json TEXT,
          stop_json TEXT,
          latest_unit_json TEXT,
          bracket_validation_json TEXT,
          fault_json TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lane_1_spy_v2_history (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    });
  }

  async acquire(cycleId) {
    const now = Date.now();
    const active = [...this.sql.exec('SELECT * FROM active_cycle WHERE singleton = 1')][0] ?? null;

    if (active && Number(active.expires_at) > now) {
      return { acquired: false, cycle_id: active.cycle_id, state: active.state };
    }

    if (active) {
      this.sql.exec('DELETE FROM active_cycle WHERE singleton = 1');
      this.sql.exec(
        `INSERT INTO cycle_lock_history (cycle_id, state, detail, updated_at)
         VALUES (?, 'QUARANTINED', 'Coordinator lease expired', ?)
         ON CONFLICT(cycle_id) DO UPDATE SET
           state = excluded.state,
           detail = excluded.detail,
           updated_at = excluded.updated_at`,
        active.cycle_id,
        new Date(now).toISOString(),
      );
    }

    const acquiredAt = new Date(now).toISOString();
    this.sql.exec(
      `INSERT INTO active_cycle (singleton, cycle_id, state, acquired_at, expires_at)
       VALUES (1, ?, 'TRIGGERED', ?, ?)`,
      cycleId,
      acquiredAt,
      now + LOCK_TTL_MS,
    );
    this.sql.exec(
      `INSERT INTO cycle_lock_history (cycle_id, state, detail, updated_at)
       VALUES (?, 'TRIGGERED', NULL, ?)
       ON CONFLICT(cycle_id) DO UPDATE SET
         state = excluded.state,
         detail = excluded.detail,
         updated_at = excluded.updated_at`,
      cycleId,
      acquiredAt,
    );
    return { acquired: true, cycle_id: cycleId, state: 'TRIGGERED' };
  }

  async transition(cycleId, state, detail = null) {
    const active = [...this.sql.exec('SELECT cycle_id FROM active_cycle WHERE singleton = 1')][0] ?? null;
    if (!active || active.cycle_id !== cycleId) {
      return { ok: false, cycle_id: cycleId, state: 'LOCK_LOST' };
    }
    this.sql.exec('UPDATE active_cycle SET state = ? WHERE singleton = 1', state);
    this.#record(cycleId, state, detail);
    return { ok: true, cycle_id: cycleId, state };
  }

  async finish(cycleId, state, detail = null) {
    const active = [...this.sql.exec('SELECT cycle_id FROM active_cycle WHERE singleton = 1')][0] ?? null;
    if (active?.cycle_id === cycleId) this.sql.exec('DELETE FROM active_cycle WHERE singleton = 1');
    this.#record(cycleId, state, detail);
    return { ok: true, cycle_id: cycleId, state };
  }

  async status() {
    return [...this.sql.exec('SELECT * FROM active_cycle WHERE singleton = 1')][0] ?? null;
  }

  async reconciledSnapshot(ownerId) {
    const task = this.snapshotTail.then(() => new SchwabD1Client(this.env).snapshot(ownerId));
    this.snapshotTail = task.catch(() => undefined);
    return task;
  }

  async refreshCustody(ownerId, { minimumAgeMs = CUSTODY_REFRESH_DEBOUNCE_MS } = {}) {
    const thresholdMs = Math.max(CUSTODY_REFRESH_DEBOUNCE_MS, Number(minimumAgeMs) || 0);
    const queued = queueCustodyRefresh(this.snapshotTail, () => performCustodyRefresh({
      thresholdMs,
      readStored: async () => {
        const row = await this.env.DB.prepare(`SELECT snapshot_hash,observed_at
          FROM custody_latest WHERE owner_id=?`).bind(ownerId).first();
        return { observedAt: row?.observed_at ?? null, hash: row?.snapshot_hash ?? null };
      },
      readBroker: () => new SchwabD1Client(this.env).snapshot(ownerId),
    }));
    this.snapshotTail = queued.next;
    return queued.task;
  }

  #laneState(extra = {}) {
    const row = [...this.sql.exec('SELECT * FROM lane_1_spy_state WHERE singleton = 1')][0] ?? null;
    if (!row) return { armed: false, stage: 'DISARMED', buy: null, sell: null,
      latestUnit: null, fault: null, ...extra };
    return {
      armed: Number(row.armed) === 1,
      armedAt: row.armed_at,
      expiresAt: row.expires_at,
      stage: row.stage,
      buy: row.buy_json ? JSON.parse(row.buy_json) : null,
      sell: row.sell_json ? JSON.parse(row.sell_json) : null,
      latestUnit: row.latest_unit_json ? JSON.parse(row.latest_unit_json) : null,
      fault: row.fault_json ? JSON.parse(row.fault_json) : null,
      updatedAt: row.updated_at,
      ...extra,
    };
  }

  #laneRecord(eventType, detail, at = new Date().toISOString()) {
    this.sql.exec(`INSERT INTO lane_1_spy_history (event_type,detail_json,created_at)
      VALUES (?,?,?)`, eventType, JSON.stringify(detail ?? {}), at);
  }

  async laneEnsure(config = {}) {
    const existing = this.#laneState();
    if (config.armed !== true) return existing;
    const preArmDisarm = existing.updatedAt && existing.stage === 'DISARMED'
      && existing.armedAt === null && existing.buy === null && existing.sell === null
      && existing.latestUnit === null && existing.fault === null;
    if (existing.updatedAt && !preArmDisarm) return existing;
    const armedAt = String(config.armedAt ?? '');
    const expiresAt = String(config.expiresAt ?? '');
    if (!Number.isFinite(Date.parse(armedAt)) || !Number.isFinite(Date.parse(expiresAt))
      || Date.parse(expiresAt) - Date.parse(armedAt) !== 86_400_000) {
      return { ...existing, configurationFault: 'LANE_1_ARM_WINDOW_INVALID' };
    }
    const at = new Date().toISOString();
    if (preArmDisarm) {
      this.sql.exec(`UPDATE lane_1_spy_state SET armed=1,armed_at=?,expires_at=?,stage='ARMED_BUY',
        buy_json=NULL,sell_json=NULL,latest_unit_json=NULL,fault_json=NULL,updated_at=?
        WHERE singleton=1`, armedAt, expiresAt, at);
    } else {
      this.sql.exec(`INSERT INTO lane_1_spy_state
        (singleton,armed,armed_at,expires_at,stage,buy_json,sell_json,latest_unit_json,fault_json,updated_at)
        VALUES (1,1,?,?,'ARMED_BUY',NULL,NULL,NULL,NULL,?)`, armedAt, expiresAt, at);
    }
    this.#laneRecord('ARMED', { armedAt, expiresAt }, at);
    return this.#laneState({ justArmed: true });
  }

  async laneClaimSignal({ side, seal }) {
    const state = this.#laneState();
    const expected = side === 'BUY' ? 'ARMED_BUY' : 'AWAITING_SELL';
    if (!state.armed || state.stage !== expected) return { claimed: false, state };
    const at = new Date().toISOString();
    const field = side === 'BUY' ? 'buy_json' : 'sell_json';
    this.sql.exec(`UPDATE lane_1_spy_state SET stage=?, ${field}=?, updated_at=?
      WHERE singleton=1`, `${side}_SENDING`, JSON.stringify({ seal }), at);
    this.#laneRecord('PROPOSAL_SEALED', {
      side, clientOrderId: seal.clientOrderId, proposalHash: seal.proposalHash,
    }, at);
    return { claimed: true, state: this.#laneState() };
  }

  async laneRecordBrokerAccepted({ side, brokerOrderId, acceptedAt }) {
    const state = this.#laneState();
    if (state.stage !== `${side}_SENDING`) throw new Error('LANE_1_STATE_TRANSITION_REFUSED');
    const field = side === 'BUY' ? 'buy_json' : 'sell_json';
    const order = { ...(state[side.toLowerCase()] ?? {}), brokerOrderId, acceptedAt };
    this.sql.exec(`UPDATE lane_1_spy_state SET ${field}=?,updated_at=? WHERE singleton=1`,
      JSON.stringify(order), acceptedAt);
    this.#laneRecord('ORDER_ACCEPTED', { side, brokerOrderId }, acceptedAt);
    return this.#laneState();
  }

  async laneRecordUnit({ side, unit }) {
    const at = String(unit.updatedAt ?? new Date().toISOString());
    const stage = side === 'BUY' ? 'AWAITING_SELL' : 'DISARMED';
    const armed = side === 'BUY' ? 1 : 0;
    this.sql.exec(`UPDATE lane_1_spy_state SET armed=?,stage=?,latest_unit_json=?,fault_json=NULL,
      updated_at=? WHERE singleton=1`, armed, stage, JSON.stringify(unit), at);
    this.#laneRecord(side === 'BUY' ? 'FILLED' : 'SOLD', {
      side, fillId: side === 'BUY' ? unit.buyFillId : unit.sellFillId,
      manifestHash: unit.manifestHash, resolvedUnitId: unit.resolvedUnitId,
    }, at);
    if (side === 'SELL') this.#laneRecord('DISARMED', { reason: 'ROUND_TRIP_COMPLETE' }, at);
    return this.#laneState();
  }

  async laneRecordFault(detail) {
    const at = String(detail.at ?? new Date().toISOString());
    this.sql.exec(`UPDATE lane_1_spy_state SET armed=0,stage='FAULT',fault_json=?,updated_at=?
      WHERE singleton=1`, JSON.stringify(detail), at);
    this.#laneRecord('FAULT', detail, at);
    return this.#laneState();
  }

  async laneRecordRecoveredBuy({ unit, buy }) {
    const state = this.#laneState();
    if (state.armed || state.stage !== 'FAULT' || state.latestUnit) {
      throw new Error('LANE_1_RECOVERY_STATE_REFUSED');
    }
    if (String(state.fault?.brokerOrderId ?? '') !== String(buy?.brokerOrderId ?? '')
      || unit?.symbol !== 'SPY' || unit?.quantity !== 1 || !unit?.buyFillId
      || unit?.sellFillId) {
      throw new Error('LANE_1_RECOVERY_EVIDENCE_REFUSED');
    }
    const at = String(unit.updatedAt ?? new Date().toISOString());
    const recoveredBuy = { ...(state.buy ?? {}), ...buy };
    this.sql.exec(`UPDATE lane_1_spy_state SET armed=0,stage='FLATTEN_READY',buy_json=?,
      latest_unit_json=?,fault_json=NULL,updated_at=? WHERE singleton=1`,
    JSON.stringify(recoveredBuy), JSON.stringify(unit), at);
    this.#laneRecord('BUY_IDENTITY_INGESTED', {
      brokerOrderId: buy.brokerOrderId, fillId: unit.buyFillId,
      manifestHash: unit.manifestHash,
    }, at);
    return this.#laneState();
  }

  async laneClaimPrincipalFlatten({ seal }) {
    const state = this.#laneState();
    if (state.armed || state.stage !== 'FLATTEN_READY'
      || state.latestUnit?.state !== 'OPEN_SHARES'
      || state.latestUnit?.symbol !== 'SPY' || state.latestUnit?.quantity !== 1) {
      return { claimed: false, state };
    }
    const at = new Date().toISOString();
    this.sql.exec(`UPDATE lane_1_spy_state SET stage='FLATTEN_SENDING',sell_json=?,updated_at=?
      WHERE singleton=1`, JSON.stringify({ seal }), at);
    this.#laneRecord('PRINCIPAL_FLATTEN_CLAIMED', {
      side: 'SELL', clientOrderId: seal.clientOrderId, proposalHash: seal.proposalHash,
    }, at);
    return { claimed: true, state: this.#laneState() };
  }

  async laneRecordPrincipalFlattenAccepted({ brokerOrderId, acceptedAt }) {
    const state = this.#laneState();
    if (state.armed || state.stage !== 'FLATTEN_SENDING') {
      throw new Error('LANE_1_FLATTEN_STATE_TRANSITION_REFUSED');
    }
    const order = { ...(state.sell ?? {}), brokerOrderId, acceptedAt };
    this.sql.exec(`UPDATE lane_1_spy_state SET sell_json=?,updated_at=? WHERE singleton=1`,
      JSON.stringify(order), acceptedAt);
    this.#laneRecord('ORDER_ACCEPTED', { side: 'SELL', brokerOrderId }, acceptedAt);
    return this.#laneState();
  }

  async laneDisarm({ reason, at = new Date().toISOString() }) {
    const existing = this.#laneState();
    if (existing.updatedAt && !existing.armed && existing.stage === 'DISARMED') {
      return { ...existing, changed: false };
    }
    if (existing.updatedAt) {
      this.sql.exec(`UPDATE lane_1_spy_state SET armed=0,stage='DISARMED',updated_at=?
        WHERE singleton=1`, at);
    } else {
      this.sql.exec(`INSERT INTO lane_1_spy_state
        (singleton,armed,armed_at,expires_at,stage,buy_json,sell_json,latest_unit_json,fault_json,updated_at)
        VALUES (1,0,NULL,NULL,'DISARMED',NULL,NULL,NULL,NULL,?)`, at);
    }
    this.#laneRecord('DISARMED', { reason }, at);
    return this.#laneState({ changed: true });
  }

  async laneStatus() { return this.#laneState(); }

  #laneV2State(extra = {}) {
    const row = [...this.sql.exec('SELECT * FROM lane_1_spy_v2_state WHERE singleton=1')][0] ?? null;
    if (!row) return { armed: false, stage: 'DISARMED', positionSide: 'FLAT', open: null,
      exit: null, stop: null, latestUnit: null, marketValidation: null, fault: null, ...extra };
    return { armed: Number(row.armed) === 1, armedAt: row.armed_at, expiresAt: row.expires_at,
      stage: row.stage, positionSide: row.position_side,
      open: row.open_json ? JSON.parse(row.open_json) : null,
      exit: row.exit_json ? JSON.parse(row.exit_json) : null,
      stop: row.stop_json ? JSON.parse(row.stop_json) : null,
      latestUnit: row.latest_unit_json ? JSON.parse(row.latest_unit_json) : null,
      marketValidation: row.bracket_validation_json ? JSON.parse(row.bracket_validation_json) : null,
      fault: row.fault_json ? JSON.parse(row.fault_json) : null, updatedAt: row.updated_at, ...extra };
  }

  #laneV2Record(eventType, detail, at = new Date().toISOString()) {
    this.sql.exec(`INSERT INTO lane_1_spy_v2_history (event_type,detail_json,created_at)
      VALUES (?,?,?)`, eventType, JSON.stringify(detail ?? {}), at);
  }

  async laneV2RecordMarketValidation(validation) {
    const at = String(validation?.validatedAt ?? new Date().toISOString());
    const existing = this.#laneV2State();
    if (existing.armed) throw new Error('LANE_1_MARKET_VALIDATION_REQUIRES_DISARMED');
    if (existing.positionSide !== 'FLAT' || existing.open || existing.exit || existing.fault) {
      throw new Error('LANE_1_MARKET_VALIDATION_STATE_NOT_CLEAN');
    }
    const long = validation?.previews?.find((row) => row.signal === 'LONG');
    const short = validation?.previews?.find((row) => row.signal === 'SHORT');
    if (validation?.contractVersion !== 'LANE_1_SPY_MARKET_ONLY_V2_1'
      || validation?.longEnabled !== true || typeof validation?.shortEnabled !== 'boolean'
      || validation?.previews?.length !== 2 || long?.status !== 'CLEAR'
      || !['CLEAR', 'DISABLED'].includes(short?.status)
      || validation.shortEnabled !== (short.status === 'CLEAR')) {
      throw new Error('LANE_1_MARKET_VALIDATION_INVALID');
    }
    if (existing.updatedAt) {
      this.sql.exec(`UPDATE lane_1_spy_v2_state SET stage='VALIDATED_OFF',
        bracket_validation_json=?,updated_at=? WHERE singleton=1`, JSON.stringify(validation), at);
    } else {
      this.sql.exec(`INSERT INTO lane_1_spy_v2_state
        (singleton,armed,armed_at,expires_at,stage,position_side,open_json,exit_json,stop_json,
         latest_unit_json,bracket_validation_json,fault_json,updated_at)
        VALUES (1,0,NULL,NULL,'VALIDATED_OFF','FLAT',NULL,NULL,NULL,NULL,?,NULL,?)`,
      JSON.stringify(validation), at);
    }
    this.#laneV2Record('MARKET_VALIDATED', { contractVersion: validation.contractVersion,
      longEnabled: true, shortEnabled: validation.shortEnabled,
      accountMask: validation.accountMask, requestHashes: validation.previews.map((row) => row.requestSha256) }, at);
    return this.#laneV2State();
  }

  async laneV2PrincipalArm({ reason, armedAt, expiresAt }) {
    const existing = this.#laneV2State();
    if (reason !== 'PRINCIPAL_DASHBOARD_ARM') throw new Error('LANE_1_PRINCIPAL_ARM_INVALID');
    if (!Number.isFinite(Date.parse(armedAt)) || !Number.isFinite(Date.parse(expiresAt))
      || Date.parse(expiresAt) <= Date.parse(armedAt)) {
      throw new Error('LANE_1_PRINCIPAL_ARM_WINDOW_INVALID');
    }
    if (existing.armed) return existing;
    if (existing.positionSide !== 'FLAT' || existing.open || existing.exit || existing.fault) {
      throw new Error('LANE_1_ARM_STATE_NOT_CLEAN');
    }
    if (existing.updatedAt) {
      this.sql.exec(`UPDATE lane_1_spy_v2_state SET armed=1,armed_at=?,expires_at=?,stage='FLAT',
        position_side='FLAT',open_json=NULL,exit_json=NULL,stop_json=NULL,
        bracket_validation_json=NULL,fault_json=NULL,updated_at=? WHERE singleton=1`,
      armedAt, expiresAt, armedAt);
    } else {
      this.sql.exec(`INSERT INTO lane_1_spy_v2_state
        (singleton,armed,armed_at,expires_at,stage,position_side,open_json,exit_json,stop_json,
         latest_unit_json,bracket_validation_json,fault_json,updated_at)
        VALUES (1,1,?,?,'FLAT','FLAT',NULL,NULL,NULL,NULL,NULL,NULL,?)`,
      armedAt, expiresAt, armedAt);
    }
    this.#laneV2Record('ARMED', { armedAt, expiresAt, reason,
      marketContractVersion: 'LANE_1_SPY_MARKET_ONLY_V2_1' }, armedAt);
    return this.#laneV2State({ justArmed: true });
  }

  async laneV2Ensure(config = {}) {
    const state = this.#laneV2State();
    if (config.armed !== true) return state;
    if (state.armed) return state;
    if (!state.updatedAt) return { ...state,
      configurationFault: 'LANE_1_MARKET_VALIDATION_REQUIRED' };
    if (state.stage !== 'VALIDATED_OFF') return state;
    if (state.positionSide !== 'FLAT' || state.open || state.exit || state.latestUnit || state.fault) {
      return { ...state, configurationFault: 'LANE_1_ARM_STATE_NOT_CLEAN' };
    }
    const validationAge = Date.now() - Date.parse(state.marketValidation?.validatedAt ?? '');
    if (state.marketValidation?.contractVersion !== 'LANE_1_SPY_MARKET_ONLY_V2_1'
      || state.marketValidation?.longEnabled !== true
      || !Number.isFinite(validationAge) || validationAge < 0 || validationAge > 86_400_000) {
      return { ...state, configurationFault: 'LANE_1_MARKET_VALIDATION_REQUIRED' };
    }
    const armedAt = String(config.armedAt ?? ''); const expiresAt = String(config.expiresAt ?? '');
    if (!Number.isFinite(Date.parse(armedAt)) || !Number.isFinite(Date.parse(expiresAt))
      || Date.parse(expiresAt) - Date.parse(armedAt) !== 86_400_000) {
      return { ...state, configurationFault: 'LANE_1_ARM_WINDOW_INVALID' };
    }
    const at = new Date().toISOString();
    this.sql.exec(`UPDATE lane_1_spy_v2_state SET armed=1,armed_at=?,expires_at=?,stage='FLAT',
      position_side='FLAT',fault_json=NULL,updated_at=? WHERE singleton=1`, armedAt, expiresAt, at);
    this.#laneV2Record('ARMED', { armedAt, expiresAt,
      marketContractVersion: state.marketValidation.contractVersion,
      shortEnabled: state.marketValidation.shortEnabled }, at);
    return this.#laneV2State({ justArmed: true });
  }

  async laneV2Claim({ signal, seal }) {
    const state = this.#laneV2State();
    const expectedStage = signal === 'EXIT' ? `OPEN_${state.positionSide}` : 'FLAT';
    if (!state.armed || state.stage !== expectedStage) return { claimed: false, state };
    const at = new Date().toISOString();
    const field = signal === 'EXIT' ? 'exit_json' : 'open_json';
    this.sql.exec(`UPDATE lane_1_spy_v2_state SET stage=?,${field}=?,updated_at=? WHERE singleton=1`,
      `${signal}_SENDING`, JSON.stringify({ seal }), at);
    this.#laneV2Record('PROPOSAL_SEALED', { signal, clientOrderId: seal.clientOrderId,
      proposalHash: seal.proposalHash }, at);
    return { claimed: true, state: this.#laneV2State() };
  }

  async laneV2RecordAccepted({ signal, brokerOrderId, acceptedAt }) {
    const state = this.#laneV2State(); const field = signal === 'EXIT' ? 'exit_json' : 'open_json';
    if (state.stage !== `${signal}_SENDING`) throw new Error('LANE_1_STATE_TRANSITION_REFUSED');
    const prior = signal === 'EXIT' ? state.exit : state.open;
    this.sql.exec(`UPDATE lane_1_spy_v2_state SET ${field}=?,updated_at=? WHERE singleton=1`,
      JSON.stringify({ ...(prior ?? {}), brokerOrderId, acceptedAt }), acceptedAt);
    this.#laneV2Record('ORDER_ACCEPTED', { signal, brokerOrderId }, acceptedAt);
    return this.#laneV2State();
  }

  async laneV2RecordOpen({ signal, unit }) {
    if (!['LONG', 'SHORT'].includes(signal)) throw new Error('LANE_1_OPEN_RECORD_INVALID');
    const at = String(unit.updatedAt ?? new Date().toISOString());
    this.sql.exec(`UPDATE lane_1_spy_v2_state SET stage=?,position_side=?,stop_json=?,
      latest_unit_json=?,fault_json=NULL,updated_at=? WHERE singleton=1`, `OPEN_${signal}`, signal,
    null, JSON.stringify(unit), at);
    this.#laneV2Record('OPEN_FILLED', { signal, fillId: unit.openingFillId,
      brokerOrderId: unit.events?.find((row) => row.eventType === 'ORDER_ACCEPTED')?.brokerOrderId ?? null,
      manifestHash: unit.manifestHash }, at);
    return this.#laneV2State();
  }

  async laneV2RecordExit({ unit, cancellation }) {
    const at = String(unit.updatedAt ?? new Date().toISOString());
    this.sql.exec(`UPDATE lane_1_spy_v2_state SET stage='FLAT',position_side='FLAT',
      open_json=NULL,exit_json=NULL,stop_json=NULL,latest_unit_json=?,fault_json=NULL,updated_at=?
      WHERE singleton=1`,
    JSON.stringify(unit), at);
    this.#laneV2Record('EXIT_FILLED', { fillId: unit.closingFillId,
      realizedPnlCents: unit.realizedPnlCents, stopCancellation: cancellation }, at);
    return this.#laneV2State();
  }

  async laneV2RecordFault(detail) {
    const at = String(detail?.at ?? new Date().toISOString());
    this.sql.exec(`UPDATE lane_1_spy_v2_state SET armed=0,stage='FAULT',fault_json=?,updated_at=?
      WHERE singleton=1`, JSON.stringify(detail), at);
    this.#laneV2Record('FAULT', detail, at);
    return this.#laneV2State();
  }

  async laneV2Disarm({ reason, at = new Date().toISOString() }) {
    const state = this.#laneV2State();
    if (!state.updatedAt) {
      this.sql.exec(`INSERT INTO lane_1_spy_v2_state
        (singleton,armed,armed_at,expires_at,stage,position_side,open_json,exit_json,stop_json,
         latest_unit_json,bracket_validation_json,fault_json,updated_at)
        VALUES (1,0,NULL,NULL,'DISARMED','FLAT',NULL,NULL,NULL,NULL,NULL,NULL,?)`, at);
    } else if (!state.armed && state.stage === 'DISARMED') return { ...state, changed: false };
    else this.sql.exec(`UPDATE lane_1_spy_v2_state SET armed=0,stage='DISARMED',updated_at=?
      WHERE singleton=1`, at);
    this.#laneV2Record('DISARMED', { reason }, at);
    return this.#laneV2State({ changed: true });
  }

  async laneV2Status() { return this.#laneV2State(); }

  async laneV2History({ limit = 250 } = {}) {
    const boundedLimit = Math.min(250, Math.max(1, Number.isSafeInteger(Number(limit))
      ? Number(limit) : 250));
    const rows = [...this.sql.exec(`SELECT sequence,event_type,detail_json,created_at FROM (
      SELECT sequence,event_type,detail_json,created_at FROM lane_1_spy_v2_history
      ORDER BY sequence DESC LIMIT ?)
      ORDER BY sequence ASC`, boundedLimit)];
    return { appendOnly: true, readOnly: true, events: rows };
  }

  #record(cycleId, state, detail) {
    this.sql.exec(
      `INSERT INTO cycle_lock_history (cycle_id, state, detail, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(cycle_id) DO UPDATE SET
         state = excluded.state,
         detail = excluded.detail,
         updated_at = excluded.updated_at`,
      cycleId,
      state,
      detail,
      new Date().toISOString(),
    );
  }
}

export class ShadowCycleWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return executeShadowWorkflow(this.env, event.payload, step);
  }
}
