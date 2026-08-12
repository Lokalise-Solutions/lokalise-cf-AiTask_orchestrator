CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  import_fingerprint TEXT NOT NULL,
  branch TEXT,
  filename TEXT,
  status TEXT NOT NULL,
  lokalise_task_id INTEGER,
  github_dispatch_status TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, import_fingerprint)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE run_keys (
  run_id TEXT NOT NULL,
  key_id INTEGER NOT NULL,
  PRIMARY KEY (run_id, key_id)
);

CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_events_project ON events(project_id, received_at);
CREATE INDEX idx_runs_status ON runs(status);