-- 016_reports_expand.sql
-- Expand experiment_reports trigger_type to include sprint_review and performance_review

CREATE TABLE IF NOT EXISTS experiment_reports_new (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL
    CHECK(trigger_type IN ('phase_complete','revenue_event','blocker_escalation','final','sprint_review','performance_review','status_update')),
  phase INTEGER,
  author_agent TEXT NOT NULL,
  summary TEXT NOT NULL,
  team_reports TEXT,
  decisions TEXT,
  blockers TEXT,
  budget_spent REAL,
  budget_remaining REAL,
  revenue_to_date REAL,
  next_priority TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO experiment_reports_new SELECT * FROM experiment_reports;
DROP TABLE experiment_reports;
ALTER TABLE experiment_reports_new RENAME TO experiment_reports;
