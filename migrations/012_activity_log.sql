-- Activity log: human-readable one-liners for every agent interaction
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sim_day INTEGER NOT NULL DEFAULT 0,
  phase INTEGER NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  other_agent_id TEXT REFERENCES agents(id),
  event_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_log_day ON activity_log(sim_day);
CREATE INDEX IF NOT EXISTS idx_activity_log_agent ON activity_log(agent_id);
