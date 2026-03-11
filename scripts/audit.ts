import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, closeDb } from '../server/db/database'
import { loadRegressionCases } from '../server/governance/regression'

console.log('=== AGENTOS PRE-FLIGHT AUDIT ===\n')

let pass = 0
let fail = 0

function check(name: string, test: () => boolean, detail?: string) {
  try {
    if (test()) {
      console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
      pass++
    } else {
      console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
      fail++
    }
  } catch (e: any) {
    console.log(`  FAIL  ${name} — ${e.message}`)
    fail++
  }
}

// ---------------------------------------------------------------------------
// ENVIRONMENT
// ---------------------------------------------------------------------------
console.log('ENVIRONMENT:')

check('Bun version', () => {
  const result = Bun.spawnSync(['bun', '--version'], { stdout: 'pipe' })
  return result.exitCode === 0
}, `bun ${Bun.version}`)

check('Claude CLI available', () => {
  const result = Bun.spawnSync(['which', 'claude'], { stdout: 'pipe' })
  return result.exitCode === 0
})

check('Git configured', () => {
  const result = Bun.spawnSync(['git', 'config', 'user.name'], { stdout: 'pipe' })
  return result.exitCode === 0
})

check('tmux available', () => {
  const result = Bun.spawnSync(['which', 'tmux'], { stdout: 'pipe' })
  return result.exitCode === 0
})

check('pm2 available', () => {
  const result = Bun.spawnSync(['which', 'pm2'], { stdout: 'pipe' })
  return result.exitCode === 0
})

// .env required vars
const requiredEnvVars = ['DB_PATH', 'SIM_HUMAN_TOKEN']
for (const key of requiredEnvVars) {
  check(`ENV: ${key}`, () => {
    const val = process.env[key]
    return !!val && val.length > 0
  })
}

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
console.log('\nDATABASE:')
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
  }, '5 phases x 5 teams')

  check('Budget category owners seeded', () => {
    const r = db.query(`SELECT COUNT(*) as c FROM budget_category_owners`).get() as { c: number }
    return r.c === 5
  })

  check('Sim clock initialized', () => {
    const r = db.query(`SELECT sim_day FROM sim_clock WHERE id = 1`).get() as { sim_day: number } | null
    return r !== null && r.sim_day >= 0
  })

  check('Starting budget entry exists', () => {
    const r = db.query(`SELECT amount FROM budget_entries WHERE notes = 'experiment_start'`).get() as { amount: number } | null
    return r !== null && r.amount === 200
  })

  check('All migrations applied', () => {
    const r = db.query(`SELECT COUNT(*) as c FROM schema_migrations`).get() as { c: number }
    return r.c === 11
  }, '11 migration files')

  check('Reward system tables exist', () => {
    db.query(`SELECT 1 FROM collaboration_events LIMIT 0`).get()
    db.query(`SELECT 1 FROM revenue_attribution LIMIT 0`).get()
    db.query(`SELECT 1 FROM blocked_agents LIMIT 0`).get()
    return true
  })

  check('Anti-gaming tables exist', () => {
    db.query(`SELECT 1 FROM spot_check_failures LIMIT 0`).get()
    db.query(`SELECT 1 FROM governance_events LIMIT 0`).get()
    db.query(`SELECT 1 FROM agent_sessions LIMIT 0`).get()
    return true
  })

  check('spot_check_failures table exists', () => {
    const r = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='spot_check_failures'`).get()
    return !!r
  })

  closeDb()
}

// ---------------------------------------------------------------------------
// FILES
// ---------------------------------------------------------------------------
console.log('\nFILES:')
check('CLAUDE.md exists', () => existsSync('./CLAUDE.md'))
check('.env.example exists', () => existsSync('./.env.example'))
check('Migrations directory', () => existsSync('./migrations'))
check('Logs directory', () => existsSync('./logs'))
check('Server directory', () => existsSync('./server'))
check('Verifier module exists', () => existsSync('./server/reward/verifier.ts'))
check('Spot-check module exists', () => existsSync('./server/reward/spot-check.ts'))
check('Auth middleware exists', () => existsSync('./server/middleware/auth.ts'))
check('Governance observer exists', () => existsSync('./server/governance/observer.ts'))
check('Regression module exists', () => existsSync('./server/governance/regression.ts'))
check('Regression cases file exists', () => existsSync('./scripts/regression-cases.json'))

// ---------------------------------------------------------------------------
// ANTI-GAMING LINT
// ---------------------------------------------------------------------------
console.log('\nANTI-GAMING LINT:')

// Check auth middleware is applied to all routes
check('Auth middleware on all routes', () => {
  const indexSrc = readFileSync('./server/index.ts', 'utf-8')
  // Must have app.use('*', authMiddleware()) before any route definitions
  const authIdx = indexSrc.indexOf("authMiddleware()")
  const firstRouteIdx = indexSrc.indexOf("app.get('/api/")
  return authIdx !== -1 && authIdx < firstRouteIdx
}, 'authMiddleware() applied before first route')

// Auth middleware is a global catch-all — verify the fallback blocks unknown agent writes
check('Auth middleware blocks unknown agent POST routes', () => {
  const authSrc = readFileSync('./server/middleware/auth.ts', 'utf-8')
  // The fallback case should block agents on unmapped POST routes
  return authSrc.includes("return c.json({ error: 'Forbidden' }, 403)")
}, 'agents blocked on unmapped write routes')

// Verify reward POST routes are explicitly locked to orchestrator/human
check('Reward POST routes locked to orchestrator/human', () => {
  const authSrc = readFileSync('./server/middleware/auth.ts', 'utf-8')
  // Check reward event and revenue routes
  const hasRewardEventLock = authSrc.includes("'/api/reward/event'") ||
    authSrc.includes('reward\\/event')
  const hasRewardWildcard = authSrc.includes("'/api/reward/.*'") ||
    authSrc.includes('reward\\/\\.\\*')
  return hasRewardEventLock || hasRewardWildcard
}, 'reward write endpoints not accessible to agents')

// Verify verifier.ts is imported in runner.ts (orchestrator-internal), NOT in route files
check('Verifier imported in runner.ts (orchestrator-internal)', () => {
  const runnerSrc = readFileSync('./server/agents/runner.ts', 'utf-8')
  return runnerSrc.includes("from '../reward/verifier'")
})

check('Verifier NOT imported in index.ts (route file)', () => {
  const indexSrc = readFileSync('./server/index.ts', 'utf-8')
  return !indexSrc.includes("from './reward/verifier'") && !indexSrc.includes('from "./reward/verifier"')
}, 'verifier only imported by runner.ts')

// Verify no agent-route handler imports reward write functions directly
check('Agent route handlers do not call reward write functions', () => {
  const indexSrc = readFileSync('./server/index.ts', 'utf-8')

  const agentRouteBlocks = [
    '/api/action/complete',
    '/api/action/update',
    '/api/agent/checkin',
  ]

  const rewardWriteFns = ['logCollaborationEvent', 'updateAllTiers', 'recalculateAllCFS', 'recordRevenueEvent']

  for (const route of agentRouteBlocks) {
    const routeIdx = indexSrc.indexOf(route)
    if (routeIdx === -1) continue
    const block = indexSrc.slice(routeIdx, routeIdx + 500)
    for (const fn of rewardWriteFns) {
      if (block.includes(fn)) {
        return false
      }
    }
  }
  return true
}, 'reward writes gated to orchestrator/system callers')

// Verify no agent-facing route file imports ledger.ts or capability-tiers write functions
check('No route file imports ledger.ts write functions', () => {
  // Check message routes
  if (existsSync('./server/messages/routes.ts')) {
    const routesSrc = readFileSync('./server/messages/routes.ts', 'utf-8')
    if (routesSrc.includes("from '../reward/ledger'") || routesSrc.includes('from "../reward/ledger"')) {
      return false
    }
  }
  return true
})

// Verify spot-check runs in runner (orchestrator internal)
check('Spot-check imported in runner.ts', () => {
  const runnerSrc = readFileSync('./server/agents/runner.ts', 'utf-8')
  return runnerSrc.includes("from '../reward/spot-check'")
})

check('Spot-check NOT imported in index.ts', () => {
  const indexSrc = readFileSync('./server/index.ts', 'utf-8')
  return !indexSrc.includes("from './reward/spot-check'")
})

// ---------------------------------------------------------------------------
// REGRESSION
// ---------------------------------------------------------------------------
console.log('\nREGRESSION:')
const regressionCases = loadRegressionCases()
check(`Regression cases file loaded`, () => true, `${regressionCases.length} accumulated + 10 baseline`)

// Run regression tests inline
check('bun run regression passes', () => {
  const result = Bun.spawnSync(['bun', 'run', 'scripts/regression.ts'], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.cwd(),
  })
  return result.exitCode === 0
})

// ---------------------------------------------------------------------------
// SERVER HEALTH (if running)
// ---------------------------------------------------------------------------
console.log('\nSERVER:')
try {
  const resp = await fetch('http://localhost:3411/api/health', {
    signal: AbortSignal.timeout(2000),
  })
  if (resp.ok) {
    const health = await resp.json() as any
    check('Server health endpoint', () => health.status === 'ok', `agents: ${health.agents}, phase: ${health.phase}`)
  } else {
    check('Server health endpoint', () => false, `HTTP ${resp.status}`)
  }
} catch {
  console.log('  SKIP  Server not running (localhost:3411)')
}

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(50)}`)
console.log(`RESULT: ${pass} passed, ${fail} failed`)
console.log(`${'='.repeat(50)}`)

if (fail === 0) {
  console.log('\nREADY — All checks passed. Safe to start experiment.')
} else {
  console.log(`\nBLOCKED — ${fail} check(s) failed. Fix before proceeding.`)
}

process.exit(fail > 0 ? 1 : 0)
