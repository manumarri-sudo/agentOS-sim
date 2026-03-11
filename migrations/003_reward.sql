-- Collaboration events
CREATE TABLE IF NOT EXISTS collaboration_events (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  to_agent_id TEXT NOT NULL REFERENCES agents(id),
  event_type TEXT NOT NULL
    CHECK(event_type IN (
      'output_cited',
      'blocker_resolved',
      'cross_approval',
      'message_actioned',
      'decision_ratified',
      'help_provided',
      'deadline_beat',
      'deadline_pull_in',
      'deadline_revision_accurate',
      'scope_expansion',
      'slam_dunk'
    )),
  action_id TEXT REFERENCES actions(id),
  phase INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Revenue attribution
CREATE TABLE IF NOT EXISTS revenue_attribution (
  id TEXT PRIMARY KEY,
  revenue_event_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  attribution_share REAL NOT NULL,
  contributing_action_ids TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Capability tiers
CREATE TABLE IF NOT EXISTS capability_tiers (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  tier INTEGER NOT NULL DEFAULT 0,
  unlocked_at TEXT,
  token_multiplier REAL NOT NULL DEFAULT 1.0,
  queue_priority INTEGER NOT NULL DEFAULT 5,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id)
);

-- Phase gate quorum tracking
CREATE TABLE IF NOT EXISTS phase_quorum (
  phase INTEGER NOT NULL,
  team TEXT NOT NULL,
  contributed INTEGER NOT NULL DEFAULT 0,
  contribution_action_id TEXT REFERENCES actions(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (phase, team)
);

-- Phase-specific quorum config
CREATE TABLE IF NOT EXISTS phase_quorum_config (
  phase INTEGER NOT NULL,
  required_teams TEXT NOT NULL,
  PRIMARY KEY (phase)
);

-- Blocked agent log
CREATE TABLE IF NOT EXISTS blocked_agents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  reason TEXT NOT NULL,
  help_request_broadcast INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT REFERENCES agents(id),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent debates
CREATE TABLE IF NOT EXISTS agent_debates (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  initiator_id TEXT REFERENCES agents(id),
  responder_id TEXT REFERENCES agents(id),
  initiator_position TEXT NOT NULL,
  responder_position TEXT,
  resolution TEXT,
  resolved_by TEXT REFERENCES agents(id),
  phase INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
