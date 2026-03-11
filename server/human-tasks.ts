import { getDb } from './db/database'
import { logActivity } from './activity'

// ---------------------------------------------------------------------------
// Human Task Queue -- agents can request human intervention
//
// Agents signal [HUMAN_TASK] in their output to request help.
// Tasks appear in the dashboard for the human operator.
// Categories:
//   action   -- "Please do X" (e.g., share Notion DB)
//   decision -- "We need your input on X"
//   access   -- "We need access to X"
//   review   -- "Please review X"
//   unblock  -- "We're stuck, help"
// ---------------------------------------------------------------------------

function genId(): string {
  return `htask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function createHumanTask(params: {
  requestedBy: string
  title: string
  description: string
  urgency?: 'low' | 'normal' | 'high' | 'critical'
  category?: 'action' | 'decision' | 'access' | 'review' | 'unblock'
  phase: number
}): string {
  const db = getDb()
  const id = genId()

  db.run(`
    INSERT INTO human_tasks (id, requested_by, title, description, urgency, category, phase)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, params.requestedBy, params.title, params.description, params.urgency ?? 'normal', params.category ?? 'action', params.phase])

  const agentName = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(params.requestedBy) as any)?.personality_name ?? params.requestedBy

  logActivity({
    agentId: params.requestedBy,
    phase: params.phase,
    eventType: 'human_task_created',
    summary: `${agentName} requested human help: ${params.title}`,
  })

  console.log(`[HUMAN TASK] ${agentName} requests: ${params.title} (${params.urgency ?? 'normal'})`)

  return id
}

export function completeHumanTask(taskId: string, resolution: string): void {
  const db = getDb()

  db.run(`
    UPDATE human_tasks SET status = 'completed', resolution = ?, completed_at = datetime('now')
    WHERE id = ?
  `, [resolution, taskId])
}

export function getHumanTasks(status?: string): any[] {
  const db = getDb()

  if (status) {
    return db.query(`
      SELECT ht.*, ag.personality_name as requester_name
      FROM human_tasks ht
      JOIN agents ag ON ag.id = ht.requested_by
      WHERE ht.status = ?
      ORDER BY CASE ht.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, ht.created_at DESC
    `).all(status) as any[]
  }

  return db.query(`
    SELECT ht.*, ag.personality_name as requester_name
    FROM human_tasks ht
    JOIN agents ag ON ag.id = ht.requested_by
    ORDER BY CASE ht.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, ht.created_at DESC
  `).all() as any[]
}

// ---------------------------------------------------------------------------
// Parse [HUMAN_TASK] signals from agent output
// ---------------------------------------------------------------------------
export function parseHumanTaskSignals(
  agentId: string,
  output: string,
  phase: number
): void {
  // Match [HUMAN_TASK title:... urgency:... category:...] description text
  const matches = output.match(/\[HUMAN_TASK(?:\s+[^\]]+)?\][^\[]*/g)
  if (!matches) return

  for (const match of matches) {
    const titleMatch = match.match(/title:([^\]]+?)(?:\s+urgency:|\s+category:|\])/)
    const urgencyMatch = match.match(/urgency:(low|normal|high|critical)/)
    const categoryMatch = match.match(/category:(action|decision|access|review|unblock)/)

    const title = titleMatch?.[1]?.trim() ?? 'Human help needed'
    const urgency = urgencyMatch?.[1] as any ?? 'normal'
    const category = categoryMatch?.[1] as any ?? 'action'
    const description = match.replace(/\[HUMAN_TASK[^\]]*\]\s*/, '').trim()

    createHumanTask({
      requestedBy: agentId,
      title,
      description: description || title,
      urgency,
      category,
      phase,
    })
  }
}
