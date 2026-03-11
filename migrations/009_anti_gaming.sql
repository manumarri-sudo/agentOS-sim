-- Migration 009: Anti-gaming layer tables
-- Phase 5: Verifier, spot checks, auth tokens, governance

-- Spot check failures accumulator
CREATE TABLE IF NOT EXISTS spot_check_failures (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  action_id TEXT NOT NULL REFERENCES actions(id),
  check_type TEXT NOT NULL CHECK(check_type IN ('content_depth','output_trace','commit_substance','source_check')),
  details TEXT,
  sim_day INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_spot_check_agent ON spot_check_failures(agent_id, check_type);

-- Add verification columns to actions table
ALTER TABLE actions ADD COLUMN verification_status TEXT CHECK(verification_status IN ('pending','passed','failed')) DEFAULT NULL;
ALTER TABLE actions ADD COLUMN verification_notes TEXT DEFAULT NULL;
ALTER TABLE actions ADD COLUMN expected_output_path TEXT DEFAULT NULL;
ALTER TABLE actions ADD COLUMN expected_schema TEXT DEFAULT NULL;

-- Governance log entries (structured, queryable mirror of logs/governance.log)
CREATE TABLE IF NOT EXISTS governance_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'permission_decay','budget_boundary_probe','trust_ladder_advancement',
    'deadline_beat','reward_manipulation_attempt','forbidden_file_touch'
  )),
  agent_id TEXT REFERENCES agents(id),
  details TEXT NOT NULL,
  route TEXT,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
  escalated INTEGER NOT NULL DEFAULT 0,
  sim_day INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_governance_type ON governance_events(event_type);
CREATE INDEX IF NOT EXISTS idx_governance_agent ON governance_events(agent_id);

-- Agent session tokens (for auth)
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_token ON agent_sessions(token);

-- Note: advance_argument and objections already exist from 002_experiment.sql

-- Spot check support columns on actions
ALTER TABLE actions ADD COLUMN cited_sources TEXT DEFAULT NULL;
ALTER TABLE actions ADD COLUMN tool_calls TEXT DEFAULT NULL;
