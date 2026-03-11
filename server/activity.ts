import { getDb } from './db/database'
import { getSimDay } from './clock'

// Log a human-readable one-liner to the activity log
export function logActivity(params: {
  agentId: string
  otherAgentId?: string
  phase: number
  eventType: string
  summary: string
}): void {
  const db = getDb()
  const simDay = getSimDay()

  db.run(
    `INSERT INTO activity_log (sim_day, phase, agent_id, other_agent_id, event_type, summary)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [simDay, params.phase, params.agentId, params.otherAgentId ?? null, params.eventType, params.summary]
  )
}

// Get recent activity log entries
export function getActivityLog(limit = 50): any[] {
  const db = getDb()
  return db.query(`
    SELECT al.*,
           a1.personality_name as agent_name,
           a2.personality_name as other_agent_name
    FROM activity_log al
    LEFT JOIN agents a1 ON a1.id = al.agent_id
    LEFT JOIN agents a2 ON a2.id = al.other_agent_id
    ORDER BY al.created_at DESC
    LIMIT ?
  `).all(limit)
}
