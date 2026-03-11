import { getDb } from './db/database'
import { getSimDay } from './clock'

// ---------------------------------------------------------------------------
// Experiment Changelog -- records key events for weekly substack updates
//
// Every significant event gets logged: decisions, milestones, blockers,
// system changes, sprints, errors. Creates a narrative timeline.
// ---------------------------------------------------------------------------

type ChangelogEvent =
  | 'system_change' | 'agent_decision' | 'product_milestone' | 'blocker_resolved'
  | 'sprint_boundary' | 'performance_event' | 'human_intervention' | 'budget_event'
  | 'phase_change' | 'config_change' | 'error_resolved'

function genId(): string {
  return `clog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function logChangelog(params: {
  eventType: ChangelogEvent
  title: string
  details: string
  agentId?: string
  impact?: string
  phase?: number
}): void {
  const db = getDb()
  const simDay = getSimDay()
  const phase = params.phase ?? (db.query(`SELECT phase_number FROM experiment_phases WHERE status = 'active' LIMIT 1`).get() as any)?.phase_number ?? 0

  db.run(`
    INSERT INTO experiment_changelog (id, sim_day, phase, event_type, title, details, agent_id, impact)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [genId(), simDay, phase, params.eventType, params.title, params.details, params.agentId ?? null, params.impact ?? null])
}

export function getChangelog(options?: { limit?: number; eventType?: string; sinceDay?: number }): any[] {
  const db = getDb()

  let query = `SELECT * FROM experiment_changelog WHERE 1=1`
  const params: any[] = []

  if (options?.eventType) {
    query += ` AND event_type = ?`
    params.push(options.eventType)
  }
  if (options?.sinceDay) {
    query += ` AND sim_day >= ?`
    params.push(options.sinceDay)
  }

  query += ` ORDER BY created_at DESC LIMIT ?`
  params.push(options?.limit ?? 50)

  return db.query(query).all(...params) as any[]
}

// Generate a substack-ready summary of recent events
export function generateWeeklySummary(sinceDay?: number): string {
  const db = getDb()
  const simDay = getSimDay()
  const fromDay = sinceDay ?? Math.max(0, simDay - 7)

  const events = db.query(`
    SELECT * FROM experiment_changelog
    WHERE sim_day >= ?
    ORDER BY created_at ASC
  `).all(fromDay) as any[]

  if (events.length === 0) return 'No changelog events recorded.'

  const sections: Record<string, string[]> = {}
  for (const e of events) {
    const section = e.event_type.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
    if (!sections[section]) sections[section] = []
    sections[section].push(`- **Day ${e.sim_day}**: ${e.title}${e.impact ? ` (Impact: ${e.impact})` : ''}`)
  }

  let summary = `# Experiment Changelog (Day ${fromDay}-${simDay})\n\n`
  for (const [section, items] of Object.entries(sections)) {
    summary += `## ${section}\n${items.join('\n')}\n\n`
  }

  return summary
}
