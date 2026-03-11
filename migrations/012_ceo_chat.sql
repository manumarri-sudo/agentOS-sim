-- CEO Chat — direct communication between human operator and Reza (CEO agent)
-- Also supports Reza sending alerts/notifications to the human

CREATE TABLE IF NOT EXISTS ceo_chat (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL CHECK(sender IN ('human', 'reza')),
  message TEXT NOT NULL,
  message_type TEXT DEFAULT 'chat' CHECK(message_type IN ('chat', 'alert', 'phase_request', 'decision', 'approval_needed')),
  phase INTEGER,
  sim_day INTEGER,
  read_by_human INTEGER DEFAULT 0,
  read_by_reza INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ceo_chat_created ON ceo_chat(created_at);
CREATE INDEX IF NOT EXISTS idx_ceo_chat_unread ON ceo_chat(read_by_human) WHERE read_by_human = 0;
