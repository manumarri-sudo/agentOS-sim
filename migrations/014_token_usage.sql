-- Token usage tracking per task
-- Stores ACTUAL token counts from Claude CLI --output-format json response
CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  model TEXT NOT NULL,                          -- 'haiku', 'sonnet', 'opus'
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_input_usd REAL NOT NULL DEFAULT 0.0,     -- computed from real pricing
  cost_output_usd REAL NOT NULL DEFAULT 0.0,
  cost_cache_write_usd REAL NOT NULL DEFAULT 0.0,
  cost_cache_read_usd REAL NOT NULL DEFAULT 0.0,
  cost_total_usd REAL NOT NULL DEFAULT 0.0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  phase INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'actual',         -- 'actual' (from CLI JSON) or 'estimated' (fallback)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_phase ON token_usage(phase);
CREATE INDEX IF NOT EXISTS idx_token_usage_task ON token_usage(task_id);
