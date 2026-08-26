PRAGMA foreign_keys = ON;

ALTER TABLE broker_events ADD COLUMN transaction_leg_id TEXT;

CREATE TABLE broker_ledger_sync_state (
  owner_id TEXT NOT NULL,
  account_key TEXT NOT NULL,
  account_mask TEXT NOT NULL,
  coverage_start TEXT,
  coverage_end TEXT,
  cursor_before TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','COMPLETE','LIMITED','FAILED')),
  events_ingested INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, account_key)
);
CREATE INDEX broker_ledger_sync_owner ON broker_ledger_sync_state(owner_id, status, updated_at);

CREATE TABLE broker_reconciliation_runs (
  owner_id TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  prior_snapshot_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('COMPLETE','FAILED')),
  position_count INTEGER NOT NULL,
  open_order_count INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  detail_json TEXT NOT NULL,
  reconciled_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, reconciliation_id)
);
CREATE INDEX broker_reconciliation_owner_time
  ON broker_reconciliation_runs(owner_id, reconciled_at DESC);

CREATE TABLE broker_position_marks (
  owner_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  symbol TEXT NOT NULL,
  underlying TEXT,
  asset_class TEXT NOT NULL,
  quantity REAL NOT NULL,
  multiplier REAL NOT NULL,
  average_price REAL,
  mark REAL,
  market_value REAL,
  unrealized_pnl REAL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, observation_id, symbol)
);
CREATE INDEX broker_position_marks_owner_symbol_time
  ON broker_position_marks(owner_id, symbol, observed_at DESC);

CREATE TABLE broker_account_performance (
  owner_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  nav REAL NOT NULL,
  cash REAL NOT NULL,
  margin_debit REAL NOT NULL,
  gross_position_value REAL NOT NULL,
  unrealized_pnl REAL,
  position_count INTEGER NOT NULL,
  open_order_count INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, snapshot_hash, observed_at)
);
CREATE INDEX broker_account_performance_owner_time
  ON broker_account_performance(owner_id, observed_at DESC);
