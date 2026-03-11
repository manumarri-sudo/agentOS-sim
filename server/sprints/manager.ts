import { getDb } from '../db/database'
import { sendMessage, broadcastMessage } from '../messages/bus'
import { logActivity } from '../activity'
import { getSimDay } from '../clock'
import { generatePerformanceScorecard } from '../performance/tracker'
import { runRosterReview } from '../performance/roster'

// ---------------------------------------------------------------------------
// Sprint Manager -- structured cadence for the experiment
//
// A sprint is 100 orchestrator cycles (~30 min real-time).
// At sprint start: assign goals, notify agents.
// At sprint end: snapshot performance, generate report, cleanup stale tasks.
// ---------------------------------------------------------------------------

const SPRINT_LENGTH_CYCLES = 100

export function getCurrentSprint(): { id: string; number: number; phase: number; goal: string; started_at: string } | null {
  const db = getDb()
  return db.query(`
    SELECT id, number, phase, goal, started_at
    FROM sprints WHERE status = 'active' LIMIT 1
  `).get() as any
}

export function shouldStartNewSprint(cycleCount: number): boolean {
  const current = getCurrentSprint()
  if (!current) return true // no active sprint

  const db = getDb()
  // Count cycles since sprint started (approximate via task completions)
  const sprintAge = db.query(`
    SELECT COUNT(*) as n FROM actions
    WHERE sprint_id = ? AND status IN ('completed', 'failed')
  `).get(current.id) as { n: number }

  // Also check wall-clock: if sprint is > 45 minutes old, end it
  const startTime = new Date(current.started_at + 'Z').getTime()
  const elapsed = Date.now() - startTime
  const minutesElapsed = elapsed / 60000

  return minutesElapsed > 45
}

export function startSprint(phase: number): string {
  const db = getDb()
  const simDay = getSimDay()

  // End current sprint if any
  const current = getCurrentSprint()
  if (current) {
    endSprint(current.id)
  }

  // Get next sprint number
  const last = db.query(`SELECT MAX(number) as n FROM sprints`).get() as { n: number | null }
  const number = (last.n ?? 0) + 1

  // Determine sprint goal from phase + queued work
  const queuedCount = db.query(`
    SELECT COUNT(*) as n FROM actions WHERE phase = ? AND status = 'queued'
  `).get(phase) as { n: number }

  const phaseInfo = db.query(`SELECT name FROM experiment_phases WHERE phase_number = ?`).get(phase) as { name: string }
  const goal = `Sprint ${number} -- Phase ${phase} (${phaseInfo?.name ?? 'Unknown'}): ${queuedCount.n} tasks queued`

  const id = crypto.randomUUID()
  db.run(`
    INSERT INTO sprints (id, number, phase, goal, tasks_planned, status)
    VALUES (?, ?, ?, ?, ?, 'active')
  `, [id, number, phase, goal, queuedCount.n])

  // Tag queued tasks with this sprint
  db.run(`
    UPDATE actions SET sprint_id = ?
    WHERE phase = ? AND status = 'queued' AND sprint_id IS NULL
  `, [id, phase])

  // Notify Morgan (PM) to manage this sprint
  sendMessage({
    fromAgentId: 'system',
    toAgentId: 'morgan',
    subject: `Sprint ${number} started`,
    body: `New sprint started. Goal: ${goal}\n\n${queuedCount.n} tasks are assigned to this sprint. Track completion, enforce handoffs, and flag any blocked agents.`,
    priority: 'high',
  })

  // Broadcast sprint start to all agents
  broadcastMessage(
    'system',
    `Sprint ${number} started`,
    `Sprint ${number} is now active. Phase: ${phaseInfo?.name}. Focus on completing your assigned tasks and using [HANDOFF] tags when passing work downstream.`,
    'normal',
  )

  logActivity({
    agentId: 'system',
    phase,
    eventType: 'sprint_started',
    summary: `Sprint ${number} started: ${goal}`,
  })

  console.log(`[SPRINT] Sprint ${number} started: ${goal}`)
  return id
}

export function endSprint(sprintId: string): void {
  const db = getDb()

  const sprint = db.query(`SELECT * FROM sprints WHERE id = ?`).get(sprintId) as any
  if (!sprint || sprint.status !== 'active') return

  // Count completed tasks in this sprint
  const stats = db.query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM actions WHERE sprint_id = ?
  `).get(sprintId) as { total: number; completed: number; failed: number }

  db.run(`
    UPDATE sprints SET status = 'completed', ended_at = datetime('now'), tasks_completed = ?
    WHERE id = ?
  `, [stats.completed ?? 0, sprintId])

  // Generate sprint report
  generateSprintReport(sprintId, sprint.number, sprint.phase, stats)

  // Generate performance scorecards for all agents this sprint
  try {
    generatePerformanceScorecard(sprintId, sprint.phase)
    runRosterReview(sprintId, sprint.phase)
  } catch (e) {
    console.error('[SPRINT] Performance/roster error:', e)
  }

  // Cancel stale queued tasks from this sprint (they'll be re-planned in next sprint)
  // Only cancel if they've been sitting for the entire sprint
  const stale = db.run(`
    UPDATE actions SET status = 'cancelled', completed_at = datetime('now')
    WHERE sprint_id = ? AND status = 'queued' AND type IN ('review', 'meeting')
  `, [sprintId])

  logActivity({
    agentId: 'system',
    phase: sprint.phase,
    eventType: 'sprint_ended',
    summary: `Sprint ${sprint.number} ended: ${stats.completed}/${stats.total} completed, ${stats.failed} failed, ${stale.changes} stale tasks cancelled`,
  })

  console.log(`[SPRINT] Sprint ${sprint.number} ended: ${stats.completed}/${stats.total} tasks, ${stale.changes} stale cancelled`)
}

function generateSprintReport(sprintId: string, sprintNumber: number, phase: number, stats: { total: number; completed: number; failed: number }): void {
  const db = getDb()
  const simDay = getSimDay()

  // Per-agent stats for this sprint
  const agentStats = db.query(`
    SELECT a.agent_id, ag.personality_name, ag.team,
      COUNT(*) as total,
      SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN a.status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.sprint_id = ?
    GROUP BY a.agent_id
    ORDER BY completed DESC
  `).all(sprintId) as any[]

  // Active blockers
  const blockers = db.query(`
    SELECT ba.reason, ag.personality_name
    FROM blocked_agents ba
    JOIN agents ag ON ag.id = ba.agent_id
    WHERE ba.resolved_at IS NULL
  `).all() as any[]

  // Budget
  const budget = db.query(`
    SELECT SUM(amount) as total FROM budget_entries
  `).get() as { total: number }

  const teamReports = agentStats.map((a: any) =>
    `${a.personality_name} (${a.team}): ${a.completed}/${a.total} completed, ${a.failed} failed`
  ).join('\n')

  const blockerText = blockers.length > 0
    ? blockers.map((b: any) => `${b.personality_name}: ${b.reason.slice(0, 100)}`).join('\n')
    : 'None'

  const summary = `Sprint ${sprintNumber} Report (Phase ${phase})\n\nDelivery: ${stats.completed}/${stats.total} tasks completed (${stats.failed} failed)\nBlockers: ${blockers.length}\nBudget remaining: $${budget?.total ?? 0}`

  db.run(`
    INSERT INTO experiment_reports (id, trigger_type, phase, author_agent, summary, team_reports, blockers, budget_remaining, created_at)
    VALUES (?, 'sprint_review', ?, 'morgan', ?, ?, ?, ?, datetime('now'))
  `, [
    crypto.randomUUID(),
    phase,
    summary,
    teamReports,
    blockerText,
    budget?.total ?? 0,
  ])

  console.log(`[SPRINT] Report generated for Sprint ${sprintNumber}`)
}

// Called from orchestrator main loop
export function checkSprintBoundary(cycleCount: number, phase: number): void {
  const current = getCurrentSprint()

  if (!current) {
    // No active sprint -- start one
    startSprint(phase)
    return
  }

  if (shouldStartNewSprint(cycleCount)) {
    startSprint(phase)
  }
}
