import { getDb } from '../db/database'

export interface Message {
  id: string
  from_agent_id: string
  to_agent_id: string | null
  to_team: string | null
  subject: string
  body: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'sent' | 'read' | 'actioned' | 'ignored'
  created_at: string
}

export interface SendMessageParams {
  fromAgentId: string
  toAgentId?: string
  toTeam?: string
  subject: string
  body: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
}

// Send a message to a specific agent or broadcast to a team
export function sendMessage(params: SendMessageParams): string {
  const db = getDb()
  const id = crypto.randomUUID()

  if (!params.toAgentId && !params.toTeam) {
    throw new Error('Must specify either toAgentId or toTeam')
  }

  // System messages: use 'reza' as sender (CEO) since 'system' isn't a real agent
  // but log the real origin in the body
  const fromId = params.fromAgentId === 'system' ? 'reza' : params.fromAgentId

  db.run(`
    INSERT INTO messages (id, from_agent_id, to_agent_id, to_team, subject, body, priority, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')
  `, [
    id,
    fromId,
    params.toAgentId ?? null,
    params.toTeam ?? null,
    params.subject,
    params.fromAgentId === 'system' ? `[SYSTEM] ${params.body}` : params.body,
    params.priority ?? 'normal',
  ])

  return id
}

// Broadcast a message to all agents
export function broadcastMessage(fromAgentId: string, subject: string, body: string, priority: 'low' | 'normal' | 'high' | 'urgent' = 'normal'): string[] {
  const db = getDb()
  const agents = db.query(`SELECT id FROM agents WHERE id != ?`).all(fromAgentId) as { id: string }[]
  const ids: string[] = []

  for (const agent of agents) {
    const id = sendMessage({
      fromAgentId,
      toAgentId: agent.id,
      subject,
      body,
      priority,
    })
    ids.push(id)
  }

  return ids
}

// Get messages for an agent (inbox)
export function getInbox(agentId: string, options?: { unreadOnly?: boolean; limit?: number }): Message[] {
  const db = getDb()
  const agent = db.query(`SELECT team FROM agents WHERE id = ?`).get(agentId) as { team: string }

  let sql = `
    SELECT * FROM messages
    WHERE (to_agent_id = ? OR to_team = ?)
  `
  const params: any[] = [agentId, agent.team]

  if (options?.unreadOnly) {
    sql += ` AND status = 'sent'`
  }

  sql += ` ORDER BY
    CASE priority
      WHEN 'urgent' THEN 0
      WHEN 'high' THEN 1
      WHEN 'normal' THEN 2
      WHEN 'low' THEN 3
    END,
    created_at DESC`

  if (options?.limit) {
    sql += ` LIMIT ?`
    params.push(options.limit)
  }

  return db.query(sql).all(...params) as Message[]
}

// Get messages sent by an agent (outbox)
export function getOutbox(agentId: string, limit: number = 50): Message[] {
  const db = getDb()
  return db.query(`
    SELECT * FROM messages
    WHERE from_agent_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(agentId, limit) as Message[]
}

// Mark a message as read
export function markRead(messageId: string): void {
  const db = getDb()
  db.run(`UPDATE messages SET status = 'read' WHERE id = ? AND status = 'sent'`, [messageId])
}

// Mark a message as actioned (triggers collaboration event)
export function markActioned(messageId: string): { fromAgentId: string; toAgentId: string | null } {
  const db = getDb()

  const msg = db.query(`SELECT from_agent_id, to_agent_id FROM messages WHERE id = ?`).get(messageId) as {
    from_agent_id: string
    to_agent_id: string | null
  }

  db.run(`UPDATE messages SET status = 'actioned' WHERE id = ?`, [messageId])

  return { fromAgentId: msg.from_agent_id, toAgentId: msg.to_agent_id }
}

// Mark a message as ignored
export function markIgnored(messageId: string): void {
  const db = getDb()
  db.run(`UPDATE messages SET status = 'ignored' WHERE id = ?`, [messageId])
}

// Get message counts by status for an agent
export function getMessageStats(agentId: string): Record<string, number> {
  const db = getDb()
  const agent = db.query(`SELECT team FROM agents WHERE id = ?`).get(agentId) as { team: string }

  const stats = db.query(`
    SELECT status, COUNT(*) as count
    FROM messages
    WHERE to_agent_id = ? OR to_team = ?
    GROUP BY status
  `).all(agentId, agent.team) as { status: string; count: number }[]

  const result: Record<string, number> = { sent: 0, read: 0, actioned: 0, ignored: 0 }
  for (const s of stats) {
    result[s.status] = s.count
  }
  return result
}

// Get recent inter-team messages for the dashboard
export function getRecentMessages(limit: number = 50): any[] {
  const db = getDb()
  return db.query(`
    SELECT m.*,
           fa.personality_name as from_name,
           fa.team as from_team,
           ta.personality_name as to_name,
           ta.team as to_team
    FROM messages m
    LEFT JOIN agents fa ON m.from_agent_id = fa.id
    LEFT JOIN agents ta ON m.to_agent_id = ta.id
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit)
}
