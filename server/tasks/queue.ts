import { getDb } from '../db/database'

export interface Task {
  id: string
  agent_id: string
  type: string
  description: string
  phase: number
  status: string
  input?: string
  expectedFiles?: string[]
}

// Enqueue a new task for an agent
// priority: if true, task is placed at top of queue (started_at set to epoch)
// Built-in dedup: rejects if agent already has a task with same description prefix
// in the same phase (any status). This is the SINGLE chokepoint for all task creation.
export function enqueueTask(params: {
  agentId: string
  type: string
  description: string
  phase: number
  input?: string
  priority?: boolean
}): string | null {
  const db = getDb()

  // Dedup: check if this agent already has a task with matching description in this phase
  // Exempt 'chat' tasks -- each human message is unique even with same prefix
  if (params.type !== 'chat') {
    const descPrefix = params.description.slice(0, 80)
    const existing = db.query(`
      SELECT id, status FROM actions
      WHERE agent_id = ? AND phase = ? AND substr(description, 1, 80) = ?
      LIMIT 1
    `).get(params.agentId, params.phase, descPrefix) as { id: string; status: string } | null

    if (existing) {
      console.log(`[QUEUE:DEDUP] Blocked duplicate for ${params.agentId} (existing ${existing.id} ${existing.status}): ${descPrefix.slice(0, 60)}...`)
      return null
    }
  }

  const id = crypto.randomUUID()

  // Priority tasks get a started_at of epoch so they sort first in dequeue
  // (dequeue ORDER BY started_at ASC -- NULL sorts after epoch)
  const startedAt = params.priority ? '1970-01-01T00:00:00' : null

  db.run(`
    INSERT INTO actions (id, agent_id, type, description, phase, status, input, started_at)
    VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
  `, [id, params.agentId, params.type, params.description, params.phase, params.input ?? null, startedAt])

  return id
}

// Dequeue the next task for an agent (respects phase gating + blocker check)
export function dequeueTask(agentId: string, currentPhase: number): Task | null {
  const db = getDb()

  // Safety net: never dispatch to a blocked agent (defense-in-depth with getReadyAgents filter)
  const agentStatus = db.query(`SELECT status FROM agents WHERE id = ?`).get(agentId) as { status: string } | null
  if (agentStatus?.status === 'blocked') return null

  const task = db.query(`
    SELECT * FROM actions
    WHERE agent_id = ? AND status = 'queued' AND phase <= ?
      AND (retry_after IS NULL OR retry_after <= datetime('now'))
    ORDER BY
      started_at ASC
    LIMIT 1
  `).get(agentId, currentPhase) as Task | null

  if (task) {
    db.run(`UPDATE actions SET status = 'running', started_at = datetime('now') WHERE id = ?`, [task.id])
  }

  return task
}

// Get all queued tasks for a phase
export function getQueuedTasks(phase: number): Task[] {
  const db = getDb()
  return db.query(`
    SELECT a.*, ag.personality_name as agent_name
    FROM actions a
    JOIN agents ag ON a.agent_id = ag.id
    WHERE a.status = 'queued' AND a.phase = ?
    ORDER BY a.started_at ASC
  `).all(phase) as Task[]
}

// Complete a task
export function completeTask(taskId: string, output: string): void {
  const db = getDb()
  db.run(`
    UPDATE actions SET status = 'completed', output = ?, completed_at = datetime('now')
    WHERE id = ?
  `, [output, taskId])
}

// Fail a task
export function failTask(taskId: string, error: string): void {
  const db = getDb()
  db.run(`
    UPDATE actions SET status = 'failed', output = ?, completed_at = datetime('now')
    WHERE id = ?
  `, [error, taskId])
}

// Get task counts by status
export function getTaskStats(): Record<string, number> {
  const db = getDb()
  const stats = db.query(`
    SELECT status, COUNT(*) as count FROM actions GROUP BY status
  `).all() as { status: string; count: number }[]

  const result: Record<string, number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
  for (const s of stats) {
    result[s.status] = s.count
  }
  return result
}

// Seed initial Phase 1 tasks
export function seedPhase1Tasks(): void {
  const db = getDb()

  // Check if Phase 1 tasks already exist
  const existing = db.query(
    `SELECT COUNT(*) as c FROM actions WHERE phase = 1`
  ).get() as { c: number }

  if (existing.c > 0) {
    console.log('  Phase 1 tasks already exist, skipping')
    return
  }

  const phase1Tasks = [
    // Strategy team drives Phase 1
    {
      agentId: 'zara',
      type: 'research',
      description: 'Scrape Gumroad trending products (top 100 by revenue, filter <6 months old). Identify digital products in the $0-$50 range with strong sales signals.',
    },
    {
      agentId: 'zara',
      type: 'research',
      description: 'Scrape Product Hunt launches from last 90 days, filter $0-$50 pricing. Note products with high engagement and clear pain points addressed.',
    },
    {
      agentId: 'zara',
      type: 'research',
      description: 'Mine Reddit: r/SideProject, r/entrepreneur, r/SaaS, r/passive_income. Search for "I wish there was a tool that..." posts and complaint threads about existing tools.',
    },
    {
      agentId: 'zara',
      type: 'research',
      description: 'Mine Twitter/X: search "I\'ll pay for X" + "why is there no tool for X". Collect evidence of willingness to pay.',
    },
    {
      agentId: 'zara',
      type: 'write',
      description: 'Compile all research into OpportunityVault with 20+ raw opportunities. Each entry must include: exact source, exact quote, what they currently do instead, and why that is annoying.',
    },
    // Nina runs in parallel
    {
      agentId: 'nina',
      type: 'research',
      description: 'For each top-10 opportunity from Zara\'s initial research: find the community (Reddit/Discord), collect exact customer language, note price anchors, note existing tool complaints.',
    },
    {
      agentId: 'nina',
      type: 'write',
      description: 'Produce voice-of-customer report: 5-8 validated pain signals, each with exact quote, source, date, and what the person is currently doing instead.',
    },
    // Marcus scores after research is in
    {
      agentId: 'marcus',
      type: 'research',
      description: 'Score all 20+ opportunities from OpportunityVault on the 5-dimension matrix: willingness-to-pay (0-25), build feasibility (0-20), AI unfair advantage (0-20), distribution clarity (0-20), competition gap (0-15). Hard reject any with WTP < 12.',
    },
    {
      agentId: 'marcus',
      type: 'write',
      description: 'Produce final scoring report with top 3 opportunities ranked. Include scoring breakdown and rationale for each. Bottom 17+ archived.',
    },
  ]

  for (const task of phase1Tasks) {
    enqueueTask({ ...task, phase: 1 })
  }

  console.log(`  ✓ ${phase1Tasks.length} Phase 1 tasks seeded`)
}
