-- Marketing content queue with human approval gate
CREATE TABLE IF NOT EXISTS marketing_queue (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  subreddit TEXT,
  title TEXT,
  body TEXT NOT NULL,
  target_url TEXT,
  agent_id TEXT REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK(status IN ('pending_approval','approved','rejected','posted','failed')),
  approved_by TEXT,
  post_url TEXT,
  agent_rationale TEXT,
  source_url TEXT,
  expected_reach TEXT,
  confidence INTEGER,
  subreddit_karma_check TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  posted_at TEXT
);
