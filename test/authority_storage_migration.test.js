import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migration = readFileSync(new URL(
  '../cloudflare/migrations/0014_authority_storage_ladder.sql', import.meta.url,
), 'utf8');

function legacyDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE evidence_index (
      owner_id TEXT NOT NULL, cycle_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      evidence_hash TEXT NOT NULL, previous_hash TEXT NOT NULL, chain_hash TEXT NOT NULL,
      decision_fingerprint TEXT, decision TEXT NOT NULL,
      authority_level INTEGER NOT NULL CHECK(authority_level = 1),
      object_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      PRIMARY KEY(owner_id,cycle_id), UNIQUE(owner_id,sequence)
    );
    CREATE INDEX evidence_index_owner_created ON evidence_index(owner_id,created_at DESC);
    CREATE TABLE cycle_context_index (
      owner_id TEXT NOT NULL, cycle_id TEXT NOT NULL,
      authority_level INTEGER NOT NULL CHECK(authority_level IN (1,2)),
      engine_version TEXT, constitution_version TEXT, account_snapshot_hash TEXT,
      session TEXT, massive_status TEXT NOT NULL CHECK(massive_status IN ('LIVE','BLOCKED')),
      decision TEXT NOT NULL, evidence_fingerprint TEXT, context_hash TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      PRIMARY KEY(owner_id,cycle_id)
    );
    CREATE INDEX cycle_context_index_owner_created ON cycle_context_index(owner_id,created_at DESC);
    INSERT INTO evidence_index VALUES
      ('owner','cycle-1',0,'e0','GENESIS','c0','d0','REFUSED',1,'evidence/0.json','2026-08-26T16:15:49.084Z');
    INSERT INTO cycle_context_index VALUES
      ('owner','cycle-1',2,'engine','constitution','snapshot','CLOSED','BLOCKED',
       'REFUSED','d0','context-hash','contexts/1.json','2026-08-26T16:15:49.084Z');
  `);
  return db;
}

test('authority storage migration preserves rows and accepts exactly levels 0 through 5', () => {
  const db = legacyDatabase();
  db.exec(migration);

  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM evidence_index').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cycle_context_index').get().n, 1);

  const schemas = Object.fromEntries(db.prepare(`SELECT name,sql FROM sqlite_master
    WHERE type='table' AND name IN ('evidence_index','cycle_context_index')`).all()
    .map((row) => [row.name, row.sql]));
  assert.match(schemas.evidence_index, /authority_level BETWEEN 0 AND 5/);
  assert.match(schemas.cycle_context_index, /authority_level BETWEEN 0 AND 5/);

  const indexes = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='index'
    AND name IN ('evidence_index_owner_created','cycle_context_index_owner_created')`).all()
    .map((row) => row.name));
  assert.deepEqual(indexes, new Set([
    'evidence_index_owner_created', 'cycle_context_index_owner_created',
  ]));

  const insert = db.prepare(`INSERT INTO evidence_index
    (owner_id,cycle_id,sequence,evidence_hash,previous_hash,chain_hash,decision,
     authority_level,object_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (let level = 0; level <= 5; level += 1) {
    insert.run('owner', `cycle-${level + 2}`, level + 1, `e${level}`, 'p', `c${level}`,
      'REFUSED', level, `evidence/${level + 1}.json`, '2026-08-27T00:00:00.000Z');
  }
  for (const level of [-1, 6]) {
    assert.throws(() => insert.run('owner', `invalid-${level}`, 100 + level, 'e', 'p', 'c',
      'REFUSED', level, `invalid/${level}.json`, '2026-08-27T00:00:00.000Z'), /constraint failed/i);
  }

  const insertContext = db.prepare(`INSERT INTO cycle_context_index
    (owner_id,cycle_id,authority_level,massive_status,decision,context_hash,object_key,created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (let level = 0; level <= 5; level += 1) {
    insertContext.run('owner', `context-${level}`, level, 'BLOCKED', 'REFUSED',
      `context-hash-${level}`, `contexts/range-${level}.json`, '2026-08-27T00:00:00.000Z');
  }
  for (const level of [-1, 6]) {
    assert.throws(() => insertContext.run('owner', `invalid-context-${level}`, level,
      'BLOCKED', 'REFUSED', `invalid-context-hash-${level}`, `invalid-context/${level}.json`,
      '2026-08-27T00:00:00.000Z'), /constraint failed/i);
  }

  db.close();
});
