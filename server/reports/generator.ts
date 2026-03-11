import { getDb } from '../db/database'
import { logActivity } from '../activity'

// ---------------------------------------------------------------------------
// Report Generator -- populates experiment_reports table
//
// Trigger types:
// - sprint_review: end of sprint summary
// - status_update: periodic status (every N orchestrator cycles)
// - phase_complete: phase advancement
// - performance_review: per-agent performance at sprint boundary
// - blocker_escalation: when blockers pile up
// ---------------------------------------------------------------------------

function genId(): string {
  return `rpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function getPhase(): number {
  const db = getDb()
  const p = db.query(`SELECT phase_number FROM experiment_phases WHERE status = 'active' LIMIT 1`).get() as { phase_number: number } | null
  return p?.phase_number ?? 2
}

function getSimDay(): number {
  const db = getDb()
  const c = db.query(`SELECT sim_day FROM sim_clock WHERE id = 1`).get() as { sim_day: number } | null
  return c?.sim_day ?? 0
}

// ---------------------------------------------------------------------------
// Generate a status report (called periodically or on demand)
// ---------------------------------------------------------------------------
export function generateStatusReport(): void {
  const db = getDb()
  const phase = getPhase()
  const simDay = getSimDay()

  const taskStats = db.query(`
    SELECT status, COUNT(*) as n FROM actions WHERE phase = ? GROUP BY status
  `).all(phase) as { status: string; n: number }[]

  const agentStats = db.query(`
    SELECT status, COUNT(*) as n FROM agents GROUP BY status
  `).all() as { status: string; n: number }[]

  const blockerCount = db.query(`
    SELECT COUNT(*) as n FROM blocked_agents WHERE resolved_at IS NULL
  `).get() as { n: number }

  const budget = db.query(`
    SELECT SUM(amount) as spent FROM budget_entries WHERE amount < 0
  `).get() as { spent: number | null }

  const budgetRemaining = db.query(`
    SELECT SUM(amount) as remaining FROM budget_entries
  `).get() as { remaining: number | null }

  const recentDecisions = db.query(`
    SELECT title, made_by_agent, status FROM decisions
    WHERE phase = ? ORDER BY created_at DESC LIMIT 5
  `).all(phase) as { title: string; made_by_agent: string; status: string }[]

  const recentBlockers = db.query(`
    SELECT ba.reason, ag.personality_name, ba.resolved_at
    FROM blocked_agents ba
    JOIN agents ag ON ag.id = ba.agent_id
    ORDER BY ba.created_at DESC LIMIT 5
  `).all() as { reason: string; personality_name: string; resolved_at: string | null }[]

  const taskSummary = taskStats.map(t => `${t.status}: ${t.n}`).join(', ')
  const agentSummary = agentStats.map(a => `${a.status}: ${a.n}`).join(', ')

  const summary = `Status Report -- Day ${simDay}, Phase ${phase}\n` +
    `Tasks: ${taskSummary}\n` +
    `Agents: ${agentSummary}\n` +
    `Open blockers: ${blockerCount.n}\n` +
    `Budget spent: $${Math.abs(budget.spent ?? 0).toFixed(2)}, remaining: $${(budgetRemaining.remaining ?? 0).toFixed(2)}`

  const decisionsJson = recentDecisions.length > 0
    ? JSON.stringify(recentDecisions)
    : null

  const blockersJson = recentBlockers.length > 0
    ? JSON.stringify(recentBlockers)
    : null

  db.run(`
    INSERT INTO experiment_reports (id, trigger_type, phase, author_agent, summary, team_reports, decisions, blockers, budget_spent, budget_remaining, revenue_to_date, next_priority)
    VALUES (?, 'status_update', ?, 'morgan', ?, ?, ?, ?, ?, ?, 0, ?)
  `, [
    genId(),
    phase,
    summary,
    JSON.stringify({ agents: agentStats, tasks: taskStats }),
    decisionsJson,
    blockersJson,
    Math.abs(budget.spent ?? 0),
    budgetRemaining.remaining ?? 0,
    blockerCount.n > 0 ? 'Resolve blockers' : 'Continue sprint execution',
  ])

  logActivity({
    agentId: 'morgan',
    phase,
    eventType: 'status_report',
    summary: `Morgan generated status report: Day ${simDay}, ${blockerCount.n} blockers, ${taskStats.find(t => t.status === 'completed')?.n ?? 0} tasks completed`,
  })

  console.log(`[REPORTS] Status report generated -- Day ${simDay}, Phase ${phase}`)
}

// ---------------------------------------------------------------------------
// Backfill opportunities from existing completed research/scoring tasks
// ---------------------------------------------------------------------------
export function backfillOpportunities(): void {
  const db = getDb()
  const phase = getPhase()

  // Check if decisions table already has entries
  const existing = db.query(`SELECT COUNT(*) as n FROM decisions`).get() as { n: number }
  if (existing.n > 0) return // already populated

  // Look for Marcus/Zara completed research tasks with scoring language
  const scoringTasks = db.query(`
    SELECT a.id, a.agent_id, ag.personality_name, a.description, a.output, a.phase
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.status = 'completed'
      AND a.agent_id IN ('marcus', 'zara', 'dani')
      AND a.type IN ('research', 'write', 'decide')
      AND (a.output LIKE '%score%' OR a.output LIKE '%opportunity%' OR a.output LIKE '%recommend%' OR a.output LIKE '%format%')
    ORDER BY a.completed_at DESC
    LIMIT 5
  `).all() as any[]

  if (scoringTasks.length === 0) return

  for (const task of scoringTasks) {
    const title = extractTitle(task.description, task.personality_name)
    const body = (task.output ?? '').slice(0, 2000)

    db.run(`
      INSERT OR IGNORE INTO decisions (id, made_by_agent, title, body, impact, status, phase, created_at)
      VALUES (?, ?, ?, ?, 'opportunity_score', 'proposed', ?, datetime('now'))
    `, [
      `dec-backfill-${task.id.slice(0, 8)}`,
      task.agent_id,
      title,
      body,
      task.phase,
    ])
  }

  console.log(`[REPORTS] Backfilled ${scoringTasks.length} opportunities from completed research`)
}

function extractTitle(description: string, agentName: string): string {
  // Try to get a meaningful title from the first line of description
  const firstLine = description.split('\n')[0].replace(/^(RESEARCH|WRITE|DECIDE):?\s*/i, '').trim()
  if (firstLine.length > 10 && firstLine.length < 120) return firstLine
  return `${agentName}'s analysis`
}

// ---------------------------------------------------------------------------
// Check if we should generate a status report (every ~50 cycles)
// ---------------------------------------------------------------------------
let lastReportCycle = 0
export function checkReportGeneration(cycleCount: number): void {
  if (cycleCount - lastReportCycle >= 50) {
    generateStatusReport()
    lastReportCycle = cycleCount
  }
}
