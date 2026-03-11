-- Migration 010: Fix CHECK constraints for statuses used by verifier + opportunities

-- SQLite doesn't support ALTER TABLE ... DROP CONSTRAINT or ALTER CHECK.
-- We need to recreate the tables. For actions, we'll create a new table,
-- copy data, drop old, rename new.

-- Fix actions status to include proposed_complete and verification_failed
CREATE TABLE IF NOT EXISTS actions_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL
    CHECK(type IN ('research','build','write','decide','communicate','spend','pause','resume','help','review')),
  description TEXT NOT NULL,
  input TEXT,
  output TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','completed','failed','cancelled','proposed_complete','verification_failed')),
  token_cost INTEGER,
  phase INTEGER NOT NULL,
  retry_count INTEGER DEFAULT 0,
  gdrive_url TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  cited_by TEXT,
  files_changed TEXT,
  key_decisions TEXT,
  verification_status TEXT CHECK(verification_status IN ('pending','passed','failed')) DEFAULT NULL,
  verification_notes TEXT DEFAULT NULL,
  expected_output_path TEXT DEFAULT NULL,
  expected_schema TEXT DEFAULT NULL,
  cited_sources TEXT DEFAULT NULL,
  tool_calls TEXT DEFAULT NULL
);

INSERT OR IGNORE INTO actions_new
  SELECT id, agent_id, type, description, input, output, status, token_cost, phase,
         retry_count, gdrive_url, started_at, completed_at, cited_by, files_changed,
         key_decisions, verification_status, verification_notes, expected_output_path,
         expected_schema, cited_sources, tool_calls
  FROM actions;

DROP TABLE IF EXISTS actions;
ALTER TABLE actions_new RENAME TO actions;

-- Recreate indexes on actions
CREATE INDEX IF NOT EXISTS idx_actions_agent_id ON actions(agent_id);
CREATE INDEX IF NOT EXISTS idx_actions_phase ON actions(phase);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_agent_phase ON actions(agent_id, phase);

-- Fix decisions impact to include opportunity_score
CREATE TABLE IF NOT EXISTS decisions_new (
  id TEXT PRIMARY KEY,
  made_by_agent TEXT NOT NULL REFERENCES agents(id),
  ratified_by TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  impact TEXT NOT NULL CHECK(impact IN ('team','cross_team','exec','external','opportunity_score')),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK(status IN ('proposed','approved','rejected','superseded')),
  phase INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO decisions_new
  SELECT * FROM decisions;

DROP TABLE IF EXISTS decisions;
ALTER TABLE decisions_new RENAME TO decisions;

CREATE INDEX IF NOT EXISTS idx_decisions_agent ON decisions(made_by_agent);
CREATE INDEX IF NOT EXISTS idx_decisions_phase ON decisions(phase);

-- Fix usage_windows column names to match code
-- Code references: window_date, tokens_limit
-- Migration 002 has: date, daily_ceiling
CREATE TABLE IF NOT EXISTS usage_windows_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  window_date TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  tokens_limit INTEGER NOT NULL DEFAULT 50000,
  reset_at TEXT
);

INSERT OR IGNORE INTO usage_windows_new (id, agent_id, window_date, tokens_used, tokens_limit)
  SELECT id, agent_id, date, tokens_used, daily_ceiling FROM usage_windows;

DROP TABLE IF EXISTS usage_windows;
ALTER TABLE usage_windows_new RENAME TO usage_windows;
