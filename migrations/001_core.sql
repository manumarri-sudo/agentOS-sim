-- Schema migrations tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agents
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  personality_name TEXT,
  name TEXT,
  team TEXT NOT NULL CHECK(team IN ('exec','strategy','tech','ops','marketing')),
  role TEXT NOT NULL,
  tier INTEGER NOT NULL DEFAULT 0 CHECK(tier IN (0,1,2,3)),
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK(status IN ('idle','working','paused','rate_limited','suspended','blocked')),
  system_prompt TEXT,
  personality_summary TEXT,
  urgency INTEGER DEFAULT 5,
  urgency_reason TEXT,
  domain_knowledge_version TEXT DEFAULT 'v1',
  domain_knowledge_loaded_at TEXT,
  notion_page_id TEXT,
  token_budget_today INTEGER NOT NULL DEFAULT 50000,
  token_budget_remaining INTEGER NOT NULL DEFAULT 50000,
  collaboration_score REAL NOT NULL DEFAULT 0.0,
  capability_tier INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Actions (append-only — never UPDATE a row here except status)
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL
    CHECK(type IN ('research','build','write','decide','communicate','spend','pause','resume','help','review')),
  description TEXT NOT NULL,
  input TEXT,
  output TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','completed','failed','cancelled')),
  token_cost INTEGER,
  phase INTEGER NOT NULL,
  retry_count INTEGER DEFAULT 0,
  gdrive_url TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  cited_by TEXT,
  files_changed TEXT,
  key_decisions TEXT
);

-- Inter-agent messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  to_agent_id TEXT,
  to_team TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK(priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK(status IN ('sent','read','actioned','ignored')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Budget ledger (append-only)
CREATE TABLE IF NOT EXISTS budget_entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  amount REAL NOT NULL,
  category TEXT NOT NULL
    CHECK(category IN ('infra','marketing','tooling','contingency','reserve')),
  description TEXT,
  notes TEXT,
  receipt TEXT,
  approved_by TEXT,
  requires_cross_approval INTEGER NOT NULL DEFAULT 0,
  cross_approved_by TEXT,
  phase INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Budget category ownership
CREATE TABLE IF NOT EXISTS budget_category_owners (
  category TEXT PRIMARY KEY,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id)
);

-- Decisions
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  made_by_agent TEXT NOT NULL REFERENCES agents(id),
  ratified_by TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  impact TEXT NOT NULL CHECK(impact IN ('team','cross_team','exec','external')),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK(status IN ('proposed','approved','rejected','superseded')),
  phase INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
