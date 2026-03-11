-- Worktrees for parallel agent development
CREATE TABLE IF NOT EXISTS worktrees (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT NOT NULL REFERENCES actions(id),
  branch_name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','merged','abandoned','conflict')),
  conflict_with TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  merged_at TEXT,
  merge_commit TEXT
);

-- File lock tracking for conflict prevention
CREATE TABLE IF NOT EXISTS worktree_file_locks (
  worktree_id TEXT NOT NULL REFERENCES worktrees(id),
  file_path TEXT NOT NULL,
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (worktree_id, file_path)
);
