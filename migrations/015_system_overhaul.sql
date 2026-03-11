-- 015_system_overhaul.sql
-- Fixes: dedup persistence, sprint system, performance tracking, blocker Notion sync

-- Persistent interaction dedup keys (replaces in-memory Set)
CREATE TABLE IF NOT EXISTS interaction_keys (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sprint system
CREATE TABLE IF NOT EXISTS sprints (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  phase INTEGER NOT NULL,
  goal TEXT NOT NULL,
  tasks_planned INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);

-- Agent performance scorecards (per sprint)
CREATE TABLE IF NOT EXISTS agent_performance (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  sprint_id TEXT REFERENCES sprints(id),
  tasks_assigned INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  delivery_rate REAL NOT NULL DEFAULT 0,
  cfs_score REAL NOT NULL DEFAULT 0,
  blocker_count INTEGER NOT NULL DEFAULT 0,
  review_quality_avg REAL NOT NULL DEFAULT 0,
  handoff_rate REAL NOT NULL DEFAULT 0,
  overall_grade TEXT NOT NULL DEFAULT 'C' CHECK(overall_grade IN ('A', 'B', 'C', 'D', 'F')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_perf_agent ON agent_performance(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_perf_sprint ON agent_performance(sprint_id);

-- Roster changes (hiring/reassignment/promotion history)
CREATE TABLE IF NOT EXISTS roster_changes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  change_type TEXT NOT NULL CHECK(change_type IN ('warning', 'reassignment', 'promotion', 'hired', 'deactivated')),
  old_config TEXT,
  new_config TEXT,
  reason TEXT NOT NULL,
  sprint_id TEXT REFERENCES sprints(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Add Notion page tracking to blocked_agents
ALTER TABLE blocked_agents ADD COLUMN notion_page_id TEXT;

-- Add sprint_id to actions (tasks)
ALTER TABLE actions ADD COLUMN sprint_id TEXT REFERENCES sprints(id);
