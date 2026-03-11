import { getDb } from '../db/database'
import { logActivity } from '../activity'

// ---------------------------------------------------------------------------
// Roster Manager -- handles warnings, reassignments, promotions
//
// Triggered at sprint boundaries by the performance tracker.
// Checks agent_performance history and applies consequences:
// - Warning: D/F for 2+ sprints
// - Reassignment: D/F for 3+ sprints (prompt rewrite)
// - Promotion: A for 3+ sprints (expanded authority)
// ---------------------------------------------------------------------------

function genId(): string {
  return `roster-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

interface RosterAction {
  agentId: string
  agentName: string
  changeType: 'warning' | 'reassignment' | 'promotion'
  reason: string
  sprintId: string
}

// ---------------------------------------------------------------------------
// Evaluate all agents and return roster actions
// ---------------------------------------------------------------------------
export function evaluateRoster(currentSprintId: string, phase: number): RosterAction[] {
  const db = getDb()
  const actions: RosterAction[] = []

  const agents = db.query(`SELECT id, personality_name, team, role FROM agents WHERE status != 'deactivated'`).all() as any[]

  for (const agent of agents) {
    // Skip system agents (Morgan is PM, always needed)
    if (agent.id === 'morgan') continue

    const history = db.query(`
      SELECT overall_grade, sprint_id FROM agent_performance
      WHERE agent_id = ?
      ORDER BY created_at DESC LIMIT 5
    `).all(agent.id) as { overall_grade: string; sprint_id: string }[]

    if (history.length < 2) continue // need at least 2 sprints of data

    const recentGrades = history.map(h => h.overall_grade)

    // Check for promotion: A for 3+ consecutive sprints
    const consecutiveAs = recentGrades.findIndex(g => g !== 'A')
    if (consecutiveAs >= 3 || (consecutiveAs === -1 && recentGrades.length >= 3)) {
      // Check if already promoted recently
      const recentPromo = db.query(`
        SELECT 1 FROM roster_changes WHERE agent_id = ? AND change_type = 'promotion'
        AND created_at > datetime('now', '-1 hour')
      `).get(agent.id)

      if (!recentPromo) {
        actions.push({
          agentId: agent.id,
          agentName: agent.personality_name,
          changeType: 'promotion',
          reason: `Consistent A-grade performance over ${Math.min(consecutiveAs === -1 ? recentGrades.length : consecutiveAs, 5)} sprints`,
          sprintId: currentSprintId,
        })
      }
    }

    // Check for warning: D or F for 2+ of the last 3 sprints
    const poorCount = recentGrades.slice(0, 3).filter(g => g === 'D' || g === 'F').length
    if (poorCount >= 2) {
      // Check if already warned recently
      const recentWarning = db.query(`
        SELECT 1 FROM roster_changes WHERE agent_id = ? AND change_type IN ('warning', 'reassignment')
        AND created_at > datetime('now', '-30 minutes')
      `).get(agent.id)

      if (!recentWarning) {
        // Check total warnings -- 3+ triggers reassignment
        const totalWarnings = db.query(`
          SELECT COUNT(*) as n FROM roster_changes WHERE agent_id = ? AND change_type = 'warning'
        `).get(agent.id) as { n: number }

        if (totalWarnings.n >= 2) {
          actions.push({
            agentId: agent.id,
            agentName: agent.personality_name,
            changeType: 'reassignment',
            reason: `${totalWarnings.n + 1} performance warnings. Grades: ${recentGrades.join(', ')}. Prompt will be adjusted for more structured output.`,
            sprintId: currentSprintId,
          })
        } else {
          actions.push({
            agentId: agent.id,
            agentName: agent.personality_name,
            changeType: 'warning',
            reason: `Poor performance: grades ${recentGrades.slice(0, 3).join(', ')} over last 3 sprints`,
            sprintId: currentSprintId,
          })
        }
      }
    }
  }

  return actions
}

// ---------------------------------------------------------------------------
// Apply roster actions
// ---------------------------------------------------------------------------
export function applyRosterActions(actions: RosterAction[], phase: number): void {
  const db = getDb()

  for (const action of actions) {
    const id = genId()

    db.run(`
      INSERT INTO roster_changes (id, agent_id, change_type, reason, sprint_id, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `, [id, action.agentId, action.changeType, action.reason, action.sprintId])

    logActivity({
      agentId: action.agentId,
      phase,
      eventType: `roster_${action.changeType}`,
      summary: `${action.agentName}: ${action.changeType} -- ${action.reason}`,
    })

    console.log(`[ROSTER] ${action.changeType.toUpperCase()}: ${action.agentName} -- ${action.reason}`)

    // For warnings, add context to agent's next task
    if (action.changeType === 'warning') {
      db.run(`
        INSERT OR IGNORE INTO blocked_agents (id, agent_id, reason, created_at)
        VALUES (?, ?, ?, datetime('now'))
      `, [
        `perf-warn-${action.agentId}-${Date.now()}`,
        action.agentId,
        `[PERFORMANCE WARNING] ${action.reason}. Focus on quality and completeness.`,
      ])
    }

    // For promotions, log the expanded authority
    if (action.changeType === 'promotion') {
      // Increase tier if possible
      const currentTier = db.query(`SELECT tier FROM capability_tiers WHERE agent_id = ?`).get(action.agentId) as { tier: number } | null
      if (currentTier && currentTier.tier > 0) {
        db.run(`UPDATE capability_tiers SET tier = ? WHERE agent_id = ?`, [currentTier.tier - 1, action.agentId])
        db.run(`UPDATE roster_changes SET new_config = ? WHERE id = ?`, [
          JSON.stringify({ tier: currentTier.tier - 1, previous_tier: currentTier.tier }),
          id,
        ])
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry: run at sprint boundary
// ---------------------------------------------------------------------------
export function runRosterReview(sprintId: string, phase: number): void {
  const actions = evaluateRoster(sprintId, phase)
  if (actions.length > 0) {
    applyRosterActions(actions, phase)
  }
}
