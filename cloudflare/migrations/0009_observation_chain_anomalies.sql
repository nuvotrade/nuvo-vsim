PRAGMA foreign_keys = ON;

CREATE TABLE broker_observation_anomalies (
  owner_id TEXT NOT NULL,
  anomaly_id TEXT NOT NULL,
  anomaly_type TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  related_observation_id TEXT,
  snapshot_hash TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, anomaly_id),
  UNIQUE(owner_id, observation_id, anomaly_type)
);
CREATE INDEX broker_observation_anomalies_owner_time
  ON broker_observation_anomalies(owner_id, detected_at DESC);

INSERT OR IGNORE INTO broker_observation_anomalies
  (owner_id,anomaly_id,anomaly_type,observation_id,related_observation_id,
   snapshot_hash,detail_json,detected_at)
SELECT
  later.owner_id,
  'ANOM-' || later.observation_id,
  'CONCURRENT_DUPLICATE_BRANCH',
  later.observation_id,
  earlier.observation_id,
  later.snapshot_hash,
  json_object(
    'reason', 'Two concurrent refreshes sealed the same custody snapshot from the same prior chain hash',
    'dataLoss', 0,
    'sourcePreserved', 1,
    'laterChainHash', later.chain_hash,
    'earlierChainHash', earlier.chain_hash
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM broker_observations AS later
JOIN broker_observations AS earlier
  ON earlier.owner_id = later.owner_id
 AND earlier.snapshot_hash = later.snapshot_hash
 AND earlier.previous_chain_hash = later.previous_chain_hash
 AND (earlier.observed_at < later.observed_at
   OR (earlier.observed_at = later.observed_at AND earlier.observation_id < later.observation_id));
