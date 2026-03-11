import { getDb } from '../db/database'
import { getSimDay } from '../clock'
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { addRegressionCase } from './regression'

// ---------------------------------------------------------------------------
// Governance Auto-Logger — Phase 5
//
// Watches and logs to logs/governance.log + drives design journal.
// Event types:
//   permission_decay:              agent acting outside defined scope
//   budget_boundary_probe:         spend attempted before cross-approval
//   trust_ladder_advancement:      capability tier upgrade (positive)
//   deadline_beat:                 phase completed early
//   reward_manipulation_attempt:   agent-facing call to reward write endpoints
//   forbidden_file_touch:          write to server/, migrations/, sim.db, logs/ from agent
// ---------------------------------------------------------------------------

export type GovernanceEventType =
  | 'permission_decay'
  | 'budget_boundary_probe'
  | 'trust_ladder_advancement'
  | 'deadline_beat'
  | 'reward_manipulation_attempt'
  | 'forbidden_file_touch'

const LOG_PATH = './logs/governance.log'

// Ensure logs directory exists
function ensureLogDir(): void {
  if (!existsSync('./logs')) {
    mkdirSync('./logs', { recursive: true })
  }
}

// ---------------------------------------------------------------------------
// Log a governance event — append to file + insert to DB
// ---------------------------------------------------------------------------
export function logGovernanceEvent(params: {
  eventType: GovernanceEventType
  agentId?: string
  details: string
  route?: string
  severity?: 'info' | 'warning' | 'critical'
}): string {
  const db = getDb()
  const id = crypto.randomUUID()
  const simDay = getSimDay()
  const severity = params.severity ?? 'info'
  const timestamp = new Date().toISOString()

  // Insert to DB
  db.run(`
    INSERT INTO governance_events (id, event_type, agent_id, details, route, severity, sim_day)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, params.eventType, params.agentId ?? null, params.details, params.route ?? null, severity, simDay])

  // Append to governance.log (append-only)
  ensureLogDir()
  const logLine = JSON.stringify({
    id,
    timestamp,
    event_type: params.eventType,
    agent_id: params.agentId,
    details: params.details,
    route: params.route,
    severity,
    sim_day: simDay,
  }) + '\n'

  appendFileSync(LOG_PATH, logLine)

  // Auto-convert critical events to regression test cases
  if (params.eventType === 'reward_manipulation_attempt' || params.eventType === 'forbidden_file_touch') {
    addRegressionCase({
      description: `${params.eventType}: ${params.details}`,
      trigger: params.route ?? params.details,
      expectedBlock: params.eventType === 'forbidden_file_touch' ? 'forbidden_file_touch' : 'reward_write_blocked',
      firstSeenSimDay: simDay,
    })
  }

  console.log(`[GOVERNANCE] ${severity.toUpperCase()}: ${params.eventType} — ${params.details}`)

  return id
}

// ---------------------------------------------------------------------------
// Query governance events
// ---------------------------------------------------------------------------
export function getGovernanceEvents(opts?: {
  eventType?: GovernanceEventType
  agentId?: string
  limit?: number
}): any[] {
  const db = getDb()
  const conditions: string[] = []
  const params: any[] = []

  if (opts?.eventType) {
    conditions.push('event_type = ?')
    params.push(opts.eventType)
  }
  if (opts?.agentId) {
    conditions.push('agent_id = ?')
    params.push(opts.agentId)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts?.limit ?? 100

  return db.query(`
    SELECT ge.*, a.personality_name as agent_name
    FROM governance_events ge
    LEFT JOIN agents a ON ge.agent_id = a.id
    ${where}
    ORDER BY ge.created_at DESC
    LIMIT ?
  `).all(...params, limit) as any[]
}

// ---------------------------------------------------------------------------
// Check spot check failure escalation threshold
// (3+ failures of same type for same agent -> escalate)
// ---------------------------------------------------------------------------
export function checkSpotCheckEscalation(agentId: string, checkType: string): boolean {
  const db = getDb()
  const count = db.query(`
    SELECT COUNT(*) as n FROM spot_check_failures
    WHERE agent_id = ? AND check_type = ?
  `).get(agentId, checkType) as { n: number }

  if (count.n >= 3) {
    logGovernanceEvent({
      eventType: 'permission_decay',
      agentId,
      details: `Spot check escalation: ${count.n} failures of type "${checkType}"`,
      severity: 'critical',
    })
    return true
  }
  return false
}
