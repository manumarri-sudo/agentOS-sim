import { getDb } from '../db/database'
import { getSimDay } from '../clock'
import { broadcastAGUI } from '../orchestrator'

// ---------------------------------------------------------------------------
// CFS (Cross-Functional Score) Ledger — doc 0 Section 5.1 + doc 6 Issue 1/8
//
// CFS increases from collaboration events. Decay is 5% per sim_day,
// computed at read time (not continuously), keyed to sim_day counter.
//
// Event weights:
//   output_cited:                +2.0
//   blocker_resolved:            +3.0
//   cross_approval:              +1.5
//   message_actioned:            +1.0
//   decision_ratified:           +1.5
//   help_provided:               +2.5
//   deadline_beat:               +4.0  (highest single event)
//   deadline_pull_in:            +3.0
//   deadline_revision_accurate:  +1.5
//   scope_expansion:             +2.0
//   slam_dunk:                   +5.0  (doc 6 Addition 3)
// ---------------------------------------------------------------------------

const DECAY_RATE = 0.95 // 5% decay per sim_day

export const CFS_WEIGHTS: Record<string, number> = {
  output_cited: 2.0,
  blocker_resolved: 3.0,
  cross_approval: 1.5,
  message_actioned: 1.0,
  decision_ratified: 1.5,
  help_provided: 2.5,
  deadline_beat: 4.0,
  deadline_pull_in: 3.0,
  deadline_revision_accurate: 1.5,
  scope_expansion: 2.0,
  slam_dunk: 5.0,
  rainmaker: 10.0,        // Revenue causal chain bonus (permanent, non-decaying)
  anomaly_penalty: -5.0,  // Governance anomaly detection penalty
}

// ---------------------------------------------------------------------------
// Capability tier thresholds — doc 0 Section 5.2
// ---------------------------------------------------------------------------
export const TIER_THRESHOLDS = [
  { tier: 0, cfsMin: 0,    tokenMultiplier: 1.0, queuePriority: 5 },
  { tier: 1, cfsMin: 8.0,  tokenMultiplier: 1.5, queuePriority: 3 },
  { tier: 2, cfsMin: 20.0, tokenMultiplier: 2.0, queuePriority: 1 },
]

// ---------------------------------------------------------------------------
// Recalculate CFS for a single agent — doc 6 Issue 8
//
// Decay is computed at assessment time from sim_day delta, not continuously.
// ---------------------------------------------------------------------------
export function recalculateCFS(agentId: string, currentSimDay?: number, realStart?: string | null): number {
  const db = getDb()
  const simDay = currentSimDay ?? getSimDay()

  // Permanent events: aggregate in a single SUM (no need to load row by row)
  const permanentScore = (db.query(`
    SELECT COALESCE(SUM(weight), 0) as total
    FROM collaboration_events
    WHERE from_agent_id = ? AND permanent = 1
  `).get(agentId) as { total: number }).total

  // Decaying events: LIMIT 200 -- events older than ~90 sim days contribute <1%
  // (0.95^90 = 0.01) so truncating is safe
  const events = db.query(`
    SELECT weight, created_at
    FROM collaboration_events
    WHERE from_agent_id = ? AND (permanent IS NULL OR permanent = 0)
    ORDER BY created_at DESC
    LIMIT 200
  `).all(agentId) as {
    weight: number
    created_at: string
  }[]

  // Resolve sim_clock start (caller can pass it to avoid N queries)
  const startTime = realStart !== undefined ? realStart : (db.query(
    `SELECT real_start FROM sim_clock WHERE id = 1`
  ).get() as { real_start: string } | null)?.real_start

  const decayingScore = events.reduce((total, event) => {
    const eventAge = estimateEventSimDayAge(event.created_at, simDay, startTime ?? undefined)
    const decayFactor = Math.pow(DECAY_RATE, eventAge)
    return total + (event.weight * decayFactor)
  }, 0)

  const score = permanentScore + decayingScore

  db.run(
    `UPDATE agents SET collaboration_score = ? WHERE id = ?`,
    [score, agentId]
  )

  return score
}

// ---------------------------------------------------------------------------
// Estimate how many sim_days old an event is
// Uses a linear interpolation based on real_start and current sim_day
// ---------------------------------------------------------------------------
function estimateEventSimDayAge(
  eventCreatedAt: string,
  currentSimDay: number,
  realStart: string | undefined
): number {
  if (!realStart || currentSimDay === 0) return 0

  const startTime = new Date(realStart + 'Z').getTime()
  const eventTime = new Date(eventCreatedAt + 'Z').getTime()
  const now = Date.now()

  // Total real time elapsed
  const totalRealElapsed = now - startTime
  if (totalRealElapsed <= 0) return 0

  // How much real time has elapsed since the event
  const eventRealAge = now - eventTime
  if (eventRealAge <= 0) return 0

  // Proportional sim_day age
  const proportionalAge = (eventRealAge / totalRealElapsed) * currentSimDay
  return Math.max(0, proportionalAge)
}

// ---------------------------------------------------------------------------
// Recalculate CFS for ALL agents — called each orchestrator cycle
// ---------------------------------------------------------------------------
export function recalculateAllCFS(): void {
  const db = getDb()
  const agents = db.query(`SELECT id FROM agents`).all() as { id: string }[]

  // Hoist shared values outside loop (was 18 identical sim_clock queries)
  const currentSimDay = getSimDay()
  const simClockStart = (db.query(
    `SELECT real_start FROM sim_clock WHERE id = 1`
  ).get() as { real_start: string } | null)?.real_start ?? null

  for (const agent of agents) {
    recalculateCFS(agent.id, currentSimDay, simClockStart)
  }
}

// ---------------------------------------------------------------------------
// Update capability tiers based on CFS — called each orchestrator cycle
// doc 0 Section 5.2: tiers re-evaluated every cycle
// ---------------------------------------------------------------------------
export function updateAllTiers(): void {
  const db = getDb()
  const agents = db.query(`
    SELECT a.id, a.personality_name, a.collaboration_score,
           ct.tier as current_tier
    FROM agents a
    LEFT JOIN capability_tiers ct ON a.id = ct.agent_id
  `).all() as {
    id: string
    personality_name: string
    collaboration_score: number
    current_tier: number | null
  }[]

  for (const agent of agents) {
    const cfs = agent.collaboration_score
    const currentTier = agent.current_tier ?? 0

    // Determine new tier based on CFS thresholds
    let newTier = 0
    for (const threshold of TIER_THRESHOLDS) {
      if (cfs >= threshold.cfsMin) {
        newTier = threshold.tier
      }
    }

    if (newTier !== currentTier) {
      const tierConfig = TIER_THRESHOLDS.find(t => t.tier === newTier) ?? { tier: 0, cfsMin: 0, tokenMultiplier: 1.0, queuePriority: 5 }

      // Update capability_tiers table
      db.run(`
        INSERT INTO capability_tiers (agent_id, tier, unlocked_at, token_multiplier, queue_priority, updated_at)
        VALUES (?, ?, datetime('now'), ?, ?, datetime('now'))
        ON CONFLICT(agent_id) DO UPDATE SET
          tier = ?, unlocked_at = datetime('now'),
          token_multiplier = ?, queue_priority = ?,
          updated_at = datetime('now')
      `, [
        agent.id, newTier, tierConfig.tokenMultiplier, tierConfig.queuePriority,
        newTier, tierConfig.tokenMultiplier, tierConfig.queuePriority,
      ])

      // Update agent's capability_tier column
      db.run(`UPDATE agents SET capability_tier = ? WHERE id = ?`, [newTier, agent.id])

      // Apply token multiplier to daily budget
      const baseBudget = 50000
      const newBudget = Math.floor(baseBudget * tierConfig.tokenMultiplier)
      db.run(
        `UPDATE agents SET token_budget_today = ? WHERE id = ?`,
        [newBudget, agent.id]
      )

      // Broadcast tier change
      const direction = newTier > currentTier ? 'upgraded' : 'downgraded'
      broadcastAGUI({
        type: 'STATE_DELTA',
        subtype: 'TIER_CHANGE',
        agentId: agent.id,
        agentName: agent.personality_name,
        previousTier: currentTier,
        newTier,
        cfs,
        direction,
      })

      console.log(
        `[REWARD] ${agent.personality_name} ${direction} to Tier ${newTier} (CFS: ${cfs.toFixed(2)})`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Log a collaboration event
// ---------------------------------------------------------------------------
export function logCollaborationEvent(params: {
  fromAgentId: string
  toAgentId: string
  eventType: string
  actionId?: string
  phase: number
  weight?: number
}): string {
  const db = getDb()
  const id = crypto.randomUUID()
  const weight = params.weight ?? CFS_WEIGHTS[params.eventType] ?? 1.0

  db.run(`
    INSERT INTO collaboration_events (id, from_agent_id, to_agent_id, event_type, action_id, phase, weight)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    params.fromAgentId,
    params.toAgentId,
    params.eventType,
    params.actionId ?? null,
    params.phase,
    weight,
  ])

  broadcastAGUI({
    type: 'STATE_DELTA',
    collaborationEvent: true,
    eventType: params.eventType,
    fromAgentId: params.fromAgentId,
    toAgentId: params.toAgentId,
    weight,
    phase: params.phase,
  })

  console.log(
    `[REWARD] Collaboration event: ${params.eventType} (${params.fromAgentId} → ${params.toAgentId}, weight: ${weight})`
  )

  return id
}

// ---------------------------------------------------------------------------
// Get CFS summary for all agents (dashboard data)
// ---------------------------------------------------------------------------
export function getCFSSummary(): Array<{
  agentId: string
  personalityName: string
  team: string
  cfs: number
  tier: number
  tierName: string
  eventCount: number
  recentEvents: Array<{ type: string; weight: number; created_at: string }>
}> {
  const db = getDb()

  const agents = db.query(`
    SELECT a.id, a.personality_name, a.team, a.collaboration_score,
           COALESCE(ct.tier, 0) as tier
    FROM agents a
    LEFT JOIN capability_tiers ct ON a.id = ct.agent_id
    ORDER BY a.collaboration_score DESC
  `).all() as {
    id: string
    personality_name: string
    team: string
    collaboration_score: number
    tier: number
  }[]

  // Batch event counts (was N+1: 2 queries per agent -> 2 total queries)
  const eventCounts = new Map<string, number>()
  const countRows = db.query(`
    SELECT from_agent_id, COUNT(*) as n FROM collaboration_events GROUP BY from_agent_id
  `).all() as { from_agent_id: string; n: number }[]
  for (const r of countRows) eventCounts.set(r.from_agent_id, r.n)

  // Batch recent events with ROW_NUMBER to avoid per-agent query
  const allRecentEvents = db.query(`
    SELECT from_agent_id, event_type as type, weight, created_at
    FROM collaboration_events
    ORDER BY created_at DESC
    LIMIT 200
  `).all() as { from_agent_id: string; type: string; weight: number; created_at: string }[]

  const recentByAgent = new Map<string, { type: string; weight: number; created_at: string }[]>()
  for (const e of allRecentEvents) {
    if (!recentByAgent.has(e.from_agent_id)) recentByAgent.set(e.from_agent_id, [])
    const arr = recentByAgent.get(e.from_agent_id)!
    if (arr.length < 10) arr.push({ type: e.type, weight: e.weight, created_at: e.created_at })
  }

  const tierNames = ['Base', 'Extended', 'Privileged']

  return agents.map(agent => ({
    agentId: agent.id,
    personalityName: agent.personality_name,
    team: agent.team,
    cfs: agent.collaboration_score,
    tier: agent.tier,
    tierName: tierNames[agent.tier] ?? 'Base',
    eventCount: eventCounts.get(agent.id) ?? 0,
    recentEvents: recentByAgent.get(agent.id) ?? [],
  }))
}

// ---------------------------------------------------------------------------
// Get collaboration event history for an agent
// ---------------------------------------------------------------------------
export function getAgentCollaborationHistory(agentId: string): Array<{
  id: string
  eventType: string
  toAgentId: string
  weight: number
  phase: number
  created_at: string
}> {
  const db = getDb()
  return db.query(`
    SELECT ce.id, ce.event_type as eventType, ce.to_agent_id as toAgentId,
           ce.weight, ce.phase, ce.created_at
    FROM collaboration_events ce
    WHERE ce.from_agent_id = ?
    ORDER BY ce.created_at DESC
    LIMIT 50
  `).all(agentId) as any[]
}
