PRAGMA foreign_keys = ON;

CREATE TABLE broker_observations (
  owner_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  previous_chain_hash TEXT NOT NULL,
  chain_hash TEXT NOT NULL,
  account_json TEXT NOT NULL,
  positions_json TEXT NOT NULL,
  orders_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, observation_id),
  UNIQUE(owner_id, chain_hash)
);
CREATE INDEX broker_observations_owner_time ON broker_observations(owner_id, observed_at DESC);

CREATE TABLE broker_events (
  owner_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  broker_order_id TEXT,
  transaction_id TEXT,
  activity_id TEXT,
  account_mask TEXT,
  symbol TEXT,
  side TEXT,
  quantity REAL,
  price REAL,
  amount REAL,
  state TEXT,
  occurred_at TEXT,
  raw_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, event_key)
);
CREATE INDEX broker_events_owner_time ON broker_events(owner_id, occurred_at DESC, first_seen_at DESC);

CREATE TABLE guardian_campaign_contracts (
  owner_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('FROZEN','CLOSED','VOID')),
  contract_json TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, campaign_id, version)
);

CREATE TABLE guardian_reviews (
  owner_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  review_type TEXT NOT NULL CHECK(review_type IN ('EVENT','HOURLY','END_OF_DAY','MANUAL')),
  account_state TEXT NOT NULL CHECK(account_state IN ('OPEN','THROTTLED','MANAGE-ONLY','HALTED','BLOCKED-INCOMPLETE')),
  mandate_version TEXT NOT NULL,
  snapshot_hash TEXT,
  report_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, review_id)
);
CREATE INDEX guardian_reviews_owner_time ON guardian_reviews(owner_id, created_at DESC);

CREATE TABLE guardian_discord_outbox (
  owner_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK(delivery_status IN ('PENDING','SENT','FAILED','SUPPRESSED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  PRIMARY KEY(owner_id, outbox_id)
);
CREATE INDEX guardian_outbox_pending ON guardian_discord_outbox(delivery_status, created_at);
