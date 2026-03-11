import { Hono } from 'hono'
import {
  sendMessage,
  broadcastMessage,
  getInbox,
  getOutbox,
  markRead,
  markActioned,
  markIgnored,
  getMessageStats,
  getRecentMessages,
} from './bus'
import { getDb } from '../db/database'

const messageRoutes = new Hono()

// Send a message
messageRoutes.post('/send', async (c) => {
  const { fromAgentId, toAgentId, toTeam, subject, body, priority } = await c.req.json()

  if (!fromAgentId || !subject || !body) {
    return c.json({ error: 'fromAgentId, subject, and body are required' }, 400)
  }

  const id = sendMessage({ fromAgentId, toAgentId, toTeam, subject, body, priority })
  return c.json({ id, status: 'sent' })
})

// Broadcast to all agents
messageRoutes.post('/broadcast', async (c) => {
  const { fromAgentId, subject, body, priority } = await c.req.json()

  if (!fromAgentId || !subject || !body) {
    return c.json({ error: 'fromAgentId, subject, and body are required' }, 400)
  }

  const ids = broadcastMessage(fromAgentId, subject, body, priority)
  return c.json({ count: ids.length, ids })
})

// Get inbox for an agent
messageRoutes.get('/inbox/:agentId', (c) => {
  const agentId = c.req.param('agentId')
  const unreadOnly = c.req.query('unread') === 'true'
  const limit = Number(c.req.query('limit') ?? 50)

  const messages = getInbox(agentId, { unreadOnly, limit })
  return c.json(messages)
})

// Get outbox for an agent
messageRoutes.get('/outbox/:agentId', (c) => {
  const agentId = c.req.param('agentId')
  const limit = Number(c.req.query('limit') ?? 50)

  const messages = getOutbox(agentId, limit)
  return c.json(messages)
})

// Mark message as read
messageRoutes.post('/:messageId/read', (c) => {
  markRead(c.req.param('messageId'))
  return c.json({ status: 'read' })
})

// Mark message as actioned (triggers CFS event)
messageRoutes.post('/:messageId/action', (c) => {
  const { fromAgentId, toAgentId } = markActioned(c.req.param('messageId'))

  // Log collaboration event: message_actioned (+1.0 CFS to sender)
  if (toAgentId) {
    const db = getDb()
    const phase = db.query(
      `SELECT phase_number FROM experiment_phases WHERE status = 'active'`
    ).get() as { phase_number: number } | null

    db.run(`
      INSERT INTO collaboration_events (id, from_agent_id, to_agent_id, event_type, phase, weight)
      VALUES (?, ?, ?, 'message_actioned', ?, 1.0)
    `, [crypto.randomUUID(), fromAgentId, toAgentId, phase?.phase_number ?? 0])
  }

  return c.json({ status: 'actioned' })
})

// Mark message as ignored
messageRoutes.post('/:messageId/ignore', (c) => {
  markIgnored(c.req.param('messageId'))
  return c.json({ status: 'ignored' })
})

// Get message stats for an agent
messageRoutes.get('/stats/:agentId', (c) => {
  const stats = getMessageStats(c.req.param('agentId'))
  return c.json(stats)
})

// Get recent messages (dashboard view)
messageRoutes.get('/recent', (c) => {
  const limit = Number(c.req.query('limit') ?? 50)
  return c.json(getRecentMessages(limit))
})

export { messageRoutes }
