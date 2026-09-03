CREATE TABLE IF NOT EXISTS underwrite_forecasts (
  owner_id TEXT NOT NULL,
  forecast_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  symbol TEXT NOT NULL,
  contract_symbol TEXT,
  option_right TEXT NOT NULL,
  strike REAL,
  expiration TEXT,
  dte INTEGER,
  as_of TEXT NOT NULL,
  model_version TEXT NOT NULL,
  forecast_hash TEXT NOT NULL,
  forecast_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, forecast_id)
);

CREATE INDEX IF NOT EXISTS idx_underwrite_forecasts_symbol_time
  ON underwrite_forecasts(owner_id, symbol, as_of DESC);

CREATE INDEX IF NOT EXISTS idx_underwrite_forecasts_unsettled
  ON underwrite_forecasts(owner_id, expiration, symbol);
