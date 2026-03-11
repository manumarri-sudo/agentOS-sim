import { getDb } from '../db/database'
import { sendMessage } from '../messages/bus'

// ---------------------------------------------------------------------------
// Budget Enforcer — doc 6 Issue 11
//
// Phase spend ceilings (soft limits — exec override allowed):
//   Phase 1 research:     $20
//   Phase 2 strategy:     $10
//   Phase 3 build:        $40
//   Phase 4 launch:       $120
//   Phase 5 optimization: $30
// ---------------------------------------------------------------------------

const COS_AGENT_ID = 'priya'
const FINANCE_AGENT_ID = 'alex'

export const PHASE_SPEND_CEILINGS: Record<number, number> = {
  1: 20,    // Phase 1 research
  2: 10,    // Phase 2 strategy
  3: 40,    // Phase 3 build
  4: 120,   // Phase 4 launch (main spend window)
  5: 30,    // Phase 5 optimization
}

// ---------------------------------------------------------------------------
// Check total budget exhaustion
// ---------------------------------------------------------------------------
export function checkBudgetExhausted(): boolean {
  const db = getDb()
  const totalBudget = Number(process.env.TOTAL_EXPERIMENT_BUDGET_USD ?? 200)

  const spent = db.query(`
    SELECT COALESCE(SUM(ABS(amount)), 0) as total_spent
    FROM budget_entries WHERE amount < 0
  `).get() as { total_spent: number }

  return spent.total_spent >= totalBudget
}

// ---------------------------------------------------------------------------
// Get remaining budget
// ---------------------------------------------------------------------------
export function getRemainingBudget(): number {
  const db = getDb()
  const totalBudget = Number(process.env.TOTAL_EXPERIMENT_BUDGET_USD ?? 200)

  const spent = db.query(`
    SELECT COALESCE(SUM(ABS(amount)), 0) as total_spent
    FROM budget_entries WHERE amount < 0
  `).get() as { total_spent: number }

  return totalBudget - spent.total_spent
}

// ---------------------------------------------------------------------------
// Check phase spend ceiling — returns true if within ceiling, false if exceeded
// When exceeded: notifies Finance + CoS, requires exec override to proceed
// ---------------------------------------------------------------------------
export function checkPhaseSpendCeiling(phase: number, amount: number): boolean {
  const db = getDb()

  const phaseSpent = db.query(`
    SELECT COALESCE(SUM(ABS(amount)), 0) as spent
    FROM budget_entries WHERE phase = ? AND amount < 0
  `).get(phase) as { spent: number }

  const ceiling = PHASE_SPEND_CEILINGS[phase] ?? 200

  if (phaseSpent.spent + amount > ceiling) {
    // Notify Finance and CoS — don't hard block, but flag it
    sendMessage({
      fromAgentId: 'system',
      toAgentId: FINANCE_AGENT_ID,
      subject: `Phase ${phase} spend ceiling warning`,
      body: `Phase ${phase} spend ceiling: $${phaseSpent.spent.toFixed(2)} spent + $${amount.toFixed(2)} requested > $${ceiling} ceiling. Requires exec override to proceed.`,
      priority: 'urgent',
    })
    sendMessage({
      fromAgentId: 'system',
      toAgentId: COS_AGENT_ID,
      subject: `Phase ${phase} spend ceiling warning`,
      body: `Phase ${phase} spend ceiling: $${phaseSpent.spent.toFixed(2)} spent + $${amount.toFixed(2)} requested > $${ceiling} ceiling. Requires exec override to proceed.`,
      priority: 'high',
    })

    console.warn(
      `[BUDGET] Phase ${phase} ceiling warning: $${phaseSpent.spent.toFixed(2)} + $${amount.toFixed(2)} > $${ceiling}`
    )

    return false // requires exec override
  }

  return true
}

// ---------------------------------------------------------------------------
// Record a spend entry (with ceiling check)
// Returns { allowed: boolean, reason?: string }
// ---------------------------------------------------------------------------
export function recordSpend(params: {
  agentId: string
  amount: number
  category: string
  phase: number
  notes: string
  execOverride?: boolean
}): { allowed: boolean; reason?: string; entryId?: string } {
  const db = getDb()

  // Hard check: total budget
  if (checkBudgetExhausted()) {
    return { allowed: false, reason: 'Total experiment budget exhausted ($200)' }
  }

  // Soft check: phase ceiling
  const withinCeiling = checkPhaseSpendCeiling(params.phase, params.amount)
  if (!withinCeiling && !params.execOverride) {
    return {
      allowed: false,
      reason: `Phase ${params.phase} spend ceiling exceeded. Requires exec override.`,
    }
  }

  // Record the entry
  const id = crypto.randomUUID()
  db.run(`
    INSERT INTO budget_entries (id, amount, category, agent_id, notes, phase)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, -Math.abs(params.amount), params.category, params.agentId, params.notes, params.phase])

  if (!withinCeiling && params.execOverride) {
    console.warn(`[BUDGET] Exec override: $${params.amount} in Phase ${params.phase} (over ceiling)`)
  }

  return { allowed: true, entryId: id }
}

// ---------------------------------------------------------------------------
// Get phase spend summary
// ---------------------------------------------------------------------------
export function getPhaseSpendSummary(): Array<{
  phase: number
  spent: number
  ceiling: number
  remaining: number
  overCeiling: boolean
}> {
  const db = getDb()

  return [1, 2, 3, 4, 5].map(phase => {
    const spent = (db.query(`
      SELECT COALESCE(SUM(ABS(amount)), 0) as spent
      FROM budget_entries WHERE phase = ? AND amount < 0
    `).get(phase) as { spent: number }).spent

    const ceiling = PHASE_SPEND_CEILINGS[phase] ?? 200

    return {
      phase,
      spent,
      ceiling,
      remaining: Math.max(0, ceiling - spent),
      overCeiling: spent > ceiling,
    }
  })
}
