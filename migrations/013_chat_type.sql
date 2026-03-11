-- Add 'chat' and 'meeting' to allowed action types
-- SQLite doesn't support ALTER CHECK, so we recreate the constraint via a new table

-- Step 1: Create new table with updated constraint
CREATE TABLE actions_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  type TEXT NOT NULL
    CHECK(type IN ('research','build','write','decide','communicate','spend','pause','resume','help','review','chat','meeting')),
  description TEXT NOT NULL,
  status TEXT DEFAULT 'queued'
    CHECK(status IN ('queued','running','proposed_complete','completed','failed','cancelled','verification_failed')),
  phase INTEGER NOT NULL DEFAULT 1,
  input TEXT,
  output TEXT,
  expected_output_path TEXT,
  expected_schema TEXT,
  verification_status TEXT,
  verification_notes TEXT,
  retry_count INTEGER DEFAULT 0,
  started_at TEXT,
  completed_at TEXT
);

-- Step 2: Copy data
INSERT INTO actions_new SELECT
  id, agent_id, type, description, status, phase, input, output,
  expected_output_path, expected_schema, verification_status, verification_notes,
  retry_count, started_at, completed_at
FROM actions;

-- Step 3: Swap
DROP TABLE actions;
ALTER TABLE actions_new RENAME TO actions;

-- Step 4: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_actions_agent_id ON actions(agent_id);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_actions_phase ON actions(phase);
