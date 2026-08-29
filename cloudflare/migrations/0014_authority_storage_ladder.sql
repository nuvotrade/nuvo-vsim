PRAGMA foreign_keys = OFF;

-- Rebuild through uniquely named staging tables. This succeeds from both the
-- original authority-limited schema and an already-upgraded production schema,
-- and a partial prior attempt cannot leave a conflicting legacy table behind.
DROP TABLE IF EXISTS evidence_index_authority_v2;
CREATE TABLE evidence_index_authority_v2 (
  owner_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  decision_fingerprint TEXT,
  decision TEXT NOT NULL,
  authority_level INTEGER NOT NULL CHECK(authority_level BETWEEN 0 AND 5),
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, cycle_id),
  UNIQUE(owner_id, sequence)
);
INSERT INTO evidence_index_authority_v2 (
  owner_id,cycle_id,sequence,evidence_hash,previous_hash,chain_hash,
  decision_fingerprint,decision,authority_level,object_key,created_at
)
SELECT owner_id,cycle_id,sequence,evidence_hash,previous_hash,chain_hash,
  decision_fingerprint,decision,authority_level,object_key,created_at
FROM evidence_index;
DROP TABLE evidence_index;
ALTER TABLE evidence_index_authority_v2 RENAME TO evidence_index;
CREATE INDEX evidence_index_owner_created ON evidence_index(owner_id, created_at DESC);

DROP TABLE IF EXISTS cycle_context_index_authority_v2;
CREATE TABLE cycle_context_index_authority_v2 (
  owner_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  authority_level INTEGER NOT NULL CHECK(authority_level BETWEEN 0 AND 5),
  engine_version TEXT,
  constitution_version TEXT,
  account_snapshot_hash TEXT,
  session TEXT,
  massive_status TEXT NOT NULL CHECK(massive_status IN ('LIVE','BLOCKED')),
  decision TEXT NOT NULL,
  evidence_fingerprint TEXT,
  context_hash TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, cycle_id)
);
INSERT INTO cycle_context_index_authority_v2 (
  owner_id,cycle_id,authority_level,engine_version,constitution_version,
  account_snapshot_hash,session,massive_status,decision,evidence_fingerprint,
  context_hash,object_key,created_at
)
SELECT owner_id,cycle_id,authority_level,engine_version,constitution_version,
  account_snapshot_hash,session,massive_status,decision,evidence_fingerprint,
  context_hash,object_key,created_at
FROM cycle_context_index;
DROP TABLE cycle_context_index;
ALTER TABLE cycle_context_index_authority_v2 RENAME TO cycle_context_index;
CREATE INDEX cycle_context_index_owner_created
  ON cycle_context_index(owner_id, created_at DESC);

PRAGMA foreign_keys = ON;
