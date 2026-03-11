import { getDb } from '../db/database'
import { broadcastAGUI } from '../orchestrator'
import { sendMessage } from '../messages/bus'

// ---------------------------------------------------------------------------
// Merge Manager — doc 3
//
// Handles merging agent worktree branches into main in ~/experiment-product/.
// Runs QA validation before merge. Handles conflicts by notifying agents.
//
// Flow:
//   1. Agent signals completion (task status = completed)
//   2. Merge manager picks up completed worktrees
//   3. Runs validation (bun test, lint)
//   4. Attempts merge to main
//   5. On conflict: notifies both agents, sets worktree status to 'conflict'
//   6. On success: sets worktree status to 'merged', prunes branch
// ---------------------------------------------------------------------------

const PRODUCT_REPO = process.env.PRODUCT_REPO_PATH ?? `${process.env.HOME}/experiment-product`
const MAX_ACTIVE_WORKTREES = 6

function run(cmd: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return {
    ok: result.exitCode === 0,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

// ---------------------------------------------------------------------------
// Create a worktree for an agent
// ---------------------------------------------------------------------------
export function createWorktree(agentId: string, taskId: string): {
  created: boolean
  path?: string
  branch?: string
  reason?: string
} {
  const db = getDb()

  // Check active worktree count
  const active = db.query(`
    SELECT COUNT(*) as n FROM worktrees WHERE status = 'active'
  `).get() as { n: number }

  if (active.n >= MAX_ACTIVE_WORKTREES) {
    return { created: false, reason: `Max ${MAX_ACTIVE_WORKTREES} active worktrees reached` }
  }

  // Get agent info
  const agent = db.query(`SELECT team, personality_name FROM agents WHERE id = ?`).get(agentId) as {
    team: string
    personality_name: string
  } | null

  if (!agent) return { created: false, reason: 'Agent not found' }

  const branchName = `${agent.team}-${agentId}-${taskId.slice(0, 8)}`
  const worktreePath = `${PRODUCT_REPO}/.worktrees/${branchName}`

  // Create the worktree
  const result = run(['git', 'worktree', 'add', '-b', branchName, worktreePath, 'main'], PRODUCT_REPO)

  if (!result.ok) {
    return { created: false, reason: `git worktree add failed: ${result.stderr}` }
  }

  // Record in DB
  const id = crypto.randomUUID()
  db.run(`
    INSERT INTO worktrees (id, agent_id, task_id, branch_name, path, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `, [id, agentId, taskId, branchName, worktreePath])

  console.log(`[WORKTREE] Created ${branchName} at ${worktreePath} for ${agent.personality_name}`)

  return { created: true, path: worktreePath, branch: branchName }
}

// ---------------------------------------------------------------------------
// Attempt to merge a completed worktree into main
// ---------------------------------------------------------------------------
export function attemptMerge(worktreeId: string): {
  merged: boolean
  reason?: string
} {
  const db = getDb()

  const worktree = db.query(`
    SELECT w.*, a.personality_name FROM worktrees w
    JOIN agents a ON w.agent_id = a.id
    WHERE w.id = ?
  `).get(worktreeId) as any

  if (!worktree) return { merged: false, reason: 'Worktree not found' }
  if (worktree.status !== 'active') return { merged: false, reason: `Worktree status is ${worktree.status}` }

  // Run tests in worktree
  const testResult = run(['bun', 'test'], worktree.path)
  if (!testResult.ok) {
    return { merged: false, reason: `Tests failed: ${testResult.stderr.slice(0, 300)}` }
  }

  // Switch to main and merge
  const mergeResult = run(['git', 'merge', '--no-ff', worktree.branch_name, '-m',
    `Merge ${worktree.branch_name}: ${worktree.personality_name}`], PRODUCT_REPO)

  if (!mergeResult.ok) {
    if (mergeResult.stderr.includes('CONFLICT')) {
      // Abort the merge
      run(['git', 'merge', '--abort'], PRODUCT_REPO)

      db.run(`UPDATE worktrees SET status = 'conflict' WHERE id = ?`, [worktreeId])

      // Notify the agent
      sendMessage({
        fromAgentId: 'system',
        toAgentId: worktree.agent_id,
        subject: `Merge conflict: ${worktree.branch_name}`,
        body: `Your branch ${worktree.branch_name} has conflicts with main. Please resolve and re-submit.`,
        priority: 'high',
      })

      broadcastAGUI({
        type: 'STATE_DELTA',
        subtype: 'MERGE_CONFLICT',
        agentId: worktree.agent_id,
        branch: worktree.branch_name,
      })

      return { merged: false, reason: 'Merge conflict' }
    }

    return { merged: false, reason: `Merge failed: ${mergeResult.stderr.slice(0, 300)}` }
  }

  // Success — clean up
  db.run(`UPDATE worktrees SET status = 'merged', merged_at = datetime('now') WHERE id = ?`, [worktreeId])

  // Prune worktree
  run(['git', 'worktree', 'remove', worktree.path], PRODUCT_REPO)
  run(['git', 'branch', '-d', worktree.branch_name], PRODUCT_REPO)

  broadcastAGUI({
    type: 'STATE_DELTA',
    subtype: 'MERGE_SUCCESS',
    agentId: worktree.agent_id,
    branch: worktree.branch_name,
  })

  console.log(`[WORKTREE] Merged ${worktree.branch_name} to main`)

  return { merged: true }
}

// ---------------------------------------------------------------------------
// Declare file intent (conflict prevention)
// ---------------------------------------------------------------------------
export function declareFile(agentId: string, filePath: string): {
  declared: boolean
  conflict?: { agentId: string; worktreeId: string }
} {
  const db = getDb()

  // Check if another active worktree has this file
  const existing = db.query(`
    SELECT wfl.agent_id, wfl.worktree_id
    FROM worktree_file_locks wfl
    JOIN worktrees w ON wfl.worktree_id = w.id
    WHERE wfl.file_path = ? AND w.status = 'active' AND wfl.agent_id != ?
  `).get(filePath, agentId) as { agent_id: string; worktree_id: string } | null

  if (existing) {
    return {
      declared: false,
      conflict: { agentId: existing.agent_id, worktreeId: existing.worktree_id },
    }
  }

  // Get agent's active worktree
  const worktree = db.query(`
    SELECT id FROM worktrees WHERE agent_id = ? AND status = 'active' ORDER BY rowid DESC LIMIT 1
  `).get(agentId) as { id: string } | null

  if (!worktree) {
    return { declared: false }
  }

  db.run(`
    INSERT OR REPLACE INTO worktree_file_locks (id, worktree_id, agent_id, file_path)
    VALUES (?, ?, ?, ?)
  `, [crypto.randomUUID(), worktree.id, agentId, filePath])

  return { declared: true }
}

// ---------------------------------------------------------------------------
// Clean up stale worktrees (>2 hours inactive)
// ---------------------------------------------------------------------------
export function cleanupStaleWorktrees(): number {
  const db = getDb()
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

  const stale = db.query(`
    SELECT id, path, branch_name FROM worktrees
    WHERE status = 'active' AND created_at < ?
  `).all(twoHoursAgo) as any[]

  let cleaned = 0
  for (const w of stale) {
    try {
      run(['git', 'worktree', 'remove', '--force', w.path], PRODUCT_REPO)
      run(['git', 'branch', '-D', w.branch_name], PRODUCT_REPO)
      db.run(`UPDATE worktrees SET status = 'pruned' WHERE id = ?`, [w.id])
      cleaned++
    } catch {
      // Ignore cleanup errors
    }
  }

  if (cleaned > 0) {
    console.log(`[WORKTREE] Cleaned up ${cleaned} stale worktrees`)
  }

  return cleaned
}
