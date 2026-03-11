import { existsSync } from 'node:fs'
import { getDb, closeDb } from '../server/db/database'

console.log('=== AGENTOS PRE-FLIGHT AUDIT ===\n')

let pass = 0
let fail = 0

function check(name: string, test: () => boolean, detail?: string) {
  try {
    if (test()) {
      console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
      pass++
    } else {
      console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
      fail++
    }
  } catch (e: any) {
    console.log(`  ❌ ${name} — ${e.message}`)
    fail++
  }
}

// Database checks
console.log('DATABASE:')
const dbPath = process.env.DB_PATH ?? './sim.db'
check('Database file exists', () => existsSync(dbPath), dbPath)

if (existsSync(dbPath)) {
  const db = getDb()

  check('Agents table populated', () => {
    const r = db.query(`SELECT COUNT(*) as c FROM agents`).get() as { c: number }
    return r.c === 18
  }, '18 agents expected')

  check('Capability tiers seeded', () => {
    const r = db.query(`SELECT COUNT(*) as c FROM capability_tiers`).get() as { c: number }
    return r.c === 18
  })

  check('Experiment phases seeded', () => {
    const r = db.query(`SELECT COUNT(*) as c FROM experiment_phases`).get() as { c: number }
    return r.c === 6
  }, '6 phases (0-5)')

  check('Phase quorum config seeded', () => {
    const r = db.query(`SELECT COUNT(*) as c FROM phase_quorum_config`).get() as { c: number }
    return r.c === 5
  })

  check('Phase quorum tracking seeded', () => {
    const r = db.query(`SELECT COUNT(*) as c FROM phase_quorum`).get() as { c: number }
    return r.c === 25
  }, '5 phases × 5 teams')

  check('Budget category owners seeded', () => {
    const r = db.query(`SELECT COUNT(*) as c FROM budget_category_owners`).get() as { c: number }
    return r.c === 5
  })

  check('Sim clock initialized', () => {
    const r = db.query(`SELECT sim_day FROM sim_clock WHERE id = 1`).get() as { sim_day: number } | null
    return r !== null && r.sim_day === 0
  })

  check('Starting budget entry exists', () => {
    const r = db.query(`SELECT amount FROM budget_entries WHERE notes = 'experiment_start'`).get() as { amount: number } | null
    return r !== null && r.amount === 200
  })

  check('All migrations applied', () => {
    const r = db.query(`SELECT COUNT(*) as c FROM schema_migrations`).get() as { c: number }
    return r.c === 8
  }, '8 migration files')

  check('Reward system tables exist', () => {
    db.query(`SELECT 1 FROM collaboration_events LIMIT 0`).get()
    db.query(`SELECT 1 FROM revenue_attribution LIMIT 0`).get()
    db.query(`SELECT 1 FROM blocked_agents LIMIT 0`).get()
    return true
  })

  closeDb()
}

// File checks
console.log('\nFILES:')
check('CLAUDE.md exists', () => existsSync('./CLAUDE.md'))
check('.env.example exists', () => existsSync('./.env.example'))
check('Migrations directory', () => existsSync('./migrations'))
check('Logs directory', () => existsSync('./logs'))
check('Server directory', () => existsSync('./server'))

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
if (fail === 0) {
  console.log('✅ All checks passed. Ready for Phase 1.')
} else {
  console.log(`❌ ${fail} check(s) failed. Fix before proceeding.`)
}

process.exit(fail > 0 ? 1 : 0)
