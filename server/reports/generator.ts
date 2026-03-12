import { getDb } from '../db/database'
import { logActivity } from '../activity'
import { getSimDay } from '../clock'
import { logPhaseReportToNotion } from '../notion/sync'

// ---------------------------------------------------------------------------
// Report Generator -- meaningful experiment reports, not spam
//
// RULES:
// 1. Max ONE status report per sim_day (dedup via sim_day, not wall-clock)
// 2. Reports contain narrative analysis, not raw counts
// 3. Per-team breakdowns with named agents and what they actually did
// 4. Decisions and blockers as readable text, not JSON blobs
// 5. Actionable next priorities based on actual state
// ---------------------------------------------------------------------------

function getPhase(): number {
  const db = getDb()
  const p = db.query(`SELECT phase_number FROM experiment_phases WHERE status = 'active' LIMIT 1`).get() as { phase_number: number } | null
  return p?.phase_number ?? 2
}

// ---------------------------------------------------------------------------
// Generate a status report -- max one per sim_day
// ---------------------------------------------------------------------------
export function generateStatusReport(): void {
  const db = getDb()
  const phase = getPhase()
  const simDay = getSimDay()

  // DEDUP: max one status report per sim_day (not wall-clock)
  const existing = db.query(`
    SELECT 1 FROM experiment_reports
    WHERE trigger_type = 'status_update' AND phase = ?
      AND id LIKE ?
  `).get(phase, `rpt-d${simDay}-%`)
  if (existing) return

  // --- Gather data ---

  // Task stats for this phase
  const taskStats = db.query(`
    SELECT status, COUNT(*) as n FROM actions WHERE phase = ? GROUP BY status
  `).all(phase) as { status: string; n: number }[]
  const taskMap: Record<string, number> = {}
  for (const t of taskStats) taskMap[t.status] = t.n

  const totalTasks = Object.values(taskMap).reduce((a, b) => a + b, 0)
  const completed = taskMap['completed'] ?? 0
  const failed = taskMap['failed'] ?? 0
  const queued = taskMap['queued'] ?? 0
  const running = taskMap['running'] ?? 0
  const cancelled = taskMap['cancelled'] ?? 0

  // Agent status breakdown
  const agentStatuses = db.query(`
    SELECT status, COUNT(*) as n FROM agents GROUP BY status
  `).all() as { status: string; n: number }[]

  // Per-team completions (what each team actually did)
  const teamWork = db.query(`
    SELECT ag.team, ag.personality_name, a.type,
      COUNT(*) as total,
      SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as done,
      SUM(CASE WHEN a.status = 'failed' THEN 1 ELSE 0 END) as fails
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.phase = ?
    GROUP BY ag.team, ag.personality_name
    ORDER BY ag.team, done DESC
  `).all(phase) as Array<{ team: string; personality_name: string; type: string; total: number; done: number; fails: number }>

  // Recent completions (last 5 meaningful ones)
  const recentWins = db.query(`
    SELECT ag.personality_name, a.type, substr(a.description, 1, 120) as desc
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.status = 'completed' AND a.phase = ?
    ORDER BY a.completed_at DESC LIMIT 5
  `).all(phase) as Array<{ personality_name: string; type: string; desc: string }>

  // Active blockers (unresolved)
  const blockers = db.query(`
    SELECT ba.reason, ag.personality_name
    FROM blocked_agents ba
    JOIN agents ag ON ag.id = ba.agent_id
    WHERE ba.resolved_at IS NULL
    ORDER BY ba.created_at DESC LIMIT 5
  `).all() as Array<{ reason: string; personality_name: string }>

  // Recent decisions
  const decisions = db.query(`
    SELECT d.title, ag.personality_name as by_name, d.status
    FROM decisions d
    LEFT JOIN agents ag ON ag.id = d.made_by_agent
    WHERE d.phase = ?
    ORDER BY d.created_at DESC LIMIT 5
  `).all(phase) as Array<{ title: string; by_name: string | null; status: string }>

  // Budget -- from budget_entries + token_usage
  const budgetEntries = db.query(`
    SELECT SUM(amount) as total FROM budget_entries
  `).get() as { total: number | null }

  const tokenSpend = db.query(`
    SELECT COALESCE(SUM(cost_total_usd), 0) as total_cost,
      COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
    FROM token_usage
  `).get() as { total_cost: number; total_tokens: number }

  const budgetRemaining = budgetEntries?.total ?? 200
  const budgetSpent = tokenSpend.total_cost

  // --- Build readable summary ---

  const completionRate = totalTasks > 0 ? Math.round((completed / totalTasks) * 100) : 0
  const failRate = totalTasks > 0 ? Math.round((failed / totalTasks) * 100) : 0

  let summary = `Day ${simDay} Status -- Phase ${phase}\n\n`
  summary += `Completion: ${completed}/${totalTasks} tasks (${completionRate}% success, ${failRate}% failure)\n`
  summary += `Pipeline: ${queued} queued, ${running} running, ${cancelled} cancelled\n`
  summary += `Tokens: ${tokenSpend.total_tokens.toLocaleString()} used ($${budgetSpent.toFixed(2)} spent)\n`
  summary += `Budget: $${budgetRemaining.toFixed(2)} remaining of $200\n`

  if (blockers.length > 0) {
    summary += `\nBLOCKERS: ${blockers.length} unresolved\n`
  }

  // --- Team reports (readable, not JSON) ---

  const teams = new Map<string, string[]>()
  for (const w of teamWork) {
    if (!teams.has(w.team)) teams.set(w.team, [])
    const line = `  ${w.personality_name}: ${w.done}/${w.total} done` +
      (w.fails > 0 ? ` (${w.fails} failed)` : '')
    teams.get(w.team)!.push(line)
  }

  let teamReportsText = ''
  for (const [team, lines] of teams) {
    teamReportsText += `${team.toUpperCase()}:\n${lines.join('\n')}\n\n`
  }

  // Recent wins
  if (recentWins.length > 0) {
    teamReportsText += 'RECENT COMPLETIONS:\n'
    for (const w of recentWins) {
      teamReportsText += `  ${w.personality_name} (${w.type}): ${w.desc}\n`
    }
  }

  // --- Blockers (readable) ---

  let blockersText: string | null = null
  if (blockers.length > 0) {
    blockersText = blockers.map(b =>
      `${b.personality_name}: ${b.reason.slice(0, 120)}`
    ).join('\n')
  }

  // --- Decisions (readable) ---

  let decisionsText: string | null = null
  if (decisions.length > 0) {
    decisionsText = decisions.map(d =>
      `[${d.status}] ${d.title} (${d.by_name ?? 'system'})`
    ).join('\n')
  }

  // --- Next priority (actually analyzed) ---

  let nextPriority = ''
  if (blockers.length >= 3) {
    nextPriority = `Critical: ${blockers.length} agents blocked. Unblock before new work.`
  } else if (failed > completed && totalTasks > 5) {
    nextPriority = `Warning: failure rate (${failRate}%) exceeds success rate. Investigate root causes before spawning more tasks.`
  } else if (queued === 0 && running === 0) {
    nextPriority = `Phase ${phase} queue is empty. Generate new tasks or advance phase.`
  } else if (budgetRemaining < 50) {
    nextPriority = `Budget critical: $${budgetRemaining.toFixed(2)} left. Prioritize revenue-generating work only.`
  } else {
    nextPriority = `On track. ${queued} tasks queued. Focus: ${completed > 0 ? 'maintain velocity' : 'get first completions'}.`
  }

  // --- Insert report ---

  db.run(`
    INSERT INTO experiment_reports
      (id, trigger_type, phase, author_agent, summary, team_reports, decisions, blockers,
       budget_spent, budget_remaining, revenue_to_date, next_priority)
    VALUES (?, 'status_update', ?, 'morgan', ?, ?, ?, ?, ?, ?, 0, ?)
  `, [
    `rpt-d${simDay}-p${phase}-${Date.now()}`,
    phase,
    summary,
    teamReportsText || null,
    decisionsText,
    blockersText,
    budgetSpent,
    budgetRemaining,
    nextPriority,
  ])

  logActivity({
    agentId: 'morgan',
    phase,
    eventType: 'status_report',
    summary: `Day ${simDay} report: ${completed}/${totalTasks} tasks, ${blockers.length} blockers, $${budgetSpent.toFixed(2)} spent`,
  })

  // Sync to Notion
  logPhaseReportToNotion('status_update', phase, simDay, summary, teamReportsText || null, nextPriority)

  console.log(`[REPORTS] Status report generated -- Day ${simDay}, Phase ${phase}`)
}

// ---------------------------------------------------------------------------
// Backfill opportunities from existing completed research/scoring tasks
// ---------------------------------------------------------------------------
export function backfillOpportunities(): void {
  const db = getDb()
  const phase = getPhase()

  const existing = db.query(`SELECT COUNT(*) as n FROM decisions`).get() as { n: number }
  if (existing.n > 0) return

  const scoringTasks = db.query(`
    SELECT a.id, a.agent_id, ag.personality_name, a.description, a.output, a.phase
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.status = 'completed'
      AND a.agent_id IN ('marcus', 'zara', 'dani')
      AND a.type IN ('research', 'write', 'decide')
      AND (a.output LIKE '%score%' OR a.output LIKE '%opportunity%' OR a.output LIKE '%recommend%')
    ORDER BY a.completed_at DESC
    LIMIT 5
  `).all() as any[]

  if (scoringTasks.length === 0) return

  for (const task of scoringTasks) {
    const firstLine = task.description.split('\n')[0].replace(/^(RESEARCH|WRITE|DECIDE):?\s*/i, '').trim()
    const title = (firstLine.length > 10 && firstLine.length < 120) ? firstLine : `${task.personality_name}'s analysis`
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

// ---------------------------------------------------------------------------
// Check if we should generate a status report
// Uses DB-based dedup instead of in-memory counter (survives restarts)
// ---------------------------------------------------------------------------
export function checkReportGeneration(_cycleCount: number): void {
  generateStatusReport()  // dedup is inside generateStatusReport via DB check
}
