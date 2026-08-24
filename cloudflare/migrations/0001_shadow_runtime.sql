PRAGMA foreign_keys = ON;

CREATE TABLE broker_oauth_states (
  state_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX broker_oauth_states_owner ON broker_oauth_states(owner_id, created_at DESC);

CREATE TABLE broker_token_vault (
  owner_id TEXT PRIMARY KEY,
  encrypted_access_token TEXT NOT NULL,
  access_iv TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  refresh_iv TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE broker_connections (
  owner_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('CONNECTED','DEGRADED','DISCONNECTED')),
  last_successful_sync_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE custody_baselines (
  owner_id TEXT PRIMARY KEY,
  snapshot_hash TEXT NOT NULL,
  account_json TEXT NOT NULL,
  positions_json TEXT NOT NULL,
  orders_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE evidence_index (
  owner_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  decision_fingerprint TEXT,
  decision TEXT NOT NULL,
  authority_level INTEGER NOT NULL CHECK(authority_level = 1),
  object_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, cycle_id),
  UNIQUE(owner_id, sequence)
);

CREATE INDEX evidence_index_owner_created ON evidence_index(owner_id, created_at DESC);

CREATE TABLE cycle_leases (
  owner_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY(owner_id, cycle_id)
);

CREATE TABLE cycle_summaries (
  owner_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  regime TEXT,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, cycle_id)
);

CREATE INDEX cycle_summaries_owner_created ON cycle_summaries(owner_id, created_at DESC);

CREATE TABLE operational_audit (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX operational_audit_owner_created ON operational_audit(owner_id, created_at DESC);

