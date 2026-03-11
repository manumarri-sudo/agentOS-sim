-- Velocity tracking per phase per agent
CREATE TABLE IF NOT EXISTS agent_velocity (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  phase INTEGER NOT NULL,
  assessment_number INTEGER NOT NULL,
  tasks_completed_at_assessment INTEGER NOT NULL,
  avg_task_duration_minutes REAL NOT NULL,
  remaining_tasks_estimate INTEGER NOT NULL,
  proposed_phase_duration_hours REAL NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('low','medium','high')),
  rationale TEXT NOT NULL,
  actual_phase_duration_hours REAL,
  estimate_accuracy_pct REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
