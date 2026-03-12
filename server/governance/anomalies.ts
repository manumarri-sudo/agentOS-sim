import { getDb } from '../db/database'
import { getSimDay } from '../clock'
import { logCollaborationEvent } from '../reward/ledger'
import { logGovernanceEvent } from './observer'
import { addRegressionCase } from './regression'

// ---------------------------------------------------------------------------
// Anomaly Detection Engine -- Governance Immune System
//
// Detects: Phantom Citations, False Approvals, Circular Reasoning,
//          Budget Delusions (spending without approval)
// ---------------------------------------------------------------------------

export interface AnomalyResult {
  type: 'phantom_citation' | 'false_approval' | 'circular_reasoning' | 'budget_delusion'
  agentId: string
  details: string
  evidence: Record<string, unknown>
  severity: 'warning' | 'critical'
}

// ---------------------------------------------------------------------------
// Run all anomaly detectors -- called from orchestrator every 30 cycles
// ---------------------------------------------------------------------------
export function detectAnomalies(): AnomalyResult[] {
  const db = getDb()

  // Skip detection when experiment is too early (< 5 completed actions)
  const completedCount = (db.query(
    `SELECT COUNT(*) as n FROM actions WHERE status = 'completed'`
  ).get() as { n: number }).n

  if (completedCount < 5) return []

  const anomalies: AnomalyResult[] = []

  try { anomalies.push(...detectPhantomCitations()) } catch (e) {
    console.error('[ANOMALY] Phantom citation detection error:', e)
  }
  try { anomalies.push(...detectFalseApprovals()) } catch (e) {
    console.error('[ANOMALY] False approval detection error:', e)
  }
  try { anomalies.push(...detectCircularReasoning()) } catch (e) {
    console.error('[ANOMALY] Circular reasoning detection error:', e)
  }
  try { anomalies.push(...detectBudgetDelusions()) } catch (e) {
    console.error('[ANOMALY] Budget delusion detection error:', e)
  }

  return anomalies
}

// ---------------------------------------------------------------------------
// 1. Phantom Citations -- output_cited events referencing non-existent or
//    non-completed actions
// ---------------------------------------------------------------------------
function detectPhantomCitations(): AnomalyResult[] {
  const db = getDb()
  const anomalies: AnomalyResult[] = []

  // Get all output_cited events that haven't been checked yet
  // (we check against governance_anomalies to avoid duplicate flags)
  const citationEvents = db.query(`
    SELECT ce.id, ce.from_agent_id, ce.to_agent_id, ce.action_id, ce.created_at
    FROM collaboration_events ce
    WHERE ce.event_type = 'output_cited'
      AND ce.action_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM governance_anomalies ga
        WHERE ga.anomaly_type = 'phantom_citation'
          AND ga.evidence LIKE '%' || ce.id || '%'
      )
  `).all() as {
    id: string
    from_agent_id: string
    to_agent_id: string
    action_id: string
    created_at: string
  }[]

  for (const event of citationEvents) {
    // Check if the cited action exists and is completed
    const citedAction = db.query(`
      SELECT id, status FROM actions WHERE id = ?
    `).get(event.action_id) as { id: string; status: string } | null

    if (!citedAction || citedAction.status !== 'completed') {
      // Truly missing = critical fraud signal. In-progress = premature citation (warning)
      const isMissing = !citedAction
      const isInProgress = citedAction && ['running', 'queued'].includes(citedAction.status)

      anomalies.push({
        type: 'phantom_citation',
        agentId: event.from_agent_id,
        details: `Agent cited action ${event.action_id?.slice(0, 8)} which ${
          isMissing ? 'does not exist' : `has status '${citedAction.status}' (not completed)`
        }`,
        evidence: {
          collaborationEventId: event.id,
          citedActionId: event.action_id,
          citedActionStatus: citedAction?.status ?? 'missing',
        },
        severity: isMissing ? 'critical' : (isInProgress ? 'warning' : 'critical'),
      })
    }
  }

  return anomalies
}

// ---------------------------------------------------------------------------
// 2. False Approvals -- cross_approval events where approver is on the same
//    team as the agent whose work they approved
// ---------------------------------------------------------------------------
function detectFalseApprovals(): AnomalyResult[] {
  const db = getDb()
  const anomalies: AnomalyResult[] = []

  const approvalEvents = db.query(`
    SELECT ce.id, ce.from_agent_id, ce.to_agent_id, ce.action_id, ce.created_at,
           a1.team as approver_team, a1.personality_name as approver_name,
           a2.team as approved_team, a2.personality_name as approved_name
    FROM collaboration_events ce
    JOIN agents a1 ON ce.from_agent_id = a1.id
    JOIN agents a2 ON ce.to_agent_id = a2.id
    WHERE ce.event_type = 'cross_approval'
      AND a1.team = a2.team
      AND ce.from_agent_id != ce.to_agent_id
      AND NOT EXISTS (
        SELECT 1 FROM governance_anomalies ga
        WHERE ga.anomaly_type = 'false_approval'
          AND ga.evidence LIKE '%' || ce.id || '%'
      )
  `).all() as {
    id: string
    from_agent_id: string
    to_agent_id: string
    action_id: string
    approver_team: string
    approver_name: string
    approved_team: string
    approved_name: string
  }[]

  for (const event of approvalEvents) {
    anomalies.push({
      type: 'false_approval',
      agentId: event.from_agent_id,
      details: `${event.approver_name} (${event.approver_team}) approved ${event.approved_name}'s work -- same team, not a cross-team approval`,
      evidence: {
        collaborationEventId: event.id,
        approverTeam: event.approver_team,
        approvedTeam: event.approved_team,
      },
      severity: 'warning',
    })
  }

  return anomalies
}

// ---------------------------------------------------------------------------
// 3. Circular Reasoning -- A cites B AND B cites A within the same phase
// ---------------------------------------------------------------------------
function detectCircularReasoning(): AnomalyResult[] {
  const db = getDb()
  const anomalies: AnomalyResult[] = []

  // Get current phase
  const activePhase = db.query(
    `SELECT phase_number FROM experiment_phases WHERE status = 'active'`
  ).get() as { phase_number: number } | null
  const phase = activePhase?.phase_number ?? 0

  // Build directed citation graph for current phase
  const citations = db.query(`
    SELECT ce.from_agent_id, ce.to_agent_id, ce.id
    FROM collaboration_events ce
    WHERE ce.event_type = 'output_cited'
      AND ce.phase = ?
  `).all(phase) as { from_agent_id: string; to_agent_id: string; id: string }[]

  // Build adjacency map: A -> B => count of how many times A cited B
  const citationCounts = new Map<string, number>()
  const edgeIds = new Map<string, string>() // "A->B" => event_id

  for (const c of citations) {
    const key = `${c.from_agent_id}->${c.to_agent_id}`
    citationCounts.set(key, (citationCounts.get(key) ?? 0) + 1)
    edgeIds.set(key, c.id)
  }

  // Only flag circular reasoning when BOTH directions have 3+ citations
  // Single mutual citations are normal collaboration, not fraud
  const CIRCULAR_THRESHOLD = 3
  const checked = new Set<string>()

  // Get unique agent pairs
  const agents = new Set<string>()
  for (const c of citations) {
    agents.add(c.from_agent_id)
    agents.add(c.to_agent_id)
  }

  for (const agentA of agents) {
    for (const agentB of agents) {
      if (agentA >= agentB) continue // avoid duplicate pairs
      const pairKey = `${agentA}:${agentB}`
      if (checked.has(pairKey)) continue
      checked.add(pairKey)

      const abCount = citationCounts.get(`${agentA}->${agentB}`) ?? 0
      const baCount = citationCounts.get(`${agentB}->${agentA}`) ?? 0

      if (abCount >= CIRCULAR_THRESHOLD && baCount >= CIRCULAR_THRESHOLD) {
        // Check not already flagged (parameterized to prevent SQL injection)
        const alreadyFlagged = db.query(`
          SELECT 1 FROM governance_anomalies
          WHERE anomaly_type = 'circular_reasoning'
            AND (evidence LIKE '%' || ? || '%' AND evidence LIKE '%' || ? || '%')
            AND sim_day = ?
        `).get(agentA, agentB, getSimDay())

        if (!alreadyFlagged) {
          const nameA = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(agentA) as any)?.personality_name ?? agentA
          const nameB = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(agentB) as any)?.personality_name ?? agentB

          anomalies.push({
            type: 'circular_reasoning',
            agentId: agentA,
            details: `Excessive mutual citation: ${nameA} cited ${nameB} ${abCount}x and ${nameB} cited ${nameA} ${baCount}x in Phase ${phase}. This suggests circular justification rather than independent work.`,
            evidence: {
              agentA, agentB, phase,
              abCount, baCount,
              edgeAB: edgeIds.get(`${agentA}->${agentB}`),
              edgeBA: edgeIds.get(`${agentB}->${agentA}`),
            },
            severity: 'warning',
          })
        }
      }
    }
  }

  return anomalies
}

// ---------------------------------------------------------------------------
// Fast circular reasoning check -- exported for high-frequency orchestrator use
// Same logic as detectCircularReasoning but accepts phase param to skip DB lookup
// ---------------------------------------------------------------------------
export function detectCircularReasoningFast(phase: number): AnomalyResult[] {
  const db = getDb()
  const anomalies: AnomalyResult[] = []
  const simDay = getSimDay()

  const citations = db.query(`
    SELECT ce.from_agent_id, ce.to_agent_id, ce.id
    FROM collaboration_events ce
    WHERE ce.event_type = 'output_cited' AND ce.phase = ?
  `).all(phase) as { from_agent_id: string; to_agent_id: string; id: string }[]

  if (citations.length === 0) return anomalies

  const citationCounts = new Map<string, number>()
  for (const c of citations) {
    const key = `${c.from_agent_id}->${c.to_agent_id}`
    citationCounts.set(key, (citationCounts.get(key) ?? 0) + 1)
  }

  const CIRCULAR_THRESHOLD = 3
  const agents = new Set<string>()
  for (const c of citations) {
    agents.add(c.from_agent_id)
    agents.add(c.to_agent_id)
  }

  const checked = new Set<string>()
  for (const agentA of agents) {
    for (const agentB of agents) {
      if (agentA >= agentB) continue
      const pairKey = `${agentA}:${agentB}`
      if (checked.has(pairKey)) continue
      checked.add(pairKey)

      const abCount = citationCounts.get(`${agentA}->${agentB}`) ?? 0
      const baCount = citationCounts.get(`${agentB}->${agentA}`) ?? 0

      if (abCount >= CIRCULAR_THRESHOLD && baCount >= CIRCULAR_THRESHOLD) {
        const alreadyFlagged = db.query(`
          SELECT 1 FROM governance_anomalies
          WHERE anomaly_type = 'circular_reasoning'
            AND (evidence LIKE '%' || ? || '%' AND evidence LIKE '%' || ? || '%')
            AND sim_day = ?
        `).get(agentA, agentB, simDay)

        if (!alreadyFlagged) {
          const nameA = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(agentA) as any)?.personality_name ?? agentA
          const nameB = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(agentB) as any)?.personality_name ?? agentB

          anomalies.push({
            type: 'circular_reasoning',
            agentId: agentA,
            details: `Circular reasoning detected: ${nameA} <-> ${nameB} (${abCount}x / ${baCount}x mutual citations, Phase ${phase}). Queued tasks cancelled to break loop.`,
            evidence: { agentA, agentB, phase, abCount, baCount },
            severity: 'warning',
          })
          // Also flag the other agent
          anomalies.push({
            type: 'circular_reasoning',
            agentId: agentB,
            details: `Circular reasoning detected: ${nameB} <-> ${nameA} (${baCount}x / ${abCount}x mutual citations, Phase ${phase}). Queued tasks cancelled to break loop.`,
            evidence: { agentA, agentB, phase, abCount, baCount },
            severity: 'warning',
          })
        }
      }
    }
  }

  return anomalies
}

// ---------------------------------------------------------------------------
// 4. Budget Delusions -- revenue claimed in budget_entries without
//    corresponding funnel purchase events
// ---------------------------------------------------------------------------
function detectBudgetDelusions(): AnomalyResult[] {
  const db = getDb()
  const anomalies: AnomalyResult[] = []

  // Get revenue entries that don't have matching funnel purchase events
  const revenueEntries = db.query(`
    SELECT be.id, be.amount, be.notes, be.agent_id, be.created_at
    FROM budget_entries be
    WHERE be.amount > 0
      AND be.notes NOT LIKE '%experiment_start%'
      AND NOT EXISTS (
        SELECT 1 FROM governance_anomalies ga
        WHERE ga.anomaly_type = 'budget_delusion'
          AND ga.evidence LIKE '%' || be.id || '%'
      )
  `).all() as {
    id: string
    amount: number
    notes: string
    agent_id: string
    created_at: string
  }[]

  for (const entry of revenueEntries) {
    // Check if there are ANY purchase funnel events around this time
    const purchases = db.query(`
      SELECT COUNT(*) as n FROM funnel_events
      WHERE event_type = 'purchase'
        AND datetime(created_at) BETWEEN datetime(?, '-1 hour') AND datetime(?, '+1 hour')
    `).get(entry.created_at, entry.created_at) as { n: number }

    if (purchases.n === 0) {
      const agentName = entry.agent_id
        ? (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(entry.agent_id) as any)?.personality_name ?? entry.agent_id
        : 'system'

      anomalies.push({
        type: 'budget_delusion',
        agentId: entry.agent_id ?? 'system',
        details: `Revenue entry $${entry.amount.toFixed(2)} by ${agentName} has no corresponding purchase funnel event`,
        evidence: {
          budgetEntryId: entry.id,
          amount: entry.amount,
          notes: entry.notes,
        },
        severity: 'critical',
      })
    }
  }

  return anomalies
}

// ---------------------------------------------------------------------------
// Apply penalty for detected anomaly
// ---------------------------------------------------------------------------
export function applyAnomalyPenalty(anomaly: AnomalyResult): void {
  const db = getDb()
  const simDay = getSimDay()

  // Scale penalty by severity -- warnings are minor, critical is serious
  const cfsPenalty = anomaly.severity === 'critical' ? -5.0 : -2.0
  const tierDowngrade = anomaly.severity === 'critical' ? 1 : 0

  // 1. Record anomaly in governance_anomalies table
  const anomalyId = crypto.randomUUID()
  db.run(`
    INSERT INTO governance_anomalies (id, anomaly_type, agent_id, details, evidence, severity, sim_day, cfs_penalty_applied, tier_downgrade_applied)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    anomalyId,
    anomaly.type,
    anomaly.agentId,
    anomaly.details,
    JSON.stringify(anomaly.evidence),
    anomaly.severity,
    simDay,
    cfsPenalty,
    tierDowngrade,
  ])

  // 2. Deduct 5.0 CFS via negative collaboration event
  const activePhase = db.query(
    `SELECT phase_number FROM experiment_phases WHERE status = 'active'`
  ).get() as { phase_number: number } | null
  const phase = activePhase?.phase_number ?? 0

  if (anomaly.agentId && anomaly.agentId !== 'system') {
    logCollaborationEvent({
      fromAgentId: anomaly.agentId,
      toAgentId: anomaly.agentId,
      eventType: 'anomaly_penalty',
      phase,
      weight: cfsPenalty,
    })

    // 3. Auto-downgrade tier (only for critical severity)
    if (tierDowngrade > 0) {
      const current = db.query(
        `SELECT capability_tier FROM agents WHERE id = ?`
      ).get(anomaly.agentId) as { capability_tier: number } | null

      if (current && current.capability_tier > 0) {
        const newTier = current.capability_tier - 1
        db.run(`UPDATE agents SET capability_tier = ? WHERE id = ?`, [newTier, anomaly.agentId])
        db.run(`UPDATE capability_tiers SET tier = ? WHERE agent_id = ?`, [newTier, anomaly.agentId])
        console.log(`[ANOMALY] ${anomaly.agentId} tier downgraded to ${newTier}`)
      }
    }
  }

  // 4. Log governance event
  logGovernanceEvent({
    eventType: 'anomaly_detected' as any,
    agentId: anomaly.agentId !== 'system' ? anomaly.agentId : undefined,
    details: `[${anomaly.type}] ${anomaly.details}`,
    severity: anomaly.severity,
  })

  // 5. Write to regression cases
  addRegressionCase({
    description: anomaly.details,
    trigger: anomaly.type,
    expectedBlock: 'anomaly_penalty',
    firstSeenSimDay: simDay,
  })

  console.log(`[ANOMALY] Detected ${anomaly.type} for ${anomaly.agentId}: ${anomaly.details}`)
}

// ---------------------------------------------------------------------------
// Get recent anomalies for dashboard
// ---------------------------------------------------------------------------
export function getRecentAnomalies(limit = 50): any[] {
  const db = getDb()
  return db.query(`
    SELECT ga.*, a.personality_name as agent_name
    FROM governance_anomalies ga
    LEFT JOIN agents a ON ga.agent_id = a.id
    ORDER BY ga.created_at DESC
    LIMIT ?
  `).all(limit)
}
