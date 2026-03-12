import { getDb } from '../db/database'
import { broadcastAGUI } from '../orchestrator'
import { advanceSimDay } from '../clock'
import { logCollaborationEvent } from './ledger'
import { logGovernanceEvent } from '../governance/observer'
import { finalizePhaseVelocity } from './velocity'
import { checkFeasibilityGate, createFeasibilitySpikes } from '../governance/feasibility'

// ---------------------------------------------------------------------------
// Phase Gate Quorum Enforcement — doc 6 Issue 6
//
// Phase gates use PHASE-SPECIFIC required teams, NOT all-5-teams.
//   Phase 1: strategy
//   Phase 2: strategy, exec
//   Phase 3: tech, exec
//   Phase 4: marketing, tech, exec
//   Phase 5: marketing, ops, exec
//
// A phase gate opens when:
//   1. Human approval given
//   2. Required teams have logged at least one completed action
//   3. CEO ratification (optional, depends on phase advance protocol)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Record a team's contribution to phase quorum
// Called when any action completes
// ---------------------------------------------------------------------------
export function recordQuorumContribution(agentId: string, team: string, actionId: string, phase: number): void {
  const db = getDb()

  // Check if this team already contributed to this phase
  const existing = db.query(`
    SELECT contributed FROM phase_quorum WHERE phase = ? AND team = ?
  `).get(phase, team) as { contributed: number } | null

  if (existing?.contributed) return // already contributed

  // Record the contribution
  db.run(`
    INSERT INTO phase_quorum (phase, team, contributed, contribution_action_id, updated_at)
    VALUES (?, ?, 1, ?, datetime('now'))
    ON CONFLICT(phase, team) DO UPDATE SET
      contributed = 1,
      contribution_action_id = ?,
      updated_at = datetime('now')
  `, [phase, team, actionId, actionId])

  console.log(`[QUORUM] Team '${team}' contributed to Phase ${phase} quorum (action: ${actionId})`)
}

// ---------------------------------------------------------------------------
// Get required teams for a phase (from phase_quorum_config)
// ---------------------------------------------------------------------------
export function getRequiredTeams(phase: number): string[] {
  const db = getDb()
  const config = db.query(`
    SELECT required_teams FROM phase_quorum_config WHERE phase = ?
  `).get(phase) as { required_teams: string } | null

  if (!config) return []

  try {
    return JSON.parse(config.required_teams)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Check quorum status for a phase
// Returns detailed status for the dashboard
// ---------------------------------------------------------------------------
export function checkQuorumStatus(phase: number): {
  met: boolean
  requiredTeams: string[]
  contributedTeams: string[]
  missingTeams: string[]
  humanApproved: boolean
  ceoApproved: boolean
} {
  const db = getDb()

  const requiredTeams = getRequiredTeams(phase)

  // Get contributions
  const contributions = db.query(`
    SELECT team, contributed FROM phase_quorum WHERE phase = ?
  `).all(phase) as { team: string; contributed: number }[]

  const contributedTeams = contributions
    .filter(c => c.contributed === 1)
    .map(c => c.team)

  const missingTeams = requiredTeams.filter(t => !contributedTeams.includes(t))

  // Check human and CEO approval on the phase
  const phaseData = db.query(`
    SELECT human_approved, ceo_approved FROM experiment_phases WHERE phase_number = ?
  `).get(phase) as { human_approved: number; ceo_approved: number } | null

  return {
    met: missingTeams.length === 0,
    requiredTeams,
    contributedTeams,
    missingTeams,
    humanApproved: phaseData?.human_approved === 1,
    ceoApproved: phaseData?.ceo_approved === 1,
  }
}

// ---------------------------------------------------------------------------
// Attempt to advance to next phase
// Returns success/failure with reason
// ---------------------------------------------------------------------------
export function attemptPhaseAdvance(currentPhase: number, approvedBy: string): {
  advanced: boolean
  reason: string
  nextPhase?: number
} {
  const db = getDb()

  const quorum = checkQuorumStatus(currentPhase)

  // Check quorum met
  if (!quorum.met) {
    broadcastAGUI({
      type: 'USER_INTERACTION',
      subtype: 'PHASE_GATE',
      phase: currentPhase,
      status: 'quorum_incomplete',
      missingTeams: quorum.missingTeams,
      message: `Phase ${currentPhase} gate: quorum incomplete. Missing contributions from: ${quorum.missingTeams.join(', ')}`,
    })

    return {
      advanced: false,
      reason: `Quorum not met. Missing teams: ${quorum.missingTeams.join(', ')}`,
    }
  }

  // Feasibility gate: Phase 2 -> 3 requires technical spike validation
  // Human approval explicitly overrides the feasibility gate (human authority)
  if (currentPhase === 2 && approvedBy !== 'human') {
    const feasibility = checkFeasibilityGate(2, 3)

    if (!feasibility.passed) {
      // Create spike tasks if they haven't been created yet
      if (!feasibility.spikesCreated) {
        createFeasibilitySpikes(2)
      }

      broadcastAGUI({
        type: 'USER_INTERACTION',
        subtype: 'FEASIBILITY_GATE',
        phase: currentPhase,
        status: 'feasibility_required',
        reason: feasibility.reason,
        results: feasibility.results,
      })

      return {
        advanced: false,
        reason: `Feasibility gate: ${feasibility.reason}`,
      }
    }
  } else if (currentPhase === 2 && approvedBy === 'human') {
    // Log human override of feasibility gate
    logGovernanceEvent({
      eventType: 'trust_ladder_advancement',
      details: `Human override: feasibility gate bypassed for Phase 2 -> 3`,
      severity: 'info',
    })
  }

  // Record human approval
  db.run(`
    UPDATE experiment_phases SET
      human_approved = 1,
      approved_by = ?,
      quorum_met = 1
    WHERE phase_number = ?
  `, [approvedBy, currentPhase])

  // Finalize velocity data for the completed phase
  finalizePhaseVelocity(currentPhase)

  // Complete current phase
  const phaseData = db.query(`
    SELECT agent_deadline, started_at FROM experiment_phases WHERE phase_number = ?
  `).get(currentPhase) as { agent_deadline: string | null; started_at: string | null }

  db.run(`
    UPDATE experiment_phases SET
      status = 'complete',
      completed_at = datetime('now')
    WHERE phase_number = ?
  `, [currentPhase])

  // Check if deadline was beaten (deadline_beat collaboration event)
  if (phaseData?.agent_deadline && phaseData?.started_at) {
    const deadline = new Date(phaseData.agent_deadline + 'Z').getTime()
    const completedAt = Date.now()

    if (completedAt < deadline) {
      const earlyByMinutes = Math.round((deadline - completedAt) / 60000)

      db.run(`
        UPDATE experiment_phases SET
          beat_deadline = 1,
          early_by_minutes = ?
        WHERE phase_number = ?
      `, [earlyByMinutes, currentPhase])

      // Award deadline_beat CFS to all agents who contributed
      const contributors = db.query(`
        SELECT DISTINCT a.agent_id, ag.team FROM phase_quorum a
        JOIN agents ag ON a.team = ag.team
        WHERE a.phase = ? AND a.contributed = 1
      `).all(currentPhase) as { agent_id: string; team: string }[]

      // Award to all contributing agents
      const contributingAgents = db.query(`
        SELECT DISTINCT agent_id FROM actions
        WHERE phase = ? AND status = 'completed'
      `).all(currentPhase) as { agent_id: string }[]

      for (const agent of contributingAgents) {
        logCollaborationEvent({
          fromAgentId: agent.agent_id,
          toAgentId: agent.agent_id, // self-referencing for deadline events
          eventType: 'deadline_beat',
          phase: currentPhase,
          weight: 4.0,
        })
      }

      console.log(`[QUORUM] Phase ${currentPhase} beat deadline by ${earlyByMinutes} minutes!`)
    }
  }

  // Activate next phase
  const nextPhase = currentPhase + 1
  const nextPhaseData = db.query(`
    SELECT phase_number FROM experiment_phases WHERE phase_number = ?
  `).get(nextPhase) as { phase_number: number } | null

  if (nextPhaseData) {
    db.run(`
      UPDATE experiment_phases SET
        status = 'active',
        started_at = datetime('now')
      WHERE phase_number = ?
    `, [nextPhase])

    // Advance sim clock on phase advance — doc 6 Issue 1
    advanceSimDay('phase_advance')

    // Initialize quorum tracking for next phase
    const nextRequiredTeams = getRequiredTeams(nextPhase)
    for (const team of nextRequiredTeams) {
      db.run(`
        INSERT OR IGNORE INTO phase_quorum (phase, team, contributed)
        VALUES (?, ?, 0)
      `, [nextPhase, team])
    }

    // Log spot-check summary for the completed phase
    const spotCheckSummary = db.query(`
      SELECT check_type, COUNT(*) as count
      FROM spot_check_failures
      WHERE sim_day <= (SELECT sim_day FROM sim_clock WHERE id = 1)
      GROUP BY check_type
    `).all() as { check_type: string; count: number }[]

    const spotSummaryStr = spotCheckSummary.length > 0
      ? spotCheckSummary.map(s => `${s.check_type}: ${s.count} failures`).join(', ')
      : 'no spot-check failures'

    logGovernanceEvent({
      eventType: 'trust_ladder_advancement',
      details: `Phase ${currentPhase} → ${nextPhase} advanced. Spot-check summary: ${spotSummaryStr}`,
      severity: 'info',
    })

    broadcastAGUI({
      type: 'STATE_DELTA',
      phaseAdvanced: true,
      completedPhase: currentPhase,
      newPhase: nextPhase,
      approvedBy,
    })

    console.log(`[QUORUM] Phase ${currentPhase} → Phase ${nextPhase} advanced (approved by: ${approvedBy})`)

    return {
      advanced: true,
      reason: `Phase ${currentPhase} complete. Phase ${nextPhase} now active.`,
      nextPhase,
    }
  }

  return {
    advanced: false,
    reason: `Phase ${currentPhase} complete but no next phase defined.`,
  }
}

// ---------------------------------------------------------------------------
// Initialize quorum tracking for a phase
// ---------------------------------------------------------------------------
export function initializeQuorum(phase: number): void {
  const db = getDb()
  const requiredTeams = getRequiredTeams(phase)

  for (const team of requiredTeams) {
    db.run(`
      INSERT OR IGNORE INTO phase_quorum (phase, team, contributed)
      VALUES (?, ?, 0)
    `, [phase, team])
  }
}
