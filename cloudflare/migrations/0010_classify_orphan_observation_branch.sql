PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO broker_observation_anomalies
  (owner_id,anomaly_id,anomaly_type,observation_id,related_observation_id,
   snapshot_hash,detail_json,detected_at)
SELECT
  orphan.owner_id,
  'ANOM-' || orphan.observation_id,
  'CONCURRENT_DUPLICATE_BRANCH',
  orphan.observation_id,
  canonical.observation_id,
  orphan.snapshot_hash,
  json_object(
    'reason', 'A concurrent refresh sealed a duplicate custody snapshot on an uncontinued branch',
    'dataLoss', 0,
    'sourcePreserved', 1,
    'orphanChainHash', orphan.chain_hash,
    'continuedChainHash', canonical.chain_hash
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM broker_observations AS orphan
JOIN broker_observations AS canonical
  ON canonical.owner_id = orphan.owner_id
 AND canonical.snapshot_hash = orphan.snapshot_hash
 AND canonical.observation_id <> orphan.observation_id
WHERE NOT EXISTS (
  SELECT 1 FROM broker_observations AS orphan_child
  WHERE orphan_child.owner_id = orphan.owner_id
    AND orphan_child.previous_chain_hash = orphan.chain_hash
)
AND EXISTS (
  SELECT 1 FROM broker_observations AS canonical_child
  WHERE canonical_child.owner_id = canonical.owner_id
    AND canonical_child.previous_chain_hash = canonical.chain_hash
);
