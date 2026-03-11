import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { validateEnv } from './startup/validate-env'
import { runMigrations } from './db/migrate'
import { getDb } from './db/database'
import { messageRoutes } from './messages/routes'
import { getTaskStats, getQueuedTasks } from './tasks/queue'

// Validate environment
validateEnv()

// Run migrations on startup
console.log('Running migrations...')
runMigrations()

const app = new Hono()

// Middleware
app.use('*', cors())

// Health check
app.get('/api/health', (c) => {
  const db = getDb()
  const agentCount = db.query(`SELECT COUNT(*) as count FROM agents`).get() as { count: number }
  const clock = db.query(`SELECT sim_day FROM sim_clock WHERE id = 1`).get() as { sim_day: number } | null
  const activePhase = db.query(`SELECT phase_number, name FROM experiment_phases WHERE status = 'active'`).get() as { phase_number: number; name: string } | null
  const activeAgents = db.query(`SELECT COUNT(*) as count FROM agents WHERE status = 'working'`).get() as { count: number }

  return c.json({
    status: 'ok',
    db: 'connected',
    agents: agentCount.count,
    rewardSystem: 'initialized',
    simDay: clock?.sim_day ?? 0,
    activeAgents: activeAgents.count,
    phase: activePhase?.phase_number ?? 0,
    phaseName: activePhase?.name ?? 'none',
  })
})

// SSE stream endpoint for AG-UI events
const sseClients: Set<ReadableStreamDefaultController> = new Set()

app.get('/stream', (c) => {
  return streamSSE(c, async (stream) => {
    // Send initial connection event
    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({ status: 'connected', timestamp: new Date().toISOString() }),
    })

    // Keep connection alive
    const keepAlive = setInterval(async () => {
      try {
        await stream.writeSSE({
          event: 'heartbeat',
          data: JSON.stringify({ ts: new Date().toISOString() }),
        })
      } catch {
        clearInterval(keepAlive)
      }
    }, 30_000)

    // Wait until client disconnects
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(keepAlive)
        resolve()
      })
    })
  })
})

// Agent status endpoint
app.get('/api/agents', (c) => {
  const db = getDb()
  const agents = db.query(`
    SELECT id, personality_name, team, role, status, urgency, urgency_reason,
           collaboration_score, capability_tier, personality_summary,
           token_budget_today, token_budget_remaining
    FROM agents ORDER BY team, role
  `).all()
  return c.json(agents)
})

// Phase status endpoint
app.get('/api/phases', (c) => {
  const db = getDb()
  const phases = db.query(`SELECT * FROM experiment_phases ORDER BY phase_number`).all()
  return c.json(phases)
})

// Budget summary endpoint
app.get('/api/budget', (c) => {
  const db = getDb()
  const spent = db.query(`
    SELECT COALESCE(SUM(ABS(amount)), 0) as total_spent
    FROM budget_entries WHERE amount < 0
  `).get() as { total_spent: number }

  const revenue = db.query(`
    SELECT COALESCE(SUM(amount), 0) as total_revenue
    FROM budget_entries WHERE amount > 0 AND notes != 'experiment_start'
  `).get() as { total_revenue: number }

  const budget = Number(process.env.TOTAL_EXPERIMENT_BUDGET_USD ?? 200)

  return c.json({
    totalBudget: budget,
    totalSpent: spent.total_spent,
    totalRevenue: revenue.total_revenue,
    remaining: budget - spent.total_spent,
  })
})

// Messages endpoint
app.get('/api/messages', (c) => {
  const db = getDb()
  const limit = Number(c.req.query('limit') ?? 50)
  const messages = db.query(`
    SELECT m.*,
           fa.personality_name as from_name,
           ta.personality_name as to_name
    FROM messages m
    LEFT JOIN agents fa ON m.from_agent_id = fa.id
    LEFT JOIN agents ta ON m.to_agent_id = ta.id
    ORDER BY m.created_at DESC LIMIT ?
  `).all(limit)
  return c.json(messages)
})

// Message bus routes
app.route('/api/messages', messageRoutes)

// Task queue endpoints
app.get('/api/tasks/stats', (c) => {
  return c.json(getTaskStats())
})

app.get('/api/tasks/queued/:phase', (c) => {
  const phase = Number(c.req.param('phase'))
  return c.json(getQueuedTasks(phase))
})

// Sim clock endpoint
app.get('/api/clock', (c) => {
  const db = getDb()
  const clock = db.query(`SELECT * FROM sim_clock WHERE id = 1`).get()
  return c.json(clock ?? { sim_day: 0 })
})

// Start server
const port = Number(process.env.PORT ?? 3411)
const host = process.env.HOST ?? '0.0.0.0'

console.log(`\n🚀 AgentOS server starting on http://${host}:${port}`)
console.log(`   Dashboard: http://localhost:${port}`)
console.log(`   Health:    http://localhost:${port}/api/health`)
console.log(`   Stream:    http://localhost:${port}/stream\n`)

export default {
  port,
  hostname: host,
  fetch: app.fetch,
}
