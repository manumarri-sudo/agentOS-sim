import { getDb } from '../db/database'
import { broadcastAGUI } from '../orchestrator'
import { logCollaborationEvent } from './ledger'
import { sendMessage, broadcastMessage } from '../messages/bus'
import { logGovernanceEvent } from '../governance/observer'

// ---------------------------------------------------------------------------
// Revenue Attribution Engine — doc 0 Section 5.6
//
// When revenue arrives (budget_entry with amount > 0, not experiment_start):
// 1. Read last 7 sim_days of actions
// 2. Build action graph via cited_by references
// 3. Traverse backwards from revenue event to find causal chain
// 4. Assign attribution shares proportional to chain participation
// ---------------------------------------------------------------------------

interface ActionNode {
  id: string
  agentId: string
  type: string
  description: string
  phase: number
  citedBy: string[]  // action IDs that cited this action
  completedAt: string
}

// ---------------------------------------------------------------------------
// Trace the causal action chain from a revenue event
// ---------------------------------------------------------------------------
function traceActionChain(revenueEventId: string): ActionNode[] {
  const db = getDb()

  // Get the revenue event's phase and timestamp
  const revenueEvent = db.query(`
    SELECT phase, created_at FROM budget_entries WHERE id = ?
  `).get(revenueEventId) as { phase: number; created_at: string } | null

  if (!revenueEvent) return []

  // Get all completed actions from recent phases (up to 7 sim_days back)
  // Since sim_days don't map 1:1 to time, we look at all actions from
  // the current and previous phases
  const actions = db.query(`
    SELECT id, agent_id, type, description, phase, cited_by, completed_at
    FROM actions
    WHERE status = 'completed'
      AND phase <= ?
    ORDER BY completed_at DESC
  `).all(revenueEvent.phase) as {
    id: string
    agent_id: string
    type: string
    description: string
    phase: number
    cited_by: string | null
    completed_at: string
  }[]

  // Build a citation graph
  const actionMap = new Map<string, ActionNode>()
  for (const action of actions) {
    const citedBy = action.cited_by
      ? action.cited_by.split(',').map(s => s.trim()).filter(Boolean)
      : []

    actionMap.set(action.id, {
      id: action.id,
      agentId: action.agent_id,
      type: action.type,
      description: action.description,
      phase: action.phase,
      citedBy,
      completedAt: action.completed_at,
    })
  }

  // Find all actions that are in the causal chain
  // Start from actions that were cited and work backwards
  const inChain = new Set<string>()

  // All actions contribute to the chain, but those that are cited
  // by subsequent actions have a stronger connection
  for (const [id, action] of actionMap) {
    // Mark cited actions
    for (const citedId of action.citedBy) {
      inChain.add(citedId)
    }
  }

  // If no citation graph exists, include all completed actions
  // (this is the common case early in the experiment)
  if (inChain.size === 0) {
    for (const [id] of actionMap) {
      inChain.add(id)
    }
  }

  // Return all nodes in the chain
  return Array.from(inChain)
    .map(id => actionMap.get(id))
    .filter((node): node is ActionNode => node !== undefined)
}

// ---------------------------------------------------------------------------
// Compute attribution shares for a revenue event
// doc 0 Section 5.6: agents whose work was never cited get 0% attribution
// ---------------------------------------------------------------------------
export function computeAttribution(revenueEventId: string): Map<string, number> {
  const chain = traceActionChain(revenueEventId)
  const agentContributions = new Map<string, number>()

  if (chain.length === 0) {
    return agentContributions
  }

  // Weight by phase proximity and action type
  const phaseWeights: Record<string, number> = {
    research: 1.0,
    write: 1.0,
    build: 2.0,    // building is heavily weighted
    decide: 1.5,
    communicate: 0.5,
    review: 1.0,
    spend: 0.5,
    help: 1.5,
  }

  for (const action of chain) {
    const weight = phaseWeights[action.type] ?? 1.0
    // Higher phases are closer to revenue — weight them more
    const phaseBonus = 1 + (action.phase * 0.2)
    const totalWeight = weight * phaseBonus

    const current = agentContributions.get(action.agentId) || 0
    agentContributions.set(action.agentId, current + totalWeight)
  }

  // Normalize to sum = 1.0
  const total = [...agentContributions.values()].reduce((a, b) => a + b, 0)
  if (total > 0) {
    for (const [agentId, share] of agentContributions) {
      agentContributions.set(agentId, share / total)
    }
  }

  return agentContributions
}

// ---------------------------------------------------------------------------
// Run attribution for a revenue event and persist results
// ---------------------------------------------------------------------------
export function runAttribution(revenueEventId: string, revenueAmount: number): void {
  const db = getDb()
  const shares = computeAttribution(revenueEventId)

  if (shares.size === 0) {
    console.warn(`[ATTRIBUTION] No causal chain found for revenue event ${revenueEventId}`)
    return
  }

  // Get current phase
  const activePhase = db.query(
    `SELECT phase_number FROM experiment_phases WHERE status = 'active'`
  ).get() as { phase_number: number } | null
  const phase = activePhase?.phase_number ?? 0

  // Persist attribution shares
  for (const [agentId, share] of shares) {
    // Get the contributing action IDs for this agent
    const actions = db.query(`
      SELECT id FROM actions
      WHERE agent_id = ? AND status = 'completed'
      ORDER BY completed_at DESC LIMIT 20
    `).all(agentId) as { id: string }[]

    const actionIds = actions.map(a => a.id)

    db.run(`
      INSERT INTO revenue_attribution (id, revenue_event_id, agent_id, attribution_share, contributing_action_ids)
      VALUES (?, ?, ?, ?, ?)
    `, [
      crypto.randomUUID(),
      revenueEventId,
      agentId,
      share,
      JSON.stringify(actionIds),
    ])
  }

  // Broadcast attribution results
  const attributionSummary = Array.from(shares.entries()).map(([agentId, share]) => {
    const agent = db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(agentId) as { personality_name: string }
    return {
      agentId,
      agentName: agent?.personality_name ?? agentId,
      share: Math.round(share * 100),
      amount: (share * revenueAmount).toFixed(2),
    }
  }).sort((a, b) => b.share - a.share)

  broadcastAGUI({
    type: 'STATE_DELTA',
    revenueEvent: true,
    revenueAmount,
    revenueEventId,
    attribution: attributionSummary,
  })

  console.log(`[ATTRIBUTION] Revenue $${revenueAmount} attributed:`)
  for (const entry of attributionSummary) {
    console.log(`  ${entry.agentName}: ${entry.share}% ($${entry.amount})`)
  }
}

// ---------------------------------------------------------------------------
// Record a revenue event and trigger attribution
// Called when a positive budget_entry is created (not experiment_start)
// ---------------------------------------------------------------------------
export function recordRevenueEvent(params: {
  amount: number
  source: string
  notes: string
  phase: number
}): string {
  const db = getDb()
  const id = crypto.randomUUID()

  // Create a positive budget entry
  db.run(`
    INSERT INTO budget_entries (id, amount, category, agent_id, notes, phase)
    VALUES (?, ?, 'reserve', 'paz', ?, ?)
  `, [id, params.amount, `[REVENUE] ${params.source}: ${params.notes}`, params.phase])

  // Run attribution engine
  runAttribution(id, params.amount)

  // Notify Paz (product manager) of revenue event
  sendMessage({
    fromAgentId: 'system',
    toAgentId: 'paz',
    subject: `REVENUE: $${params.amount} from ${params.source}`,
    body: `Revenue event recorded: $${params.amount} from ${params.source}. ${params.notes}`,
    priority: 'urgent',
  })

  // Broadcast to all agents
  broadcastMessage(
    'system',
    `Revenue: $${params.amount}`,
    `Revenue of $${params.amount} received from ${params.source}. Attribution computed.`,
    'high'
  )

  // Log governance event for audit trail
  logGovernanceEvent({
    eventType: 'trust_ladder_advancement',
    details: `Revenue event: $${params.amount} from ${params.source} (Phase ${params.phase})`,
    severity: 'info',
  })

  console.log(`[REVENUE] Revenue event: $${params.amount} from ${params.source}`)

  return id
}

// ---------------------------------------------------------------------------
// Get attribution summary for the dashboard (RewardPanel)
// ---------------------------------------------------------------------------
export function getAttributionSummary(): Array<{
  agentId: string
  personalityName: string
  totalShare: number
  totalRevenue: number
  eventCount: number
}> {
  const db = getDb()

  const attributions = db.query(`
    SELECT ra.agent_id,
           a.personality_name,
           SUM(ra.attribution_share * be.amount) as total_revenue,
           AVG(ra.attribution_share) as avg_share,
           COUNT(*) as event_count
    FROM revenue_attribution ra
    JOIN agents a ON ra.agent_id = a.id
    JOIN budget_entries be ON ra.revenue_event_id = be.id
    WHERE be.amount > 0 AND be.notes != 'experiment_start'
    GROUP BY ra.agent_id
    ORDER BY total_revenue DESC
  `).all() as {
    agent_id: string
    personality_name: string
    total_revenue: number
    avg_share: number
    event_count: number
  }[]

  return attributions.map(a => ({
    agentId: a.agent_id,
    personalityName: a.personality_name,
    totalShare: a.avg_share,
    totalRevenue: a.total_revenue,
    eventCount: a.event_count,
  }))
}
