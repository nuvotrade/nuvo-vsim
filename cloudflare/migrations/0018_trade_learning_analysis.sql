-- Completed-trade learning is downstream of canonical broker truth. Rows are
-- sealed once and never update or delete the trade, fill, or original decision.
CREATE TABLE IF NOT EXISTS trade_learning_analysis (
  owner_id TEXT NOT NULL,
  analysis_id TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  trade_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  analysis_json TEXT NOT NULL,
  analysis_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, analysis_id),
  UNIQUE (owner_id, trade_id, trade_hash, prompt_version)
);

CREATE INDEX IF NOT EXISTS idx_trade_learning_owner_trade
  ON trade_learning_analysis(owner_id, trade_id, created_at);
