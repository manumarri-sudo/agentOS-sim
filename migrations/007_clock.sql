-- Simulation clock (event-driven, not calendar)
CREATE TABLE IF NOT EXISTS sim_clock (
  id INTEGER PRIMARY KEY DEFAULT 1,
  sim_day INTEGER NOT NULL DEFAULT 0,
  last_advanced_at TEXT NOT NULL DEFAULT (datetime('now')),
  advanced_by TEXT NOT NULL DEFAULT 'system',
  real_start TEXT NOT NULL DEFAULT (datetime('now'))
);
