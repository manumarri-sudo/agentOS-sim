-- Migration 011: Fix worktree_file_locks, worktrees CHECK, and add usage_budget table

-- 1. Recreate worktree_file_locks with id PRIMARY KEY and agent_id column
CREATE TABLE IF NOT EXISTS worktree_file_locks_new (
  id TEXT PRIMARY KEY,
  worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  file_path TEXT NOT NULL,
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (worktree_id, file_path)
);

INSERT OR IGNORE INTO worktree_file_locks_new (id, worktree_id, agent_id, file_path, locked_at)
  SELECT worktree_id, worktree_id, worktree_id, file_path, locked_at
  FROM worktree_file_locks;

DROP TABLE IF EXISTS worktree_file_locks;
ALTER TABLE worktree_file_locks_new RENAME TO worktree_file_locks;

-- 2. Recreate worktrees with 'pruned' added to status CHECK constraint
CREATE TABLE IF NOT EXISTS worktrees_new (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT NOT NULL REFERENCES actions(id),
  branch_name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','merged','abandoned','conflict','pruned')),
  conflict_with TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  merged_at TEXT,
  merge_commit TEXT
);

INSERT OR IGNORE INTO worktrees_new
  SELECT * FROM worktrees;

DROP TABLE IF EXISTS worktrees;
ALTER TABLE worktrees_new RENAME TO worktrees;

-- Recreate indexes on worktrees
CREATE INDEX IF NOT EXISTS idx_worktrees_agent ON worktrees(agent_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_status ON worktrees(status);

-- 3. Create usage_budget table for weekly budget tracking (doc 8)
CREATE TABLE IF NOT EXISTS usage_budget (
  week_number INTEGER NOT NULL,
  week_start TEXT NOT NULL UNIQUE,
  week_end TEXT NOT NULL,
  sonnet_hours_budget REAL NOT NULL DEFAULT 200,
  sonnet_hours_used REAL NOT NULL DEFAULT 0,
  sonnet_hours_reserved REAL NOT NULL DEFAULT 40,
  opus_hours_budget REAL NOT NULL DEFAULT 16,
  opus_hours_used REAL NOT NULL DEFAULT 0,
  opus_hours_reserved REAL NOT NULL DEFAULT 8,
  throttle_level INTEGER NOT NULL DEFAULT 0
    CHECK(throttle_level IN (0, 1, 2, 3, 4)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
