CREATE TABLE operator_controls (
  owner_id TEXT PRIMARY KEY,
  global_pause INTEGER NOT NULL DEFAULT 0 CHECK(global_pause IN (0,1)),
  global_pause_reason TEXT,
  independent_kill INTEGER NOT NULL DEFAULT 0 CHECK(independent_kill IN (0,1)),
  independent_kill_reason TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
