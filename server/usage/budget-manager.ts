import { getDb } from '../db/database'
import { broadcastAGUI } from '../orchestrator'
import { sendMessage } from '../messages/bus'

// ---------------------------------------------------------------------------
// Usage Budget Manager — doc 8
//
// Protects Claude Max plan from overuse by 18 agents.
//
// Weekly budget targets:
//   Sonnet: 200 hours/week (conservative)
//   Opus:   16 hours/week (exec agents only)
//   Personal headroom: 40h Sonnet + 8h Opus always reserved
//
// Throttle levels (0-4):
//   0: Normal (6 agents)
//   1: Mild (70% used) → 4 agents
//   2: Moderate (80% used) → 3 agents
//   3: Aggressive (90% used) → 2 agents (exec + critical)
//   4: Paused (95% used) → all stop, resume next week
// ---------------------------------------------------------------------------

const SONNET_WEEKLY_HOURS = 200
const OPUS_WEEKLY_HOURS = 16
const SONNET_RESERVED = 40  // personal headroom
const OPUS_RESERVED = 8

const THROTTLE_THRESHOLDS = [
  { level: 0, usagePct: 0,   maxAgents: 6,  label: 'Normal' },
  { level: 1, usagePct: 0.70, maxAgents: 4,  label: 'Mild' },
  { level: 2, usagePct: 0.80, maxAgents: 3,  label: 'Moderate' },
  { level: 3, usagePct: 0.90, maxAgents: 2,  label: 'Aggressive' },
  { level: 4, usagePct: 0.95, maxAgents: 0,  label: 'Paused' },
]

export interface WeekBudget {
  weekNumber: number
  weekStart: string
  weekEnd: string
  sonnetHoursBudget: number
  sonnetHoursUsed: number
  sonnetHoursReserved: number
  opusHoursBudget: number
  opusHoursUsed: number
  opusHoursReserved: number
  throttleLevel: number
}

// ---------------------------------------------------------------------------
// Get or create current week budget
// ---------------------------------------------------------------------------
export function getCurrentWeekBudget(): WeekBudget {
  const db = getDb()

  // Calculate current week boundaries
  const now = new Date()
  const dayOfWeek = now.getUTCDay()
  const monday = new Date(now)
  monday.setUTCDate(now.getUTCDate() - ((dayOfWeek + 6) % 7))
  monday.setUTCHours(0, 0, 0, 0)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 7)

  const weekStart = monday.toISOString().slice(0, 10)
  const weekEnd = sunday.toISOString().slice(0, 10)

  // Try to get existing week budget
  try {
    const existing = db.query(`
      SELECT * FROM usage_budget WHERE week_start = ?
    `).get(weekStart) as any

    if (existing) {
      return {
        weekNumber: existing.week_number,
        weekStart: existing.week_start,
        weekEnd: existing.week_end,
        sonnetHoursBudget: existing.sonnet_hours_budget,
        sonnetHoursUsed: existing.sonnet_hours_used,
        sonnetHoursReserved: existing.sonnet_hours_reserved,
        opusHoursBudget: existing.opus_hours_budget,
        opusHoursUsed: existing.opus_hours_used,
        opusHoursReserved: existing.opus_hours_reserved,
        throttleLevel: existing.throttle_level,
      }
    }
  } catch {
    // Table may not exist — return defaults
  }

  // Return defaults if no budget tracking yet
  return {
    weekNumber: 1,
    weekStart,
    weekEnd,
    sonnetHoursBudget: SONNET_WEEKLY_HOURS,
    sonnetHoursUsed: 0,
    sonnetHoursReserved: SONNET_RESERVED,
    opusHoursBudget: OPUS_WEEKLY_HOURS,
    opusHoursUsed: 0,
    opusHoursReserved: OPUS_RESERVED,
    throttleLevel: 0,
  }
}

// ---------------------------------------------------------------------------
// Calculate throttle level from usage
// ---------------------------------------------------------------------------
export function calculateThrottleLevel(budget: WeekBudget): number {
  const sonnetAvailable = budget.sonnetHoursBudget - budget.sonnetHoursReserved
  const sonnetPct = sonnetAvailable > 0 ? budget.sonnetHoursUsed / sonnetAvailable : 0

  const opusAvailable = budget.opusHoursBudget - budget.opusHoursReserved
  const opusPct = opusAvailable > 0 ? budget.opusHoursUsed / opusAvailable : 0

  // Use the higher of the two usage percentages
  const maxPct = Math.max(sonnetPct, opusPct)

  let level = 0
  for (const t of THROTTLE_THRESHOLDS) {
    if (maxPct >= t.usagePct) {
      level = t.level
    }
  }

  return level
}

// ---------------------------------------------------------------------------
// Get max concurrent agents based on throttle level
// ---------------------------------------------------------------------------
export function getMaxConcurrentAgents(throttleLevel: number): number {
  const threshold = THROTTLE_THRESHOLDS.find(t => t.level === throttleLevel)
  return threshold?.maxAgents ?? 6
}

// ---------------------------------------------------------------------------
// Record task usage (called after agent process exits)
// ---------------------------------------------------------------------------
export function recordTaskUsage(params: {
  agentId: string
  taskId: string
  model: string
  durationMs: number
  tokenCount?: number
}): void {
  // Convert duration to hours
  const hours = params.durationMs / (1000 * 60 * 60)
  const isOpus = params.model.includes('opus')

  const budget = getCurrentWeekBudget()

  if (isOpus) {
    budget.opusHoursUsed += hours
  } else {
    budget.sonnetHoursUsed += hours
  }

  // Update throttle level
  const newThrottle = calculateThrottleLevel(budget)
  if (newThrottle !== budget.throttleLevel) {
    const label = THROTTLE_THRESHOLDS.find(t => t.level === newThrottle)?.label ?? 'Unknown'
    console.log(`[USAGE] Throttle level changed: ${budget.throttleLevel} → ${newThrottle} (${label})`)
    broadcastAGUI({
      type: 'STATE_DELTA',
      subtype: 'THROTTLE_CHANGE',
      previousLevel: budget.throttleLevel,
      newLevel: newThrottle,
      label,
    })

    // Notify CoS on throttle level 3+ (Aggressive/Paused)
    if (newThrottle >= 3) {
      sendMessage({
        fromAgentId: 'system',
        toAgentId: 'priya',
        subject: `USAGE ALERT: Throttle level ${newThrottle} (${label})`,
        body: `Weekly usage budget is at throttle level ${newThrottle} (${label}). Sonnet: ${budget.sonnetHoursUsed.toFixed(1)}h/${budget.sonnetHoursBudget - budget.sonnetHoursReserved}h, Opus: ${budget.opusHoursUsed.toFixed(1)}h/${budget.opusHoursBudget - budget.opusHoursReserved}h. Agent dispatch is severely restricted.`,
        priority: 'urgent',
      })
    }
  }

  // Persist usage — INSERT OR REPLACE to handle missing rows
  try {
    const db = getDb()
    const weekNum = Math.ceil((Date.now() - new Date(budget.weekStart + 'T00:00:00Z').getTime()) / (7 * 24 * 60 * 60 * 1000)) || 1
    db.run(`
      INSERT INTO usage_budget (week_number, week_start, week_end, sonnet_hours_budget, sonnet_hours_used, sonnet_hours_reserved, opus_hours_budget, opus_hours_used, opus_hours_reserved, throttle_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(week_start) DO UPDATE SET
        sonnet_hours_used = ?,
        opus_hours_used = ?,
        throttle_level = ?
    `, [weekNum, budget.weekStart, budget.weekEnd, budget.sonnetHoursBudget, budget.sonnetHoursUsed, budget.sonnetHoursReserved, budget.opusHoursBudget, budget.opusHoursUsed, budget.opusHoursReserved, newThrottle,
        budget.sonnetHoursUsed, budget.opusHoursUsed, newThrottle])
  } catch {
    // usage_budget table may not exist — non-critical
  }
}
