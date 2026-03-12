import { getDb } from '../db/database'
import { sendMessage, broadcastMessage } from '../messages/bus'
import { logActivity } from '../activity'
import { getSimDay } from '../clock'
import { generatePerformanceScorecard } from '../performance/tracker'
import { runRosterReview } from '../performance/roster'
import { logPhaseReportToNotion } from '../notion/sync'

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

  // Broadcast sprint start to all agents (includes Morgan)
  broadcastMessage(
    'system',
    `Sprint ${number} started`,
    `Sprint ${number} is now active. Phase: ${phaseInfo?.name}. Goal: ${goal}\n\n${queuedCount.n} tasks assigned. Focus on completing your assigned tasks and using [HANDOFF] tags when passing work downstream.`,
    'high',
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

  // Also gather phase-wide stats if sprint-specific is empty
  const phaseStats = agentStats.length === 0
    ? db.query(`
        SELECT a.agent_id, ag.personality_name, ag.team,
          COUNT(*) as total,
          SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN a.status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM actions a
        JOIN agents ag ON ag.id = a.agent_id
        WHERE a.phase = ?
        GROUP BY a.agent_id
        ORDER BY completed DESC
      `).all(phase) as any[]
    : agentStats

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

  const tokenSpend = db.query(`
    SELECT COALESCE(SUM(cost_total_usd), 0) as cost FROM token_usage
  `).get() as { cost: number }

  // Build readable team reports
  const teams = new Map<string, string[]>()
  for (const a of phaseStats) {
    if (!teams.has(a.team)) teams.set(a.team, [])
    teams.get(a.team)!.push(
      `  ${a.personality_name}: ${a.completed}/${a.total} done` +
      (a.failed > 0 ? ` (${a.failed} failed)` : '')
    )
  }
  let teamReports = ''
  for (const [team, lines] of teams) {
    teamReports += `${team.toUpperCase()}:\n${lines.join('\n')}\n\n`
  }

  const blockerText = blockers.length > 0
    ? blockers.map((b: any) => `${b.personality_name}: ${b.reason.slice(0, 120)}`).join('\n')
    : null

  // Compute actual totals from phase if sprint stats are empty
  const actualCompleted = stats.completed || phaseStats.reduce((s: number, a: any) => s + (a.completed ?? 0), 0)
  const actualTotal = stats.total || phaseStats.reduce((s: number, a: any) => s + (a.total ?? 0), 0)
  const actualFailed = stats.failed || phaseStats.reduce((s: number, a: any) => s + (a.failed ?? 0), 0)
  const rate = actualTotal > 0 ? Math.round((actualCompleted / actualTotal) * 100) : 0

  const summary = `Sprint ${sprintNumber} Review -- Day ${simDay}, Phase ${phase}\n\n` +
    `Delivery: ${actualCompleted}/${actualTotal} tasks completed (${rate}% success rate)\n` +
    `Failures: ${actualFailed}\n` +
    `Blockers: ${blockers.length} unresolved\n` +
    `Budget: $${(budget?.total ?? 200).toFixed(2)} remaining, $${tokenSpend.cost.toFixed(2)} spent on tokens`

  db.run(`
    INSERT INTO experiment_reports
      (id, trigger_type, phase, author_agent, summary, team_reports, blockers,
       budget_spent, budget_remaining, revenue_to_date, next_priority)
    VALUES (?, 'sprint_review', ?, 'morgan', ?, ?, ?, ?, ?, 0, ?)
  `, [
    `sprint-${sprintNumber}-p${phase}-${Date.now()}`,
    phase,
    summary,
    teamReports || null,
    blockerText,
    tokenSpend.cost,
    budget?.total ?? 200,
    blockers.length > 0
      ? `Resolve ${blockers.length} blockers before next sprint`
      : actualFailed > actualCompleted
        ? `Failure rate too high -- investigate root causes`
        : `Continue execution. ${rate}% completion rate.`,
  ])

  // Sync to Notion
  logPhaseReportToNotion('sprint_review', phase, getSimDay(), summary, teamReports || null,
    blockers.length > 0
      ? `Resolve ${blockers.length} blockers before next sprint`
      : `Continue execution. ${rate}% completion rate.`)

  console.log(`[SPRINT] Report generated for Sprint ${sprintNumber}: ${actualCompleted}/${actualTotal} tasks`)
}

// Called from orchestrator main loop
export function checkSprintBoundary(cycleCount: number, phase: number): void {
  const current = getCurrentSprint()

  if (!current) {
    startSprint(phase)
    planSprintTasks(phase)
    return
  }

  if (shouldStartNewSprint(cycleCount)) {
    startSprint(phase)
    planSprintTasks(phase)
  }
}

// Generate dynamic tasks at sprint start based on completed work
function planSprintTasks(phase: number): void {
  try {
    const { generateDynamicTasks } = require('../intelligence/analyzer')
    const { enqueueTask } = require('../tasks/queue')

    const tasks = generateDynamicTasks(phase)
    let created = 0
    for (const t of tasks) {
      const id = enqueueTask(t)
      if (id) created++
    }
    if (created > 0) {
      console.log(`[SPRINT] Planned ${created} dynamic tasks for new sprint (Phase ${phase})`)
    }
  } catch (e) {
    console.error('[SPRINT] Dynamic task planning error:', e)
  }
}
