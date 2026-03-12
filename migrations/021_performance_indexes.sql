-- Performance indexes + retry_after column for backoff enforcement

-- Add retry_after column for exponential backoff (was a no-op setTimeout before)
ALTER TABLE actions ADD COLUMN retry_after TEXT;

-- Anomaly detection: event_type filtering on collaboration_events
CREATE INDEX IF NOT EXISTS idx_collab_events_type
  ON collaboration_events(event_type);

-- Anomaly detection: action_id lookups for citation checks
CREATE INDEX IF NOT EXISTS idx_collab_events_action
  ON collaboration_events(action_id);

-- Reports + briefs: completed_at filtering for recent completions
CREATE INDEX IF NOT EXISTS idx_actions_completed_at
  ON actions(completed_at);

-- Anomaly dedup: compound lookup by type + sim_day
CREATE INDEX IF NOT EXISTS idx_anomaly_type_day
  ON governance_anomalies(anomaly_type, sim_day);

-- Actions: dequeue hot path (agent + status + phase)
CREATE INDEX IF NOT EXISTS idx_actions_dequeue
  ON actions(agent_id, status, phase);

-- Governance events: filtering by type + agent
CREATE INDEX IF NOT EXISTS idx_gov_events_type_agent
  ON governance_events(event_type, agent_id);

-- Spot check failures: escalation query (agent + type + sim_day)
CREATE INDEX IF NOT EXISTS idx_spot_check_agent_type
  ON spot_check_failures(agent_id, check_type, sim_day);
