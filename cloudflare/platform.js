import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers';
import { executeShadowWorkflow } from './worker.js';
import { SchwabD1Client } from './schwab-client.js';

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
