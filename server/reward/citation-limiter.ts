import { getDb } from '../db/database'

// ---------------------------------------------------------------------------
// Citation Rate Limiter -- prevents CFS inflation from blanket output_cited events
//
// Problem: runner.ts lines 806-831 credited EVERY completed agent in the same phase
// when ANY task completed. With N active agents, every completion generated N-1
// output_cited events (+2.0 each), creating O(N^2) CFS inflation.
//
// Solution:
//   1. Only cite the top-3 agents whose work was actually used in smart context
//   2. Cap citations per agent per phase (default: 20)
//   3. Graduated weight reduction when approaching cap
// ---------------------------------------------------------------------------

const DEFAULT_CAP = 20

// ---------------------------------------------------------------------------
// Check if an agent has exceeded their citation cap for this phase
// Returns false if over cap (should NOT be cited)
// ---------------------------------------------------------------------------
export function checkCitationRateLimit(agentId: string, phase: number): boolean {
  const db = getDb()

  const row = db.query(`
    SELECT citation_count, cap FROM citation_rate_limits
    WHERE agent_id = ? AND phase = ?
  `).get(agentId, phase) as { citation_count: number; cap: number } | null

  if (!row) return true // no row means 0 citations, well under cap

  return row.citation_count < row.cap
}

// ---------------------------------------------------------------------------
// Increment the citation counter for an agent in a phase
// ---------------------------------------------------------------------------
export function incrementCitationCount(agentId: string, phase: number): void {
  const db = getDb()

  db.run(`
    INSERT INTO citation_rate_limits (agent_id, phase, citation_count, cap, last_updated)
    VALUES (?, ?, 1, ?, datetime('now'))
    ON CONFLICT(agent_id, phase) DO UPDATE SET
      citation_count = citation_count + 1,
      last_updated = datetime('now')
  `, [agentId, phase, DEFAULT_CAP])
}

// ---------------------------------------------------------------------------
// Get adjusted citation weight based on current count relative to cap
//
// Normal (< 50% of cap):       full weight (2.0)
// Approaching (50-80% of cap): reduced weight (1.0)
// Near cap (80-100% of cap):   minimal weight (0.5)
// Over cap:                    zero weight (0.0) -- should not happen if checked first
// ---------------------------------------------------------------------------
export function adjustCitationWeight(agentId: string, phase: number): number {
  const db = getDb()

  const row = db.query(`
    SELECT citation_count, cap FROM citation_rate_limits
    WHERE agent_id = ? AND phase = ?
  `).get(agentId, phase) as { citation_count: number; cap: number } | null

  if (!row) return 2.0 // no row = first citation, full weight

  const ratio = row.citation_count / row.cap

  if (ratio >= 1.0) return 0.0   // over cap
  if (ratio >= 0.8) return 0.5   // near cap -- minimal credit
  if (ratio >= 0.5) return 1.0   // approaching cap -- half credit
  return 2.0                      // under 50% -- full credit
}

// ---------------------------------------------------------------------------
// Get citation stats for dashboard/debugging
// ---------------------------------------------------------------------------
export function getCitationStats(phase?: number): Array<{
  agent_id: string
  phase: number
  citation_count: number
  cap: number
  weight: number
}> {
  const db = getDb()

  const query = phase !== undefined
    ? `SELECT agent_id, phase, citation_count, cap FROM citation_rate_limits WHERE phase = ? ORDER BY citation_count DESC`
    : `SELECT agent_id, phase, citation_count, cap FROM citation_rate_limits ORDER BY citation_count DESC`

  const rows = (phase !== undefined
    ? db.query(query).all(phase)
    : db.query(query).all()
  ) as Array<{ agent_id: string; phase: number; citation_count: number; cap: number }>

  return rows.map(row => ({
    ...row,
    weight: adjustCitationWeight(row.agent_id, row.phase),
  }))
}
