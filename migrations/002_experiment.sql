-- Experiment phases
CREATE TABLE IF NOT EXISTS experiment_phases (
  phase_number INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','active','complete','killed')),
  quorum_met INTEGER NOT NULL DEFAULT 0,
  ready_declared_by TEXT,
  ready_declared_at TEXT,
  ceo_approved INTEGER DEFAULT 0,
  human_approved INTEGER DEFAULT 0,
  advance_argument TEXT,
  objections TEXT,
  agent_deadline TEXT,
  deadline_set_by TEXT,
  deadline_rationale TEXT,
  deadline_updated_count INTEGER DEFAULT 0,
  original_deadline TEXT,
  beat_deadline INTEGER DEFAULT 0,
  early_by_minutes INTEGER,
  started_at TEXT,
  completed_at TEXT,
  approved_by TEXT,
  notes TEXT
);

-- Experiment reports (triggered, not weekly)
CREATE TABLE IF NOT EXISTS experiment_reports (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL
    CHECK(trigger_type IN ('phase_complete','revenue_event','blocker_escalation','final')),
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

-- Token usage windows
CREATE TABLE IF NOT EXISTS usage_windows (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  date TEXT NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  daily_ceiling INTEGER NOT NULL DEFAULT 50000,
  reset_at TEXT NOT NULL
);

-- Heartbeat
CREATE TABLE IF NOT EXISTS heartbeat (
  id INTEGER PRIMARY KEY DEFAULT 1,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
