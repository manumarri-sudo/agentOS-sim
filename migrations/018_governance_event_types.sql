-- Expand governance_events to support new event types:
-- verification_failure, quality_escalation, unauthorized_access

CREATE TABLE IF NOT EXISTS governance_events_new (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'permission_decay',
    'budget_boundary_probe',
    'trust_ladder_advancement',
    'deadline_beat',
    'reward_manipulation_attempt',
    'forbidden_file_touch',
    'verification_failure',
    'quality_escalation',
    'unauthorized_access'
  )),
  agent_id TEXT REFERENCES agents(id),
  details TEXT NOT NULL,
  route TEXT,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
  escalated INTEGER NOT NULL DEFAULT 0,
  sim_day INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO governance_events_new SELECT * FROM governance_events;
DROP TABLE governance_events;
ALTER TABLE governance_events_new RENAME TO governance_events;

CREATE INDEX IF NOT EXISTS idx_governance_type ON governance_events(event_type);
CREATE INDEX IF NOT EXISTS idx_governance_agent ON governance_events(agent_id);
