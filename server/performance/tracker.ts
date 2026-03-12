import { getDb } from '../db/database'
import { logActivity } from '../activity'

// ---------------------------------------------------------------------------
// Performance Tracker -- per-agent scorecards at sprint boundaries
//
// Grades: A (excellent), B (solid), C (average), D (underperforming), F (failing)
// Tracked metrics: delivery rate, CFS, blockers, review quality, handoff rate
// ---------------------------------------------------------------------------

interface AgentScorecard {
  agentId: string
  personalityName: string
  team: string
  tasksAssigned: number
  tasksCompleted: number
  deliveryRate: number
  cfsScore: number
  blockerCount: number
  reviewQualityAvg: number
  handoffRate: number
  overallGrade: string
}

export function generatePerformanceScorecard(sprintId: string, phase: number): AgentScorecard[] {
  const db = getDb()

  const agents = db.query(`SELECT id, personality_name, team FROM agents`).all() as any[]
  const scorecards: AgentScorecard[] = []

  for (const agent of agents) {
    // Task delivery
    const taskStats = db.query(`
      SELECT
        COUNT(*) as assigned,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
      FROM actions WHERE agent_id = ? AND sprint_id = ?
    `).get(agent.id, sprintId) as { assigned: number; completed: number }

    const deliveryRate = taskStats.assigned > 0
      ? (taskStats.completed ?? 0) / taskStats.assigned
      : 0

    // CFS score
    const cfs = db.query(`
      SELECT collaboration_score FROM agents WHERE id = ?
    `).get(agent.id) as { collaboration_score: number }

    // Blocker count (this sprint)
    const blockers = db.query(`
      SELECT COUNT(*) as n FROM blocked_agents
      WHERE agent_id = ? AND created_at >= (SELECT started_at FROM sprints WHERE id = ?)
    `).get(agent.id, sprintId) as { n: number }

    // Handoff rate: tasks with HANDOFF tag in output / total completed tasks
    const handoffs = db.query(`
      SELECT
        SUM(CASE WHEN output LIKE '%[HANDOFF%' THEN 1 ELSE 0 END) as with_handoff,
        COUNT(*) as total
      FROM actions
      WHERE agent_id = ? AND sprint_id = ? AND status = 'completed'
    `).get(agent.id, sprintId) as { with_handoff: number; total: number }

    const handoffRate = handoffs.total > 0
      ? (handoffs.with_handoff ?? 0) / handoffs.total
      : 0

    // Review quality: average from reviews of this agent's work
    // Look for review tasks that mention this agent
    const reviews = db.query(`
      SELECT output FROM actions
      WHERE type = 'review' AND description LIKE ? AND status = 'completed' AND phase = ?
    `).all(`%${agent.personality_name}%`, phase) as { output: string }[]

    let reviewQualityAvg = 0.5 // default: solid
    if (reviews.length > 0) {
      let sum = 0
      for (const r of reviews) {
        if (!r.output) continue
        const lower = r.output.toLowerCase()
        // Count positive and negative signal words (handles negation like "not exceptional")
        const positiveWords = ['exceptional', 'excellent', 'outstanding', 'impressive', 'thorough', 'comprehensive']
        const solidWords = ['solid', 'strong', 'good', 'competent', 'reliable', 'effective']
        const negativeWords = ['needs work', 'missing', 'incomplete', 'weak', 'poor', 'insufficient', 'lacking']
        const negationPattern = /\b(not|no|isn't|wasn't|hardly|barely|far from|never)\b/

        // Check for negated positives (e.g., "not exceptional" = negative)
        let posScore = 0
        let negScore = 0
        for (const word of positiveWords) {
          const idx = lower.indexOf(word)
          if (idx >= 0) {
            // Check 30 chars before for negation
            const prefix = lower.slice(Math.max(0, idx - 30), idx)
            if (negationPattern.test(prefix)) negScore++
            else posScore++
          }
        }
        for (const word of solidWords) {
          if (lower.includes(word)) posScore += 0.5
        }
        for (const word of negativeWords) {
          if (lower.includes(word)) negScore++
        }

        const total = posScore + negScore
        if (total === 0) sum += 0.5
        else sum += Math.max(0, Math.min(1, posScore / total))
      }
      reviewQualityAvg = sum / reviews.length
    }

    // Calculate overall grade
    const grade = calculateGrade(deliveryRate, cfs.collaboration_score ?? 0, blockers.n, reviewQualityAvg, handoffRate)

    const scorecard: AgentScorecard = {
      agentId: agent.id,
      personalityName: agent.personality_name,
      team: agent.team,
      tasksAssigned: taskStats.assigned,
      tasksCompleted: taskStats.completed ?? 0,
      deliveryRate,
      cfsScore: cfs.collaboration_score ?? 0,
      blockerCount: blockers.n,
      reviewQualityAvg,
      handoffRate,
      overallGrade: grade,
    }

    scorecards.push(scorecard)

    // Store in DB
    db.run(`
      INSERT INTO agent_performance (id, agent_id, sprint_id, tasks_assigned, tasks_completed,
        delivery_rate, cfs_score, blocker_count, review_quality_avg, handoff_rate, overall_grade)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      crypto.randomUUID(),
      agent.id,
      sprintId,
      taskStats.assigned,
      taskStats.completed ?? 0,
      deliveryRate,
      cfs.collaboration_score ?? 0,
      blockers.n,
      reviewQualityAvg,
      handoffRate,
      grade,
    ])
  }

  logActivity({
    agentId: 'system',
    phase,
    eventType: 'performance_review',
    summary: `Performance scorecards generated for ${scorecards.length} agents. Grades: ${scorecards.filter(s => s.overallGrade === 'A').length}A, ${scorecards.filter(s => s.overallGrade === 'B').length}B, ${scorecards.filter(s => s.overallGrade === 'C').length}C, ${scorecards.filter(s => s.overallGrade === 'D').length}D, ${scorecards.filter(s => s.overallGrade === 'F').length}F`,
  })

  return scorecards
}

function calculateGrade(
  deliveryRate: number,
  cfsScore: number,
  blockerCount: number,
  reviewQuality: number,
  handoffRate: number,
): string {
  // Weighted score (0-100)
  let score = 0

  // Delivery rate: 40% weight
  score += deliveryRate * 40

  // Review quality: 25% weight
  score += reviewQuality * 25

  // CFS: normalize dynamically against actual max across all agents
  // (was hardcoded /50 which flattens once rainmaker bonuses accumulate)
  const db = getDb()
  const maxCfs = (db.query(`
    SELECT MAX(collaboration_score) as m FROM agents
  `).get() as { m: number | null })?.m ?? 1
  const cfsCeiling = Math.max(maxCfs, 1) // avoid div by zero
  score += Math.min(cfsScore / cfsCeiling, 1) * 15

  // Handoff rate: 10% weight
  score += handoffRate * 10

  // Blocker penalty: -5 per blocker, max -10
  score -= Math.min(blockerCount * 5, 10)

  if (score >= 80) return 'A'
  if (score >= 65) return 'B'
  if (score >= 45) return 'C'
  if (score >= 25) return 'D'
  return 'F'
}

// Check for agents needing warnings or reassignment
export function checkPerformanceActions(phase: number): void {
  const db = getDb()

  // Get agents with D or F grades in last 2 sprints
  const underperformers = db.query(`
    SELECT agent_id, COUNT(*) as bad_sprints,
      GROUP_CONCAT(overall_grade) as grades
    FROM agent_performance
    WHERE overall_grade IN ('D', 'F')
    AND sprint_id IN (SELECT id FROM sprints ORDER BY number DESC LIMIT 2)
    GROUP BY agent_id
    HAVING bad_sprints >= 2
  `).all() as any[]

  for (const up of underperformers) {
    // Check if warning already issued
    const existing = db.query(`
      SELECT 1 FROM roster_changes
      WHERE agent_id = ? AND change_type = 'warning'
      AND created_at > datetime('now', '-1 hour')
    `).get(up.agent_id)

    if (existing) continue

    const agentName = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(up.agent_id) as any)?.personality_name

    // Issue performance warning
    db.run(`
      INSERT INTO roster_changes (id, agent_id, change_type, reason, created_at)
      VALUES (?, ?, 'warning', ?, datetime('now'))
    `, [crypto.randomUUID(), up.agent_id, `Underperforming for 2 consecutive sprints (grades: ${up.grades})`])

    logActivity({
      agentId: up.agent_id,
      phase,
      eventType: 'performance_warning',
      summary: `${agentName} received performance warning: grades ${up.grades} in last 2 sprints`,
    })

    console.log(`[PERFORMANCE] Warning issued to ${agentName}: ${up.grades}`)
  }
}
