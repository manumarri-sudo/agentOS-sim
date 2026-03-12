import { getDb } from '../db/database'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getRemainingBudget, PHASE_SPEND_CEILINGS } from '../budget/enforcer'

// ---------------------------------------------------------------------------
// Daily Brief Generator -- Cognitive State Management for 30-day runs
//
// Generates a synthesized project state brief at each sim_day boundary.
// The brief is:
//   1. Stored in daily_briefs table (queryable)
//   2. Written to logs/state/STATE_OF_THE_UNION.md (human readable)
//   3. Injected into every agent's context file (via memory.ts)
//
// This prevents agents from losing coherence over multi-day runs by giving
// them a consistent, up-to-date view of project state.
// ---------------------------------------------------------------------------

const STATE_DIR = join(process.cwd(), 'logs', 'state')

// Ensure state directory exists
if (!existsSync(STATE_DIR)) {
  mkdirSync(STATE_DIR, { recursive: true })
}

// Phase goal descriptions (static reference)
const PHASE_GOALS: Record<number, string> = {
  1: 'Complete research and discover a viable product opportunity',
  2: 'Define strategy, business model, and go-to-market plan',
  3: 'Build the core product (MVP)',
  4: 'Launch to market and acquire first customers',
  5: 'Optimize, iterate based on feedback, and scale revenue',
}

// ---------------------------------------------------------------------------
// Generate the daily brief for a given sim_day
// ---------------------------------------------------------------------------
export function generateDailyBrief(simDay: number, phase: number): string {
  const db = getDb()

  // Check if brief already exists for this day
  const existing = db.query(`SELECT brief_content FROM daily_briefs WHERE sim_day = ?`).get(simDay) as { brief_content: string } | null
  if (existing) return existing.brief_content

  // --- Gather data ---

  // Get previous sim_day's brief timestamp for scoping queries
  const prevBrief = db.query(`
    SELECT created_at FROM daily_briefs WHERE sim_day = ? LIMIT 1
  `).get(simDay - 1) as { created_at: string } | null
  const sinceTime = prevBrief?.created_at ?? new Date(Date.now() - 8 * 3600_000).toISOString()

  // Completions since last brief (sim_day-aware, not wall-clock)
  const completions = db.query(`
    SELECT a.description, ag.personality_name, a.type, a.completed_at
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.status = 'completed'
      AND a.completed_at >= ?
    ORDER BY a.completed_at DESC
    LIMIT 15
  `).all(sinceTime) as Array<{ description: string; personality_name: string; type: string; completed_at: string }>

  // Active blockers -- derived from blocked/escalated actions (no standalone blockers table)
  let blockers: Array<{ description: string; personality_name: string; severity: string }> = []
  try {
    blockers = db.query(`
      SELECT a.description, ag.personality_name,
        CASE WHEN a.status = 'escalated' THEN 'high' ELSE 'medium' END as severity
      FROM actions a
      JOIN agents ag ON ag.id = a.agent_id
      WHERE a.status IN ('blocked', 'escalated')
      ORDER BY a.created_at DESC
      LIMIT 10
    `).all() as Array<{ description: string; personality_name: string; severity: string }>
  } catch (_) {
    // Table may not exist -- degrade gracefully
  }

  // Failed tasks since last brief
  const failures = db.query(`
    SELECT a.description, ag.personality_name, a.retry_count
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.status IN ('failed', 'escalated')
      AND a.completed_at >= ?
    LIMIT 5
  `).all(sinceTime) as Array<{ description: string; personality_name: string; retry_count: number }>

  // Key decisions since last brief
  const decisions = db.query(`
    SELECT d.title, d.made_by_agent as decided_by, d.body as decision_text
    FROM decisions d
    WHERE d.created_at >= ?
    ORDER BY d.created_at DESC
    LIMIT 5
  `).all(sinceTime) as Array<{ title: string; decided_by: string; decision_text: string }>

  // Budget state
  const remaining = getRemainingBudget()
  const phaseCeiling = PHASE_SPEND_CEILINGS[phase] ?? 200
  const phaseSpent = db.query(`
    SELECT COALESCE(SUM(ABS(amount)), 0) as spent
    FROM budget_entries WHERE phase = ? AND amount < 0
  `).get(phase) as { spent: number }

  // Agent health (suspended or struggling agents)
  const suspendedAgents = db.query(`
    SELECT ag.personality_name, ag.status
    FROM agents ag
    WHERE ag.status = 'suspended'
  `).all() as Array<{ personality_name: string; status: string }>

  // Queued work count
  const queuedCount = (db.query(`
    SELECT COUNT(*) as n FROM actions WHERE phase = ? AND status = 'queued'
  `).get(phase) as { n: number }).n

  // --- Build brief ---

  const phaseGoal = PHASE_GOALS[phase] ?? 'Continue experiment'

  const achievementsList: string[] = completions.slice(0, 5).map(c =>
    `${c.personality_name} completed ${c.type}: ${c.description.slice(0, 80)}`
  )

  const blockersList: string[] = blockers.map(b =>
    `[${b.severity}] ${b.personality_name}: ${b.description.slice(0, 80)}`
  )

  let brief = `# State of the Union -- Sim Day ${simDay}, Phase ${phase}\n\n`
  brief += `**Phase Goal**: ${phaseGoal}\n\n`

  // Paragraph 1: Progress summary
  brief += `## Progress\n`
  if (completions.length > 0) {
    brief += `${completions.length} tasks completed since last brief. `
    brief += `Key completions:\n`
    for (const a of achievementsList) {
      brief += `- ${a}\n`
    }
  } else {
    brief += `No tasks completed in the last cycle. Focus on unblocking any stuck work.\n`
  }
  if (decisions.length > 0) {
    brief += `\n${decisions.length} decision(s) made:\n`
    for (const d of decisions) {
      brief += `- **${d.title}** (by ${d.decided_by})\n`
    }
  }
  brief += `\n`

  // Paragraph 2: Blockers and risks
  brief += `## Blockers & Risks\n`
  if (blockers.length > 0) {
    for (const b of blockersList) {
      brief += `- ${b}\n`
    }
  } else {
    brief += `No active blockers. Clear path forward.\n`
  }
  if (failures.length > 0) {
    brief += `\n${failures.length} task failure(s):\n`
    for (const f of failures) {
      brief += `- ${f.personality_name}: ${f.description.slice(0, 60)} (${f.retry_count} retries)\n`
    }
  }
  if (suspendedAgents.length > 0) {
    brief += `\n**Suspended agents**: ${suspendedAgents.map(a => a.personality_name).join(', ')}\n`
  }
  brief += `\n`

  // Paragraph 3: Resources and priorities
  brief += `## Resources & Next Steps\n`
  brief += `- **Budget**: $${remaining.toFixed(2)} remaining ($${phaseSpent.spent.toFixed(2)} / $${phaseCeiling} spent in Phase ${phase})\n`
  brief += `- **Queue**: ${queuedCount} tasks queued for Phase ${phase}\n`
  brief += `- **Priority**: ${blockers.length > 0 ? 'Resolve blockers before starting new work.' : 'Continue executing against phase goal.'}\n`

  // --- Persist ---
  const id = crypto.randomUUID()
  db.run(`
    INSERT INTO daily_briefs (id, sim_day, phase, brief_content, achievements, blockers, phase_goal)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    id, simDay, phase,
    brief,
    JSON.stringify(achievementsList),
    JSON.stringify(blockersList),
    phaseGoal,
  ])

  // Write to filesystem
  try {
    writeFileSync(join(STATE_DIR, 'STATE_OF_THE_UNION.md'), brief)
  } catch (e) {
    console.error('[BRIEF] Failed to write STATE_OF_THE_UNION.md:', e)
  }

  console.log(`[BRIEF] Generated daily brief for Sim Day ${simDay}, Phase ${phase}`)

  return brief
}

// ---------------------------------------------------------------------------
// Get the latest brief from DB
// ---------------------------------------------------------------------------
export function getLatestBrief(): { sim_day: number; content: string } | null {
  const db = getDb()

  const row = db.query(`
    SELECT sim_day, brief_content as content FROM daily_briefs
    ORDER BY sim_day DESC LIMIT 1
  `).get() as { sim_day: number; content: string } | null

  return row
}

// ---------------------------------------------------------------------------
// Get brief for a specific day
// ---------------------------------------------------------------------------
export function getBriefForDay(simDay: number): string | null {
  const db = getDb()

  const row = db.query(`
    SELECT brief_content FROM daily_briefs WHERE sim_day = ?
  `).get(simDay) as { brief_content: string } | null

  return row?.brief_content ?? null
}
