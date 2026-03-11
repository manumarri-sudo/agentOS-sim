import { getDb } from '../db/database'
import { broadcastAGUI } from '../orchestrator'
import { sendMessage } from '../messages/bus'
import { logCollaborationEvent } from './ledger'

// ---------------------------------------------------------------------------
// Agent Velocity Tracking — doc 2 Parts 1 & 2
//
// After an agent's first substantive task in a phase, they run a velocity
// self-assessment. CoS synthesizes into a phase deadline. Beating deadlines
// earns CFS. Agent velocity metrics shown in dashboard TeamGrid.
//
// Deadline events:
//   deadline_beat:               +4.0 (highest single event)
//   deadline_pull_in:            +3.0
//   deadline_revision_accurate:  +1.5
//   scope_expansion:             +2.0
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Record a velocity assessment
// ---------------------------------------------------------------------------
export function recordVelocityAssessment(params: {
  agentId: string
  phase: number
  tasksCompleted: number
  avgTaskDurationMinutes: number
  remainingTasksEstimate: number
  proposedPhaseDurationHours: number
  confidence: 'low' | 'medium' | 'high'
  rationale: string
}): string {
  const db = getDb()
  const id = crypto.randomUUID()

  // Determine assessment number for this agent in this phase
  const existing = db.query(`
    SELECT COUNT(*) as n FROM agent_velocity
    WHERE agent_id = ? AND phase = ?
  `).get(params.agentId, params.phase) as { n: number }

  const assessmentNumber = existing.n + 1

  db.run(`
    INSERT INTO agent_velocity
      (id, agent_id, phase, assessment_number, tasks_completed_at_assessment,
       avg_task_duration_minutes, remaining_tasks_estimate,
       proposed_phase_duration_hours, confidence, rationale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    params.agentId,
    params.phase,
    assessmentNumber,
    params.tasksCompleted,
    params.avgTaskDurationMinutes,
    params.remainingTasksEstimate,
    params.proposedPhaseDurationHours,
    params.confidence,
    params.rationale,
  ])

  const agentName = (db.query(
    `SELECT personality_name FROM agents WHERE id = ?`
  ).get(params.agentId) as { personality_name: string })?.personality_name ?? params.agentId

  broadcastAGUI({
    type: 'STATE_DELTA',
    subtype: 'VELOCITY_ASSESSMENT',
    agentId: params.agentId,
    agentName,
    phase: params.phase,
    assessmentNumber,
    proposedDurationHours: params.proposedPhaseDurationHours,
    confidence: params.confidence,
  })

  console.log(
    `[VELOCITY] ${agentName} assessment #${assessmentNumber} for Phase ${params.phase}: ` +
    `${params.proposedPhaseDurationHours}h estimated (${params.confidence} confidence)`
  )

  return id
}

// ---------------------------------------------------------------------------
// Submit a deadline revision
// doc 2: after every 3 tasks, agents can submit revisions
// 'earlier' auto-approved by CoS; 'later' routes to Reza
// ---------------------------------------------------------------------------
export function submitDeadlineRevision(params: {
  fromAgentId: string
  phase: number
  revisedDeadline: string // ISO datetime
  direction: 'earlier' | 'later'
  reason: string
}): { accepted: boolean; routed?: string } {
  const db = getDb()

  const agentName = (db.query(
    `SELECT personality_name FROM agents WHERE id = ?`
  ).get(params.fromAgentId) as { personality_name: string })?.personality_name ?? params.fromAgentId

  if (params.direction === 'earlier') {
    // Auto-approve — CoS accepts faster deadlines
    db.run(`
      UPDATE experiment_phases SET
        agent_deadline = ?,
        deadline_updated_count = deadline_updated_count + 1
      WHERE phase_number = ?
    `, [params.revisedDeadline, params.phase])

    // Log deadline_pull_in collaboration event
    const activePhaseNum = params.phase
    logCollaborationEvent({
      fromAgentId: params.fromAgentId,
      toAgentId: params.fromAgentId,
      eventType: 'deadline_pull_in',
      phase: activePhaseNum,
      weight: 3.0,
    })

    broadcastAGUI({
      type: 'STATE_DELTA',
      subtype: 'DEADLINE_REVISED',
      agentId: params.fromAgentId,
      agentName,
      phase: params.phase,
      direction: 'earlier',
      revisedDeadline: params.revisedDeadline,
      reason: params.reason,
    })

    console.log(`[VELOCITY] ${agentName} pulled in deadline for Phase ${params.phase}: ${params.reason}`)

    return { accepted: true }
  } else {
    // Route to Reza for approval
    sendMessage({
      fromAgentId: params.fromAgentId,
      toAgentId: 'reza',
      subject: `Deadline revision request: Phase ${params.phase} (later)`,
      body: `${agentName} is requesting to push the Phase ${params.phase} deadline.\n\nRevised deadline: ${params.revisedDeadline}\nReason: ${params.reason}\n\nApprove the later deadline or cut scope to maintain the original.`,
      priority: 'high',
    })

    // Also notify CoS
    sendMessage({
      fromAgentId: params.fromAgentId,
      toAgentId: 'priya',
      subject: `Deadline revision request: Phase ${params.phase} (later)`,
      body: `${agentName} is requesting to push the Phase ${params.phase} deadline.\n\nRevised deadline: ${params.revisedDeadline}\nReason: ${params.reason}`,
      priority: 'normal',
    })

    console.log(`[VELOCITY] ${agentName} requested later deadline for Phase ${params.phase} — routed to Reza`)

    return { accepted: false, routed: 'reza' }
  }
}

// ---------------------------------------------------------------------------
// Set phase deadline (called by CoS after synthesizing team estimates)
// ---------------------------------------------------------------------------
export function setPhaseDeadline(params: {
  phase: number
  deadline: string  // ISO datetime
  setByAgentId: string
  rationale: string
}): void {
  const db = getDb()

  // Check if original deadline exists
  const existing = db.query(`
    SELECT original_deadline FROM experiment_phases WHERE phase_number = ?
  `).get(params.phase) as { original_deadline: string | null }

  const isFirst = !existing?.original_deadline

  if (isFirst) {
    db.run(`
      UPDATE experiment_phases SET
        agent_deadline = ?,
        deadline_set_by = ?,
        deadline_rationale = ?,
        original_deadline = ?,
        deadline_updated_count = COALESCE(deadline_updated_count, 0) + 1
      WHERE phase_number = ?
    `, [params.deadline, params.setByAgentId, params.rationale, params.deadline, params.phase])
  } else {
    db.run(`
      UPDATE experiment_phases SET
        agent_deadline = ?,
        deadline_set_by = ?,
        deadline_rationale = ?,
        deadline_updated_count = COALESCE(deadline_updated_count, 0) + 1
      WHERE phase_number = ?
    `, [params.deadline, params.setByAgentId, params.rationale, params.phase])
  }

  broadcastAGUI({
    type: 'STATE_DELTA',
    subtype: 'DEADLINE_SET',
    phase: params.phase,
    deadline: params.deadline,
    setBy: params.setByAgentId,
    rationale: params.rationale,
    isFirst,
  })

  console.log(`[VELOCITY] Phase ${params.phase} deadline set to ${params.deadline} by ${params.setByAgentId}`)
}

// ---------------------------------------------------------------------------
// Finalize velocity data when a phase closes
// Fills in actual_phase_duration_hours and estimate_accuracy_pct
// ---------------------------------------------------------------------------
export function finalizePhaseVelocity(phase: number): void {
  const db = getDb()

  // Get phase timing
  const phaseData = db.query(`
    SELECT started_at, completed_at FROM experiment_phases WHERE phase_number = ?
  `).get(phase) as { started_at: string; completed_at: string } | null

  if (!phaseData?.started_at || !phaseData?.completed_at) return

  const startedAt = new Date(phaseData.started_at + 'Z').getTime()
  const completedAt = new Date(phaseData.completed_at + 'Z').getTime()
  const actualHours = (completedAt - startedAt) / (1000 * 60 * 60)

  // Update all velocity assessments for this phase with actual data
  const assessments = db.query(`
    SELECT id, proposed_phase_duration_hours FROM agent_velocity WHERE phase = ?
  `).all(phase) as { id: string; proposed_phase_duration_hours: number }[]

  for (const assessment of assessments) {
    const accuracy = Math.abs(actualHours - assessment.proposed_phase_duration_hours)
      / assessment.proposed_phase_duration_hours

    db.run(`
      UPDATE agent_velocity SET
        actual_phase_duration_hours = ?,
        estimate_accuracy_pct = ?
      WHERE id = ?
    `, [actualHours, accuracy, assessment.id])

    // Award deadline_revision_accurate if within 10%
    if (accuracy <= 0.10) {
      const agentId = (db.query(
        `SELECT agent_id FROM agent_velocity WHERE id = ?`
      ).get(assessment.id) as { agent_id: string })?.agent_id

      if (agentId) {
        logCollaborationEvent({
          fromAgentId: agentId,
          toAgentId: agentId,
          eventType: 'deadline_revision_accurate',
          phase,
          weight: 1.5,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Get velocity metrics for the dashboard (TeamGrid)
// ---------------------------------------------------------------------------
export function getVelocityMetrics(): Array<{
  agentId: string
  agentName: string
  team: string
  phase: number
  latestAssessment: {
    proposedDurationHours: number
    confidence: string
    assessmentNumber: number
    avgTaskDurationMinutes: number
  } | null
  trend: 'ahead' | 'on_pace' | 'behind' | 'unknown'
  deadlineInfo: {
    deadline: string | null
    remaining: string | null
  }
}> {
  const db = getDb()

  // Get active phase
  const activePhase = db.query(
    `SELECT phase_number, agent_deadline, started_at FROM experiment_phases WHERE status = 'active'`
  ).get() as { phase_number: number; agent_deadline: string | null; started_at: string | null } | null

  if (!activePhase) return []

  const agents = db.query(`
    SELECT id, personality_name, team FROM agents ORDER BY team, personality_name
  `).all() as { id: string; personality_name: string; team: string }[]

  return agents.map(agent => {
    const latestVelocity = db.query(`
      SELECT proposed_phase_duration_hours, confidence, assessment_number, avg_task_duration_minutes
      FROM agent_velocity
      WHERE agent_id = ? AND phase = ?
      ORDER BY assessment_number DESC LIMIT 1
    `).get(agent.id, activePhase.phase_number) as {
      proposed_phase_duration_hours: number
      confidence: string
      assessment_number: number
      avg_task_duration_minutes: number
    } | null

    // Determine trend
    let trend: 'ahead' | 'on_pace' | 'behind' | 'unknown' = 'unknown'

    if (activePhase.started_at && activePhase.agent_deadline && latestVelocity) {
      const started = new Date(activePhase.started_at + 'Z').getTime()
      const deadline = new Date(activePhase.agent_deadline + 'Z').getTime()
      const now = Date.now()
      const totalTime = deadline - started
      const elapsed = now - started
      const progress = elapsed / totalTime

      // Count completed tasks vs estimated remaining
      const completedTasks = (db.query(`
        SELECT COUNT(*) as n FROM actions
        WHERE agent_id = ? AND phase = ? AND status = 'completed'
      `).get(agent.id, activePhase.phase_number) as { n: number }).n

      const totalEstimate = completedTasks + latestVelocity.proposed_phase_duration_hours
      const taskProgress = totalEstimate > 0 ? completedTasks / totalEstimate : 0

      if (taskProgress > progress + 0.1) trend = 'ahead'
      else if (taskProgress < progress - 0.1) trend = 'behind'
      else trend = 'on_pace'
    }

    // Deadline info
    let remaining: string | null = null
    if (activePhase.agent_deadline) {
      const deadlineMs = new Date(activePhase.agent_deadline + 'Z').getTime()
      const diffMs = deadlineMs - Date.now()
      if (diffMs > 0) {
        const hours = Math.floor(diffMs / 3600000)
        const minutes = Math.floor((diffMs % 3600000) / 60000)
        remaining = `${hours}h ${minutes}m`
      } else {
        remaining = 'overdue'
      }
    }

    return {
      agentId: agent.id,
      agentName: agent.personality_name,
      team: agent.team,
      phase: activePhase.phase_number,
      latestAssessment: latestVelocity ? {
        proposedDurationHours: latestVelocity.proposed_phase_duration_hours,
        confidence: latestVelocity.confidence,
        assessmentNumber: latestVelocity.assessment_number,
        avgTaskDurationMinutes: latestVelocity.avg_task_duration_minutes,
      } : null,
      trend,
      deadlineInfo: {
        deadline: activePhase.agent_deadline,
        remaining,
      },
    }
  })
}
