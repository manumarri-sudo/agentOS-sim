-- Migration 020: 30-Day Endurance & Resilience Overhaul
-- Creates tables for: daily briefs, feasibility checks, daily spend tracking, citation rate limits
-- Recreates actions table (v4) to add failure_context column, 'escalated' status, 'spike' type

-- ---------------------------------------------------------------------------
-- 1. daily_briefs -- one row per sim_day, stores synthesized project state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_briefs (
  id TEXT PRIMARY KEY,
  sim_day INTEGER UNIQUE NOT NULL,
  phase INTEGER NOT NULL,
  brief_content TEXT NOT NULL,
  achievements TEXT DEFAULT '[]',   -- JSON array
  blockers TEXT DEFAULT '[]',       -- JSON array
  phase_goal TEXT,
  generated_at TEXT DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- 2. feasibility_checks -- spike task results gating Phase 2 -> 3
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feasibility_checks (
  id TEXT PRIMARY KEY,
  from_phase INTEGER NOT NULL,
  to_phase INTEGER NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  action_id TEXT REFERENCES actions(id),
  result TEXT DEFAULT 'pending' CHECK(result IN ('pass', 'fail', 'pending')),
  findings TEXT,
  risk_level TEXT CHECK(risk_level IN ('low', 'medium', 'high', 'blocker')),
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(from_phase, to_phase, agent_id)
);

-- ---------------------------------------------------------------------------
-- 3. daily_spend_tracking -- per-sim_day spend accumulator
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_spend_tracking (
  sim_day INTEGER PRIMARY KEY,
  total_spent REAL DEFAULT 0,
  daily_cap REAL DEFAULT 6.66,
  cap_overridden INTEGER DEFAULT 0,
  override_decision_id TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- 4. citation_rate_limits -- per-agent-per-phase citation counter
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS citation_rate_limits (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  phase INTEGER NOT NULL,
  citation_count INTEGER DEFAULT 0,
  cap INTEGER DEFAULT 20,
  last_updated TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, phase)
);

-- ---------------------------------------------------------------------------
-- 5. Recreate actions table (v4) to add failure_context, 'escalated' status, 'spike' type
--    SQLite does not support ALTER TABLE ADD CHECK constraint values, so we
--    must recreate the table.
-- ---------------------------------------------------------------------------

-- Step 1: Rename existing table
ALTER TABLE actions RENAME TO actions_v3;

-- Step 2: Create new table with expanded constraints + failure_context
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL
    CHECK(type IN ('research','build','write','decide','communicate','spend','pause','resume','help','review','chat','meeting','spike')),
  description TEXT NOT NULL,
  status TEXT DEFAULT 'queued'
    CHECK(status IN ('queued','running','proposed_complete','completed','failed','cancelled','verification_failed','escalated')),
  phase INTEGER NOT NULL DEFAULT 1,
  input TEXT,
  output TEXT,
  expected_output_path TEXT,
  expected_schema TEXT,
  verification_status TEXT,
  verification_notes TEXT,
  retry_count INTEGER DEFAULT 0,
  failure_context TEXT,
  started_at TEXT,
  completed_at TEXT,
  sprint_id TEXT REFERENCES sprints(id)
);

-- Step 3: Copy all existing data (failure_context will be NULL for existing rows)
INSERT INTO actions (
  id, agent_id, type, description, status, phase,
  input, output, expected_output_path, expected_schema,
  verification_status, verification_notes, retry_count,
  failure_context, started_at, completed_at, sprint_id
)
SELECT
  id, agent_id, type, description, status, phase,
  input, output, expected_output_path, expected_schema,
  verification_status, verification_notes, retry_count,
  NULL, started_at, completed_at, sprint_id
FROM actions_v3;

-- Step 4: Drop old table
DROP TABLE actions_v3;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_actions_agent_id ON actions(agent_id);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_phase ON actions(phase);
CREATE INDEX IF NOT EXISTS idx_actions_sprint ON actions(sprint_id);
CREATE INDEX IF NOT EXISTS idx_actions_phase_status ON actions(phase, status);

-- ---------------------------------------------------------------------------
-- 6. Indexes for new tables
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_daily_briefs_sim_day ON daily_briefs(sim_day);
CREATE INDEX IF NOT EXISTS idx_feasibility_checks_phase ON feasibility_checks(from_phase, to_phase);
CREATE INDEX IF NOT EXISTS idx_citation_rate_limits_agent ON citation_rate_limits(agent_id, phase);
CREATE INDEX IF NOT EXISTS idx_daily_spend_sim_day ON daily_spend_tracking(sim_day);
