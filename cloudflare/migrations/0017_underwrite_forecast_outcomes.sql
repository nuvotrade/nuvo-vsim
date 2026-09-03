CREATE TABLE IF NOT EXISTS underwrite_forecast_outcomes (
  owner_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  forecast_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  expiration TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK(event_name = 'FINISH_ITM_AT_EXPIRY'),
  outcome_value INTEGER NOT NULL CHECK(outcome_value IN (0,1)),
  terminal_price REAL NOT NULL,
  outcome_source TEXT NOT NULL,
  outcome_source_timestamp TEXT NOT NULL,
  outcome_hash TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, outcome_id),
  UNIQUE (owner_id, forecast_id),
  FOREIGN KEY (owner_id, forecast_id)
    REFERENCES underwrite_forecasts(owner_id, forecast_id)
);

CREATE INDEX IF NOT EXISTS idx_underwrite_outcomes_symbol_expiry
  ON underwrite_forecast_outcomes(owner_id, symbol, expiration);

CREATE TABLE IF NOT EXISTS underwrite_forecast_scores (
  owner_id TEXT NOT NULL,
  score_id TEXT NOT NULL,
  forecast_id TEXT NOT NULL,
  outcome_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  model_version TEXT NOT NULL,
  model_name TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK(event_name = 'FINISH_ITM_AT_EXPIRY'),
  probability REAL NOT NULL CHECK(probability >= 0 AND probability <= 1),
  outcome_value INTEGER NOT NULL CHECK(outcome_value IN (0,1)),
  brier_score REAL NOT NULL CHECK(brier_score >= 0 AND brier_score <= 1),
  predicted_raw_nev_0 REAL,
  realized_nev_0 REAL NOT NULL,
  score_version TEXT NOT NULL,
  forecast_hash TEXT NOT NULL,
  outcome_hash TEXT NOT NULL,
  score_hash TEXT NOT NULL,
  score_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, score_id),
  UNIQUE (owner_id, surface, forecast_id, model_version, model_name),
  FOREIGN KEY (owner_id, forecast_id)
    REFERENCES underwrite_forecasts(owner_id, forecast_id),
  FOREIGN KEY (owner_id, outcome_id)
    REFERENCES underwrite_forecast_outcomes(owner_id, outcome_id)
);

CREATE INDEX IF NOT EXISTS idx_underwrite_scores_model
  ON underwrite_forecast_scores(owner_id, surface, model_version, model_name, created_at);
