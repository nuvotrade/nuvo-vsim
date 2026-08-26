PRAGMA foreign_keys = ON;

DROP INDEX IF EXISTS cycle_context_index_owner_created;
ALTER TABLE cycle_context_index RENAME TO cycle_context_index_authority1;
CREATE TABLE cycle_context_index (
  owner_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  authority_level INTEGER NOT NULL CHECK(authority_level IN (1,2)),
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
INSERT INTO cycle_context_index SELECT * FROM cycle_context_index_authority1;
DROP TABLE cycle_context_index_authority1;
CREATE INDEX cycle_context_index_owner_created
  ON cycle_context_index(owner_id, created_at DESC);

CREATE TABLE trade_proposals (
  owner_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('FROZEN','EXPIRED','VOID')),
  proposal_hash TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  account_snapshot_hash TEXT NOT NULL,
  guardian_review_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  order_template_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, proposal_id)
);
CREATE INDEX trade_proposals_owner_time ON trade_proposals(owner_id, created_at DESC);

CREATE TABLE trade_ticket_reviews (
  owner_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('APPROVED','REVISE','REJECT','BLOCKED')),
  approval_id TEXT,
  ticket_hash TEXT NOT NULL,
  ticket_json TEXT NOT NULL,
  exact_order_json TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL,
  account_snapshot_hash TEXT,
  market_asof TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, review_id),
  UNIQUE(owner_id, approval_id),
  FOREIGN KEY(owner_id, proposal_id) REFERENCES trade_proposals(owner_id, proposal_id)
);
CREATE INDEX trade_ticket_reviews_owner_time ON trade_ticket_reviews(owner_id, created_at DESC);
