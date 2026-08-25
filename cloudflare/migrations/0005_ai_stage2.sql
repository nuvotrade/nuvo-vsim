ALTER TABLE cycle_summaries ADD COLUMN state TEXT;
ALTER TABLE cycle_summaries ADD COLUMN decision TEXT;
ALTER TABLE cycle_summaries ADD COLUMN reason_code TEXT;
ALTER TABLE cycle_summaries ADD COLUMN evidence_fingerprint TEXT;
ALTER TABLE cycle_summaries ADD COLUMN updated_at TEXT;

CREATE TABLE cycle_state_events (
  owner_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'TRIGGERED','TRUTH_VERIFIED','UNIVERSE_SCREENED','UNDERWRITTEN',
    'CHALLENGED','GOVERNED','EVIDENCE_SEALED','SHADOW_RECORDED',
    'REFUSED','QUARANTINED'
  )),
  role TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, cycle_id, sequence)
);

CREATE INDEX cycle_state_events_owner_created
  ON cycle_state_events(owner_id, created_at DESC);

CREATE TABLE cycle_context_index (
  owner_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  authority_level INTEGER NOT NULL CHECK(authority_level = 1),
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

CREATE INDEX cycle_context_index_owner_created
  ON cycle_context_index(owner_id, created_at DESC);
