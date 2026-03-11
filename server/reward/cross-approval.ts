import { getDb } from '../db/database'
import { broadcastAGUI } from '../orchestrator'
import { sendMessage } from '../messages/bus'
import { logCollaborationEvent } from './ledger'
import { BUDGET_OWNERS } from '../agents/registry'

// ---------------------------------------------------------------------------
// Cross-Approval Flow — doc 0 Section 5.4
//
// Budget categories are owned by specific agents/teams.
// Spending outside your team's category requires co-approval from the
// budget category owner. The cross-approval conversation IS the collaboration.
//
// | Category    | Owner Team | Owner Agent |
// | infra       | Tech       | Lee         |
// | marketing   | Marketing  | Vera        |
// | tooling     | Ops        | Alex        |
// | contingency | Exec       | Priya       |
// | reserve     | Exec       | Reza        |
// ---------------------------------------------------------------------------

// Map categories to their owner teams
const CATEGORY_OWNER_TEAMS: Record<string, string> = {
  infra: 'tech',
  marketing: 'marketing',
  tooling: 'ops',
  contingency: 'exec',
  reserve: 'exec',
}

// ---------------------------------------------------------------------------
// Check if cross-approval is required for a spend
// ---------------------------------------------------------------------------
export function requiresCrossApproval(spendingAgentId: string, category: string): boolean {
  const db = getDb()

  const agent = db.query(`SELECT team FROM agents WHERE id = ?`).get(spendingAgentId) as { team: string } | null
  if (!agent) return false

  const ownerTeam = CATEGORY_OWNER_TEAMS[category]
  if (!ownerTeam) return false

  return agent.team !== ownerTeam
}

// ---------------------------------------------------------------------------
// Request cross-approval for a budget spend
// Creates a pending entry and notifies the category owner
// ---------------------------------------------------------------------------
export function requestCrossApproval(params: {
  requestingAgentId: string
  category: string
  amount: number
  description: string
  phase: number
}): { entryId: string; ownerAgentId: string } {
  const db = getDb()
  const entryId = crypto.randomUUID()

  const ownerAgentId = BUDGET_OWNERS[params.category]
  if (!ownerAgentId) {
    throw new Error(`No budget owner defined for category '${params.category}'`)
  }

  // Get requesting agent info
  const requestingAgent = db.query(`
    SELECT personality_name, team FROM agents WHERE id = ?
  `).get(params.requestingAgentId) as { personality_name: string; team: string }

  // Create pending budget entry with cross-approval required
  db.run(`
    INSERT INTO budget_entries
      (id, agent_id, amount, category, description, notes, requires_cross_approval, phase)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `, [
    entryId,
    params.requestingAgentId,
    -Math.abs(params.amount), // negative for spending
    params.category,
    params.description,
    `[PENDING APPROVAL] From ${requestingAgent.personality_name} (${requestingAgent.team}). Awaiting ${ownerAgentId} approval.`,
    params.phase,
  ])

  // Notify the budget category owner
  sendMessage({
    fromAgentId: params.requestingAgentId,
    toAgentId: ownerAgentId,
    subject: `Cross-approval needed: $${params.amount} in ${params.category}`,
    body: `${requestingAgent.personality_name} (${requestingAgent.team} team) requests $${params.amount.toFixed(2)} from the ${params.category} budget.\n\nDescription: ${params.description}\n\nPlease approve or reject.`,
    priority: 'high',
  })

  // Broadcast USER_INTERACTION for the dashboard
  broadcastAGUI({
    type: 'USER_INTERACTION',
    subtype: 'CROSS_APPROVAL',
    entryId,
    requestingAgentId: params.requestingAgentId,
    requestingAgentName: requestingAgent.personality_name,
    ownerAgentId,
    category: params.category,
    amount: params.amount,
    description: params.description,
  })

  console.log(
    `[CROSS-APPROVAL] ${requestingAgent.personality_name} requests $${params.amount} from ${params.category} (owner: ${ownerAgentId})`
  )

  return { entryId, ownerAgentId }
}

// ---------------------------------------------------------------------------
// Approve a cross-approval request
// ---------------------------------------------------------------------------
export function approveCrossApproval(entryId: string, approverAgentId: string): {
  approved: boolean
  reason?: string
} {
  const db = getDb()

  // Get the entry
  const entry = db.query(`
    SELECT id, agent_id, category, amount, requires_cross_approval, cross_approved_by, phase
    FROM budget_entries WHERE id = ?
  `).get(entryId) as {
    id: string
    agent_id: string
    category: string
    amount: number
    requires_cross_approval: number
    cross_approved_by: string | null
    phase: number
  } | null

  if (!entry) return { approved: false, reason: 'Entry not found' }
  if (!entry.requires_cross_approval) return { approved: false, reason: 'No cross-approval required' }
  if (entry.cross_approved_by) return { approved: false, reason: 'Already approved' }

  // Verify the approver is the correct budget owner
  const expectedOwner = BUDGET_OWNERS[entry.category]
  if (approverAgentId !== expectedOwner) {
    return { approved: false, reason: `Only ${expectedOwner} can approve ${entry.category} spending` }
  }

  // Approve the entry
  db.run(`
    UPDATE budget_entries SET
      cross_approved_by = ?,
      approved_by = ?,
      notes = REPLACE(notes, '[PENDING APPROVAL]', '[APPROVED]')
    WHERE id = ?
  `, [approverAgentId, approverAgentId, entryId])

  // Log cross_approval collaboration event — rewards the approver
  logCollaborationEvent({
    fromAgentId: approverAgentId,
    toAgentId: entry.agent_id,
    eventType: 'cross_approval',
    phase: entry.phase,
    weight: 1.5,
  })

  // Notify the requesting agent
  const approverName = (db.query(
    `SELECT personality_name FROM agents WHERE id = ?`
  ).get(approverAgentId) as { personality_name: string })?.personality_name ?? approverAgentId

  sendMessage({
    fromAgentId: approverAgentId,
    toAgentId: entry.agent_id,
    subject: `Budget approved: $${Math.abs(entry.amount).toFixed(2)} in ${entry.category}`,
    body: `Your ${entry.category} spend of $${Math.abs(entry.amount).toFixed(2)} has been approved by ${approverName}.`,
    priority: 'normal',
  })

  console.log(
    `[CROSS-APPROVAL] ${approverName} approved $${Math.abs(entry.amount).toFixed(2)} in ${entry.category} for ${entry.agent_id}`
  )

  return { approved: true }
}

// ---------------------------------------------------------------------------
// Reject a cross-approval request
// ---------------------------------------------------------------------------
export function rejectCrossApproval(entryId: string, rejectorAgentId: string, reason: string): {
  rejected: boolean
  reason?: string
} {
  const db = getDb()

  const entry = db.query(`
    SELECT id, agent_id, category, amount FROM budget_entries WHERE id = ?
  `).get(entryId) as { id: string; agent_id: string; category: string; amount: number } | null

  if (!entry) return { rejected: false, reason: 'Entry not found' }

  // Mark entry as rejected (cancelled status, update notes)
  db.run(`
    UPDATE budget_entries SET
      notes = REPLACE(notes, '[PENDING APPROVAL]', '[REJECTED]') || ' Reason: ' || ?
    WHERE id = ?
  `, [reason, entryId])

  // Notify the requesting agent
  sendMessage({
    fromAgentId: rejectorAgentId,
    toAgentId: entry.agent_id,
    subject: `Budget rejected: $${Math.abs(entry.amount).toFixed(2)} in ${entry.category}`,
    body: `Your ${entry.category} spend request of $${Math.abs(entry.amount).toFixed(2)} was rejected.\nReason: ${reason}`,
    priority: 'normal',
  })

  console.log(
    `[CROSS-APPROVAL] ${rejectorAgentId} rejected $${Math.abs(entry.amount).toFixed(2)} in ${entry.category} for ${entry.agent_id}: ${reason}`
  )

  return { rejected: true }
}

// ---------------------------------------------------------------------------
// Get pending cross-approvals (for dashboard)
// ---------------------------------------------------------------------------
export function getPendingCrossApprovals(): Array<{
  entryId: string
  requestingAgentId: string
  requestingAgentName: string
  ownerAgentId: string
  category: string
  amount: number
  description: string
  createdAt: string
}> {
  const db = getDb()

  return db.query(`
    SELECT be.id as entryId,
           be.agent_id as requestingAgentId,
           a.personality_name as requestingAgentName,
           bco.owner_agent_id as ownerAgentId,
           be.category,
           ABS(be.amount) as amount,
           be.description,
           be.created_at as createdAt
    FROM budget_entries be
    JOIN agents a ON be.agent_id = a.id
    JOIN budget_category_owners bco ON be.category = bco.category
    WHERE be.requires_cross_approval = 1
      AND be.cross_approved_by IS NULL
      AND be.notes LIKE '%PENDING%'
    ORDER BY be.created_at DESC
  `).all() as any[]
}
