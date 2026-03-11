import { getDb } from '../db/database'
import { broadcastAGUI } from '../orchestrator'
import { sendMessage, broadcastMessage } from '../messages/bus'
import { logCollaborationEvent } from './ledger'

// ---------------------------------------------------------------------------
// Blocked Agent Relief — doc 0 Section 5.5
//
// When any agent sets status to 'blocked':
// 1. Row inserted into blocked_agents
// 2. HELP_REQUEST AG-UI event fired (visible in dashboard)
// 3. Broadcast message to all agents
// 4. First agent that resolves gets help_provided CFS (+2.5)
// 5. When unblocked: blocker_resolved CFS event for the helper (+3.0)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Report an agent as blocked — triggers HELP_REQUEST flow
// ---------------------------------------------------------------------------
export function reportBlocked(agentId: string, reason: string): string {
  const db = getDb()
  const id = crypto.randomUUID()

  // Get agent info
  const agent = db.query(`
    SELECT personality_name, team FROM agents WHERE id = ?
  `).get(agentId) as { personality_name: string; team: string }

  // Set agent status to blocked
  db.run(`UPDATE agents SET status = 'blocked' WHERE id = ?`, [agentId])

  // Insert blocked_agents record
  db.run(`
    INSERT INTO blocked_agents (id, agent_id, reason, help_request_broadcast, created_at)
    VALUES (?, ?, ?, 1, datetime('now'))
  `, [id, agentId, reason])

  // Broadcast HELP_REQUEST AG-UI event for dashboard
  broadcastAGUI({
    type: 'USER_INTERACTION',
    subtype: 'HELP_REQUEST',
    blockerId: id,
    agentId,
    agentName: agent.personality_name,
    team: agent.team,
    reason,
  })

  // Broadcast message to all agents
  broadcastMessage(
    agentId,
    `HELP REQUEST: ${agent.personality_name} is blocked`,
    `${agent.personality_name} (${agent.team} team) is blocked and needs help.\n\nReason: ${reason}\n\nThe first agent to resolve this will receive a help_provided CFS bonus (+2.5).`,
    'urgent'
  )

  console.log(`[BLOCKER] ${agent.personality_name} blocked: ${reason}`)

  return id
}

// ---------------------------------------------------------------------------
// Resolve a blocker — awards CFS to the helper
// ---------------------------------------------------------------------------
export function resolveBlocker(
  blockerId: string,
  resolverAgentId: string,
  resolution?: string
): { resolved: boolean; reason?: string } {
  const db = getDb()

  // Get the blocker record
  const blocker = db.query(`
    SELECT id, agent_id, reason, resolved_by FROM blocked_agents WHERE id = ?
  `).get(blockerId) as {
    id: string
    agent_id: string
    reason: string
    resolved_by: string | null
  } | null

  if (!blocker) return { resolved: false, reason: 'Blocker not found' }
  if (blocker.resolved_by) return { resolved: false, reason: 'Already resolved' }

  // Get current phase
  const activePhase = db.query(
    `SELECT phase_number FROM experiment_phases WHERE status = 'active'`
  ).get() as { phase_number: number } | null
  const phase = activePhase?.phase_number ?? 0

  // Mark blocker as resolved
  db.run(`
    UPDATE blocked_agents SET
      resolved_by = ?,
      resolved_at = datetime('now')
    WHERE id = ?
  `, [resolverAgentId, blockerId])

  // Unblock the agent
  db.run(`UPDATE agents SET status = 'idle' WHERE id = ?`, [blocker.agent_id])

  // Award help_provided CFS to the resolver (+2.5)
  logCollaborationEvent({
    fromAgentId: resolverAgentId,
    toAgentId: blocker.agent_id,
    eventType: 'help_provided',
    phase,
    weight: 2.5,
  })

  // Award blocker_resolved CFS to the resolver (+3.0)
  logCollaborationEvent({
    fromAgentId: resolverAgentId,
    toAgentId: blocker.agent_id,
    eventType: 'blocker_resolved',
    phase,
    weight: 3.0,
  })

  // Get names for logging
  const resolverName = (db.query(
    `SELECT personality_name FROM agents WHERE id = ?`
  ).get(resolverAgentId) as { personality_name: string })?.personality_name ?? resolverAgentId

  const blockedName = (db.query(
    `SELECT personality_name FROM agents WHERE id = ?`
  ).get(blocker.agent_id) as { personality_name: string })?.personality_name ?? blocker.agent_id

  // Notify the unblocked agent
  sendMessage({
    fromAgentId: resolverAgentId,
    toAgentId: blocker.agent_id,
    subject: `Blocker resolved by ${resolverName}`,
    body: resolution ?? `Your blocker has been resolved. You are now unblocked and can continue working.`,
    priority: 'high',
  })

  broadcastAGUI({
    type: 'STATE_DELTA',
    subtype: 'BLOCKER_RESOLVED',
    blockerId,
    agentId: blocker.agent_id,
    agentName: blockedName,
    resolvedBy: resolverAgentId,
    resolvedByName: resolverName,
  })

  console.log(`[BLOCKER] ${blockedName} unblocked by ${resolverName}`)

  return { resolved: true }
}

// ---------------------------------------------------------------------------
// Get active blockers (for dashboard)
// ---------------------------------------------------------------------------
export function getActiveBlockers(): Array<{
  id: string
  agentId: string
  agentName: string
  team: string
  reason: string
  createdAt: string
  durationMinutes: number
}> {
  const db = getDb()

  return db.query(`
    SELECT b.id, b.agent_id as agentId,
           a.personality_name as agentName,
           a.team,
           b.reason,
           b.created_at as createdAt,
           ROUND((julianday('now') - julianday(b.created_at)) * 1440) as durationMinutes
    FROM blocked_agents b
    JOIN agents a ON b.agent_id = a.id
    WHERE b.resolved_by IS NULL
    ORDER BY b.created_at ASC
  `).all() as any[]
}

// ---------------------------------------------------------------------------
// Get blocker history (for reports)
// ---------------------------------------------------------------------------
export function getBlockerHistory(limit: number = 50): Array<{
  id: string
  agentName: string
  reason: string
  resolvedByName: string | null
  durationMinutes: number
  createdAt: string
  resolvedAt: string | null
}> {
  const db = getDb()

  return db.query(`
    SELECT b.id,
           ba.personality_name as agentName,
           b.reason,
           ra.personality_name as resolvedByName,
           ROUND((julianday(COALESCE(b.resolved_at, 'now')) - julianday(b.created_at)) * 1440) as durationMinutes,
           b.created_at as createdAt,
           b.resolved_at as resolvedAt
    FROM blocked_agents b
    JOIN agents ba ON b.agent_id = ba.id
    LEFT JOIN agents ra ON b.resolved_by = ra.id
    ORDER BY b.created_at DESC
    LIMIT ?
  `).all(limit) as any[]
}
