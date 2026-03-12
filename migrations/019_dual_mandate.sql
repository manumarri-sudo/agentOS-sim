-- 019_dual_mandate.sql
-- Dual Mandate Overhaul: Governance Immune System + Revenue Engine

-- 1. Funnel events for conversion tracking (UnitEconomicsPanel)
CREATE TABLE IF NOT EXISTS funnel_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(event_type IN ('view','click','add_to_cart','checkout','purchase')),
  source_channel TEXT,
  marketing_queue_id TEXT,
  revenue_amount REAL DEFAULT 0,
  agent_id TEXT,
  metadata TEXT,
  sim_day INTEGER NOT NULL DEFAULT 0,
  phase INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_funnel_channel ON funnel_events(source_channel);
CREATE INDEX IF NOT EXISTS idx_funnel_type ON funnel_events(event_type);

-- 2. Marketing channel metrics (UnitEconomicsPanel + ROI Kill-Switches)
CREATE TABLE IF NOT EXISTS marketing_channel_metrics (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  spend_usd REAL NOT NULL DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  revenue_usd REAL DEFAULT 0,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  sim_day INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mktchan_channel ON marketing_channel_metrics(channel);

-- 3. Anomaly detection log (Governance Immune System)
CREATE TABLE IF NOT EXISTS governance_anomalies (
  id TEXT PRIMARY KEY,
  anomaly_type TEXT NOT NULL CHECK(anomaly_type IN (
    'phantom_citation','false_approval','circular_reasoning','budget_delusion'
  )),
  agent_id TEXT,
  details TEXT NOT NULL,
  evidence TEXT,
  severity TEXT NOT NULL DEFAULT 'warning',
  resolved INTEGER NOT NULL DEFAULT 0,
  sim_day INTEGER NOT NULL DEFAULT 0,
  cfs_penalty_applied REAL DEFAULT 0,
  tier_downgrade_applied INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_anomaly_agent ON governance_anomalies(agent_id);
CREATE INDEX IF NOT EXISTS idx_anomaly_type ON governance_anomalies(anomaly_type);

-- 4. ROI enforcement log (Campaign Kill-Switches)
CREATE TABLE IF NOT EXISTS roi_enforcement_log (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  agent_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('warning','block','unblock')),
  reason TEXT NOT NULL,
  spend_usd REAL,
  clicks INTEGER,
  sim_day INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5. Add permanent flag to collaboration_events (Rainmaker CFS bonus)
-- SQLite ADD COLUMN is idempotent-safe if wrapped carefully
ALTER TABLE collaboration_events ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0;

-- 6. Expand governance_events CHECK constraint for new event types
CREATE TABLE IF NOT EXISTS governance_events_v3 (
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
    'unauthorized_access',
    'anomaly_detected',
    'roi_enforcement'
  )),
  agent_id TEXT,
  details TEXT NOT NULL,
  route TEXT,
  severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','warning','critical')),
  escalated INTEGER NOT NULL DEFAULT 0,
  sim_day INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO governance_events_v3 SELECT * FROM governance_events;
DROP TABLE governance_events;
ALTER TABLE governance_events_v3 RENAME TO governance_events;
CREATE INDEX IF NOT EXISTS idx_gov_events_type ON governance_events(event_type);
CREATE INDEX IF NOT EXISTS idx_gov_events_agent ON governance_events(agent_id);
