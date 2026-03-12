import { getDb } from '../db/database'
import { sendMessage } from '../messages/bus'
import { getSimDay } from '../clock'

// ---------------------------------------------------------------------------
// Budget Enforcer — doc 6 Issue 11 + Daily Spend Caps (Endurance Overhaul)
//
// Three layers of budget protection:
//   1. Hard cap:        Total experiment budget ($200)
//   2. Daily cap:       $DAILY_SPEND_CAP per sim_day (default $6.66 = $200/30)
//   3. Phase ceiling:   Soft limits per phase (exec override allowed)
// ---------------------------------------------------------------------------

const COS_AGENT_ID = 'priya'
const FINANCE_AGENT_ID = 'alex'
const DEFAULT_DAILY_CAP = Number(process.env.DAILY_SPEND_CAP ?? 6.66)

export const PHASE_SPEND_CEILINGS: Record<number, number> = {
  1: 20,    // Phase 1 research
  2: 10,    // Phase 2 strategy
  3: 40,    // Phase 3 build
  4: 120,   // Phase 4 launch (main spend window)
  5: 30,    // Phase 5 optimization
}

// ---------------------------------------------------------------------------
// Get total actual spend (budget_entries + token_usage costs)
// ---------------------------------------------------------------------------
// Cache spend for 1 cycle to avoid repeated full-table aggregations
let _spendCache: { value: number; ts: number } = { value: 0, ts: 0 }
const SPEND_CACHE_TTL_MS = 5_000 // 5 seconds (half an orchestrator cycle)

function getTotalSpend(): number {
  const now = Date.now()
  if (now - _spendCache.ts < SPEND_CACHE_TTL_MS) return _spendCache.value

  const db = getDb()

  // Only count OPERATIONAL spend (real money: domains, hosting, ads, etc.)
  // API/token costs are sunk cost (Claude Max subscription) -- tracked separately
  const operationalSpend = (db.query(`
    SELECT COALESCE(SUM(ABS(amount)), 0) as total_spent
    FROM budget_entries
    WHERE amount < 0
      AND category NOT IN ('token_usage', 'api_cost')
      AND notes NOT LIKE '%token%'
  `).get() as { total_spent: number }).total_spent

  _spendCache = { value: operationalSpend, ts: now }
  return operationalSpend
}

// Separate query for API cost (informational only, NOT deducted from $200)
export function getApiCostTotal(): number {
  const db = getDb()
  try {
    return (db.query(`
      SELECT COALESCE(SUM(cost_total_usd), 0) as total_cost
      FROM token_usage
    `).get() as { total_cost: number }).total_cost
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Check total budget exhaustion
// ---------------------------------------------------------------------------
export function checkBudgetExhausted(): boolean {
  const totalBudget = Number(process.env.TOTAL_EXPERIMENT_BUDGET_USD ?? 200)
  return getTotalSpend() >= totalBudget
}

// ---------------------------------------------------------------------------
// Get remaining budget
// ---------------------------------------------------------------------------
export function getRemainingBudget(): number {
  const totalBudget = Number(process.env.TOTAL_EXPERIMENT_BUDGET_USD ?? 200)
  return totalBudget - getTotalSpend()
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
// Daily spend cap -- prevents front-loading and budget exhaustion
// ---------------------------------------------------------------------------
export function getDailySpend(simDay: number): number {
  const db = getDb()

  const row = db.query(`SELECT total_spent FROM daily_spend_tracking WHERE sim_day = ?`).get(simDay) as { total_spent: number } | null

  if (!row) {
    // Initialize tracking row for this day
    db.run(`
      INSERT OR IGNORE INTO daily_spend_tracking (sim_day, total_spent, daily_cap, updated_at)
      VALUES (?, 0, ?, datetime('now'))
    `, [simDay, DEFAULT_DAILY_CAP])
    return 0
  }

  return row.total_spent
}

export function checkDailySpendCap(amount: number): {
  allowed: boolean
  reason?: string
  currentSpend: number
  cap: number
} {
  const simDay = getSimDay()
  const db = getDb()

  // Single query for all daily tracking data (was 2 separate queries)
  const tracking = db.query(`
    SELECT total_spent, daily_cap, cap_overridden FROM daily_spend_tracking WHERE sim_day = ?
  `).get(simDay) as { total_spent: number; daily_cap: number; cap_overridden: number } | null

  if (!tracking) {
    // Initialize tracking row
    db.run(`
      INSERT OR IGNORE INTO daily_spend_tracking (sim_day, total_spent, daily_cap, updated_at)
      VALUES (?, 0, ?, datetime('now'))
    `, [simDay, DEFAULT_DAILY_CAP])
  }

  const currentSpend = tracking?.total_spent ?? 0
  const cap = tracking?.daily_cap ?? DEFAULT_DAILY_CAP
  const overridden = tracking?.cap_overridden === 1

  if (currentSpend + amount > cap && !overridden) {
    return {
      allowed: false,
      reason: `Daily spend cap exceeded: $${currentSpend.toFixed(2)} + $${amount.toFixed(2)} > $${cap.toFixed(2)} cap for Sim Day ${simDay}. CEO/CoS can issue "Cap Burst Day ${simDay}" decision to override.`,
      currentSpend,
      cap,
    }
  }

  return { allowed: true, currentSpend, cap }
}

export function overrideDailyCap(simDay: number, decisionId: string): void {
  const db = getDb()

  db.run(`
    INSERT INTO daily_spend_tracking (sim_day, total_spent, daily_cap, cap_overridden, override_decision_id, updated_at)
    VALUES (?, 0, ?, 1, ?, datetime('now'))
    ON CONFLICT(sim_day) DO UPDATE SET
      cap_overridden = 1,
      override_decision_id = ?,
      updated_at = datetime('now')
  `, [simDay, DEFAULT_DAILY_CAP, decisionId, decisionId])

  console.log(`[BUDGET] Daily cap overridden for Sim Day ${simDay} (decision: ${decisionId})`)
}

function updateDailySpend(amount: number): void {
  const db = getDb()
  const simDay = getSimDay()

  db.run(`
    INSERT INTO daily_spend_tracking (sim_day, total_spent, daily_cap, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(sim_day) DO UPDATE SET
      total_spent = total_spent + ?,
      updated_at = datetime('now')
  `, [simDay, amount, DEFAULT_DAILY_CAP, amount])
}

// ---------------------------------------------------------------------------
// Record a spend entry (with daily cap + ceiling check)
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

  // 1. Hard check: total budget (check remaining >= requested, not just exhausted)
  const remaining = getRemainingBudget()
  if (remaining <= 0) {
    return { allowed: false, reason: 'Total experiment budget exhausted ($200)' }
  }
  if (remaining < params.amount && !params.execOverride) {
    return { allowed: false, reason: `Insufficient budget: $${remaining.toFixed(2)} remaining, $${params.amount.toFixed(2)} requested` }
  }

  // 2. Daily cap check (between hard cap and phase ceiling)
  const dailyCheck = checkDailySpendCap(params.amount)
  if (!dailyCheck.allowed && !params.execOverride) {
    // Notify CoS about the daily cap hit
    sendMessage({
      fromAgentId: 'system',
      toAgentId: COS_AGENT_ID,
      subject: `Daily spend cap reached (Sim Day ${getSimDay()})`,
      body: `Daily cap: $${dailyCheck.cap.toFixed(2)}. Current: $${dailyCheck.currentSpend.toFixed(2)}. Requested: $${params.amount.toFixed(2)}.\n\nTo override: issue a "Cap Burst Day ${getSimDay()}" decision.`,
      priority: 'high',
    })
    return { allowed: false, reason: dailyCheck.reason }
  }

  // 3. Soft check: phase ceiling
  const withinCeiling = checkPhaseSpendCeiling(params.phase, params.amount)
  if (!withinCeiling && !params.execOverride) {
    return {
      allowed: false,
      reason: `Phase ${params.phase} spend ceiling exceeded. Requires exec override.`,
    }
  }

  // 4. Record the entry + update daily tracking
  const id = crypto.randomUUID()
  db.run(`
    INSERT INTO budget_entries (id, amount, category, agent_id, notes, phase)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, -Math.abs(params.amount), params.category, params.agentId, params.notes, params.phase])

  updateDailySpend(params.amount)

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
