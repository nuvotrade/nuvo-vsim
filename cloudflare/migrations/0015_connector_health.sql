PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS connector_health (
  owner_id TEXT NOT NULL,
  connector TEXT NOT NULL CHECK(connector IN ('D1','SCHWAB','MARKET','TV','DISCORD','BOT')),
  status TEXT NOT NULL CHECK(status IN ('GREEN','RED')),
  last_probe_at TEXT NOT NULL,
  last_success_at TEXT,
  failure_code TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  dashboard_version TEXT NOT NULL,
  upstream_version TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, connector)
);

CREATE INDEX IF NOT EXISTS connector_health_owner_probe
  ON connector_health(owner_id, last_probe_at DESC);
