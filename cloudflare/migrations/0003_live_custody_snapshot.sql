CREATE TABLE custody_latest (
  owner_id TEXT PRIMARY KEY,
  snapshot_hash TEXT NOT NULL,
  account_json TEXT NOT NULL,
  positions_json TEXT NOT NULL,
  orders_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX custody_latest_observed ON custody_latest(observed_at DESC);
