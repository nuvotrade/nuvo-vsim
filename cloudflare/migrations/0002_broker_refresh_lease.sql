CREATE TABLE broker_token_refresh_leases (
  owner_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX broker_token_refresh_leases_expires
  ON broker_token_refresh_leases(expires_at);
