import { getDb } from './db/database'

// ---------------------------------------------------------------------------
// Sim Clock — doc 6 Issue 1
//
// sim_day advances on whichever comes first:
//   (a) a phase advance is ratified
//   (b) 8 real hours pass with active agent work (15 min in compressed mode)
// ---------------------------------------------------------------------------

const REAL_MODE_ADVANCE_MS = 8 * 60 * 60 * 1000   // 8 hours
const COMPRESSED_ADVANCE_MS = 15 * 60 * 1000       // 15 minutes

function getAdvanceThresholdMs(): number {
  const mode = process.env.SIM_MODE ?? 'real'
  return mode === 'compressed' ? COMPRESSED_ADVANCE_MS : REAL_MODE_ADVANCE_MS
}

// ---------------------------------------------------------------------------
// Get current sim day
// ---------------------------------------------------------------------------
export function getSimDay(): number {
  const db = getDb()
  const clock = db.query(`SELECT sim_day FROM sim_clock WHERE id = 1`).get() as { sim_day: number } | null
  return clock?.sim_day ?? 0
}

// ---------------------------------------------------------------------------
// Advance sim day
// ---------------------------------------------------------------------------
export function advanceSimDay(reason: 'phase_advance' | 'time_elapsed'): number {
  const db = getDb()
  const clock = db.query(`SELECT * FROM sim_clock WHERE id = 1`).get() as {
    sim_day: number
    last_advanced_at: string
    advanced_by: string
  } | null

  if (!clock) {
    // Initialize if missing
    db.run(`INSERT OR IGNORE INTO sim_clock (id, sim_day, last_advanced_at, advanced_by, real_start)
            VALUES (1, 1, datetime('now'), ?, datetime('now'))`, [reason])
    console.log(`[CLOCK] sim_day initialized to 1 via ${reason}`)
    return 1
  }

  const newDay = clock.sim_day + 1
  db.run(
    `UPDATE sim_clock SET sim_day = ?, last_advanced_at = datetime('now'), advanced_by = ? WHERE id = 1`,
    [newDay, reason]
  )

  console.log(`[CLOCK] sim_day advanced to ${newDay} via ${reason}`)
  return newDay
}

// ---------------------------------------------------------------------------
// Check if time-based advancement is due (called each orchestrator cycle)
// ---------------------------------------------------------------------------
export function advanceSimDayIfNeeded(): void {
  const db = getDb()
  const clock = db.query(`SELECT * FROM sim_clock WHERE id = 1`).get() as {
    sim_day: number
    last_advanced_at: string
  } | null

  if (!clock) return

  // Check if enough real time has elapsed since last advancement
  const lastAdvanced = new Date(clock.last_advanced_at + 'Z')
  const elapsed = Date.now() - lastAdvanced.getTime()
  const threshold = getAdvanceThresholdMs()

  if (elapsed >= threshold) {
    // Only advance if there's been active agent work in this window
    const recentWork = db.query(`
      SELECT COUNT(*) as n FROM actions
      WHERE status IN ('completed', 'running')
        AND (completed_at > ? OR started_at > ?)
    `).get(clock.last_advanced_at, clock.last_advanced_at) as { n: number }

    if (recentWork.n > 0) {
      advanceSimDay('time_elapsed')
    }
  }
}
