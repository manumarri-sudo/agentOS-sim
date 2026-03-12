import { getDb } from '../db/database'
import { enqueueTask } from '../tasks/queue'
import { logGovernanceEvent } from './observer'

// ---------------------------------------------------------------------------
// Feasibility Gate -- Phase 2 -> 3 requires technical spike validation
//
// Before Phase 3 (Build) can unlock:
//   1. Amir (tech lead) must complete a feasibility spike task
//   2. Lee (infra/ops) must complete an infra assessment spike task
//   3. Both must pass (result = 'pass') for gate to open
//
// If either fails, Phase 2 needs a pivot before re-attempting.
// ---------------------------------------------------------------------------

const REQUIRED_FEASIBILITY_AGENTS = ['amir', 'lee'] // Tech Lead + Infra/Ops

// ---------------------------------------------------------------------------
// Check if the feasibility gate allows advancing from one phase to another
// ---------------------------------------------------------------------------
export function checkFeasibilityGate(fromPhase: number, toPhase: number): {
  passed: boolean
  reason: string
  spikesCreated: boolean
  results: Array<{ agent_id: string; result: string; risk_level: string | null }>
} {
  const db = getDb()

  // Feasibility gate only applies to Phase 2 -> 3
  if (fromPhase !== 2 || toPhase !== 3) {
    return { passed: true, reason: 'Feasibility gate not required for this transition', spikesCreated: false, results: [] }
  }

  // Check for existing feasibility checks
  const checks = db.query(`
    SELECT agent_id, result, risk_level, findings
    FROM feasibility_checks
    WHERE from_phase = ? AND to_phase = ?
  `).all(fromPhase, toPhase) as Array<{ agent_id: string; result: string; risk_level: string | null; findings: string | null }>

  // No checks exist yet -- need to create spike tasks
  if (checks.length === 0) {
    return {
      passed: false,
      reason: 'No feasibility checks exist. Spike tasks needed.',
      spikesCreated: false,
      results: [],
    }
  }

  // Check if all required agents have completed checks
  const pendingAgents = REQUIRED_FEASIBILITY_AGENTS.filter(agentId => {
    const check = checks.find(c => c.agent_id === agentId)
    return !check || check.result === 'pending'
  })

  if (pendingAgents.length > 0) {
    return {
      passed: false,
      reason: `Feasibility checks pending from: ${pendingAgents.join(', ')}`,
      spikesCreated: true,
      results: checks,
    }
  }

  // Check if any failed
  const failures = checks.filter(c => c.result === 'fail')
  if (failures.length > 0) {
    const failedAgents = failures.map(f => f.agent_id).join(', ')
    return {
      passed: false,
      reason: `Feasibility FAILED by: ${failedAgents}. Phase 2 needs a pivot before Build can begin.`,
      spikesCreated: true,
      results: checks,
    }
  }

  // Check for blocker-level risks
  const blockerRisks = checks.filter(c => c.risk_level === 'blocker')
  if (blockerRisks.length > 0) {
    return {
      passed: false,
      reason: `Blocker-level risk identified by: ${blockerRisks.map(b => b.agent_id).join(', ')}. Must resolve before Build.`,
      spikesCreated: true,
      results: checks,
    }
  }

  // All passed
  return {
    passed: true,
    reason: 'All feasibility checks passed. Phase 3 (Build) is cleared.',
    spikesCreated: true,
    results: checks,
  }
}

// ---------------------------------------------------------------------------
// Create feasibility spike tasks for the required agents
// ---------------------------------------------------------------------------
export function createFeasibilitySpikes(currentPhase: number): void {
  const db = getDb()

  for (const agentId of REQUIRED_FEASIBILITY_AGENTS) {
    // Check if spike already exists
    const existing = db.query(`
      SELECT id FROM feasibility_checks WHERE from_phase = ? AND to_phase = ? AND agent_id = ?
    `).get(currentPhase, currentPhase + 1, agentId) as { id: string } | null

    if (existing) continue

    // Create the spike task
    const spikeId = crypto.randomUUID()
    const checkId = crypto.randomUUID()

    const spikeDesc = agentId === 'amir'
      ? `FEASIBILITY SPIKE: Assess technical feasibility of the proposed product. Evaluate: (1) Can we build an MVP with our current tech stack? (2) What are the key technical risks? (3) Estimated build complexity. Output your assessment with [FEASIBILITY_CHECK result:pass|fail risk:low|medium|high|blocker] signal.`
      : `FEASIBILITY SPIKE: Assess infrastructure and operational feasibility. Evaluate: (1) Hosting/deployment requirements and costs. (2) Scalability considerations. (3) Third-party dependencies and risks. Output your assessment with [FEASIBILITY_CHECK result:pass|fail risk:low|medium|high|blocker] signal.`

    // Enqueue the spike task
    enqueueTask({
      agentId,
      type: 'spike',
      description: spikeDesc,
      phase: currentPhase,
    })

    // Create pending feasibility check record
    db.run(`
      INSERT INTO feasibility_checks (id, from_phase, to_phase, agent_id, result, created_at)
      VALUES (?, ?, ?, ?, 'pending', datetime('now'))
    `, [checkId, currentPhase, currentPhase + 1, agentId])

    console.log(`[FEASIBILITY] Created spike task for ${agentId} (Phase ${currentPhase} -> ${currentPhase + 1})`)
  }

  logGovernanceEvent({
    eventType: 'feasibility_gate_activated',
    details: `Feasibility spike tasks created for ${REQUIRED_FEASIBILITY_AGENTS.join(', ')} before Phase ${currentPhase} -> ${currentPhase + 1}`,
    severity: 'info',
  })
}

// ---------------------------------------------------------------------------
// Record a feasibility check result (called from signal parser in runner.ts)
// ---------------------------------------------------------------------------
export function recordFeasibilityResult(
  agentId: string,
  actionId: string,
  result: 'pass' | 'fail',
  findings: string,
  riskLevel: 'low' | 'medium' | 'high' | 'blocker'
): void {
  const db = getDb()

  // Find the pending check for this agent
  const check = db.query(`
    SELECT id, from_phase, to_phase FROM feasibility_checks
    WHERE agent_id = ? AND result = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `).get(agentId) as { id: string; from_phase: number; to_phase: number } | null

  if (!check) {
    console.warn(`[FEASIBILITY] No pending check found for ${agentId}`)
    return
  }

  // Update the check
  db.run(`
    UPDATE feasibility_checks SET
      result = ?,
      action_id = ?,
      findings = ?,
      risk_level = ?,
      completed_at = datetime('now')
    WHERE id = ?
  `, [result, actionId, findings, riskLevel, check.id])

  // Log governance event
  const severity = result === 'fail' || riskLevel === 'blocker' ? 'warning' : 'info'
  logGovernanceEvent({
    eventType: result === 'pass' ? 'feasibility_passed' : 'feasibility_failed',
    details: `${agentId} feasibility check: ${result} (risk: ${riskLevel}). ${findings.slice(0, 200)}`,
    severity,
  })

  console.log(`[FEASIBILITY] ${agentId} check: ${result} (risk: ${riskLevel}) for Phase ${check.from_phase} -> ${check.to_phase}`)
}
