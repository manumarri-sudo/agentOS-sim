-- 017_human_tasks.sql
-- Human task queue: agents can request human intervention
-- Experiment changelog: tracks all system changes for weekly updates

CREATE TABLE IF NOT EXISTS human_tasks (
  id TEXT PRIMARY KEY,
  requested_by TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK(urgency IN ('low', 'normal', 'high', 'critical')),
  category TEXT NOT NULL DEFAULT 'action' CHECK(category IN ('action', 'decision', 'access', 'review', 'unblock')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'dismissed')),
  resolution TEXT,
  phase INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_human_tasks_status ON human_tasks(status);

-- Experiment changelog for substack writeups
CREATE TABLE IF NOT EXISTS experiment_changelog (
  id TEXT PRIMARY KEY,
  sim_day INTEGER NOT NULL,
  phase INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'system_change', 'agent_decision', 'product_milestone', 'blocker_resolved',
    'sprint_boundary', 'performance_event', 'human_intervention', 'budget_event',
    'phase_change', 'config_change', 'error_resolved'
  )),
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  agent_id TEXT,
  impact TEXT, -- brief description of what this changed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_changelog_day ON experiment_changelog(sim_day);
CREATE INDEX IF NOT EXISTS idx_changelog_type ON experiment_changelog(event_type);
