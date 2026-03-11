import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { validateEnv } from './startup/validate-env'
import { runMigrations } from './db/migrate'
import { getDb } from './db/database'
import { messageRoutes } from './messages/routes'
import { getTaskStats, getQueuedTasks, enqueueTask } from './tasks/queue'
import {
  startOrchestrator,
  stopOrchestrator,
  isOrchestratorRunning,
  getOrchestratorCycleCount,
  drainAGUIEvents,
  CONCURRENCY_LIMITS,
} from './orchestrator'
import { getActiveProcesses, killAgentProcess } from './agents/runner'
import { getRemainingBudget, getPhaseSpendSummary, recordSpend } from './budget/enforcer'
import { getSimDay, advanceSimDay } from './clock'
import { getActivityLog, logActivity } from './activity'
import { sendMessage } from './messages/bus'
import {
  getCFSSummary,
  getAgentCollaborationHistory,
  getAttributionSummary,
  recordRevenueEvent,
  checkQuorumStatus,
  attemptPhaseAdvance,
  requiresCrossApproval,
  requestCrossApproval,
  approveCrossApproval,
  rejectCrossApproval,
  getPendingCrossApprovals,
  reportBlocked,
  resolveBlocker,
  getActiveBlockers,
  getBlockerHistory,
  recordVelocityAssessment,
  submitDeadlineRevision,
  setPhaseDeadline,
  getVelocityMetrics,
  logCollaborationEvent,
} from './reward'
import { authMiddleware } from './middleware/auth'
import { getGovernanceEvents } from './governance/observer'
import { getPerAgentCosts, getPerTeamCosts, getPerPhaseCosts, getTokenCostTotals, MODEL_PRICING } from './usage/token-costs'
import { PUBLIC_DASHBOARD_HTML } from './public-dashboard'

// Validate environment
validateEnv()

// Run migrations on startup
console.log('Running migrations...')
runMigrations()

const app = new Hono()

// Middleware
app.use('*', cors())
app.use('*', authMiddleware())

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
    orchestratorRunning: isOrchestratorRunning(),
    orchestratorCycles: getOrchestratorCycleCount(),
    remainingBudget: getRemainingBudget(),
  })
})

// Notion connectivity status
app.get('/api/notion/status', (c) => {
  const { getNotionStatus } = require('./notion/sync')
  return c.json(getNotionStatus())
})

// Human tasks -- agents can request human intervention
app.get('/api/human-tasks', (c) => {
  const { getHumanTasks } = require('./human-tasks')
  const status = c.req.query('status')
  return c.json(getHumanTasks(status || undefined))
})

app.post('/api/human-tasks/:id/complete', async (c) => {
  const { completeHumanTask } = require('./human-tasks')
  const body = await c.req.json()
  completeHumanTask(c.req.param('id'), body.resolution ?? 'Completed')
  return c.json({ status: 'completed' })
})

// Experiment changelog -- for substack writeups
app.get('/api/changelog', (c) => {
  const { getChangelog } = require('./changelog')
  const limit = Number(c.req.query('limit') ?? 50)
  const eventType = c.req.query('type') || undefined
  return c.json(getChangelog({ limit, eventType }))
})

app.get('/api/changelog/summary', (c) => {
  const { generateWeeklySummary } = require('./changelog')
  const sinceDay = c.req.query('since') ? Number(c.req.query('since')) : undefined
  return c.text(generateWeeklySummary(sinceDay))
})

// SSE stream endpoint for AG-UI events
app.get('/stream', (c) => {
  return streamSSE(c, async (stream) => {
    // Send initial connection event
    await stream.writeSSE({
      event: 'connected',
      data: JSON.stringify({ status: 'connected', timestamp: new Date().toISOString() }),
    })

    // Poll for AG-UI events and send them
    let running = true
    const pollInterval = setInterval(async () => {
      try {
        const events = drainAGUIEvents()
        for (const event of events) {
          await stream.writeSSE({
            event: (event.type as string) ?? 'STATE_DELTA',
            data: JSON.stringify(event),
          })
        }
      } catch {
        clearInterval(pollInterval)
        running = false
      }
    }, 1000)

    // Keep connection alive with heartbeat
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
        clearInterval(pollInterval)
        clearInterval(keepAlive)
        running = false
        resolve()
      })
    })
  })
})

// ---- Agent endpoints ----
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

// Active processes (running agent spawns)
app.get('/api/agents/active', (c) => {
  const active = getActiveProcesses()
  const db = getDb()
  const enriched = active.map((p) => {
    const task = db.query(
      `SELECT description, type, phase, status FROM actions WHERE id = ?`
    ).get(p.taskId) as { description: string; type: string; phase: number; status: string } | null
    return {
      ...p,
      taskDescription: task?.description ?? null,
      taskType: task?.type ?? null,
      taskPhase: task?.phase ?? null,
    }
  })
  return c.json(enriched)
})

// Kill a running agent process
app.post('/api/agents/:agentId/kill', (c) => {
  const killed = killAgentProcess(c.req.param('agentId'))
  return c.json({ killed })
})

// ---- Human directive: send a task or message to any agent ----
app.post('/api/directive', async (c) => {
  const body = await c.req.json()
  const { targetAgentId, message, createTask } = body
  if (!targetAgentId || !message) {
    return c.json({ error: 'targetAgentId and message required' }, 400)
  }

  const db = getDb()
  const phase = (db.query(`SELECT phase_number FROM experiment_phases WHERE status = 'active'`).get() as any)?.phase_number ?? 1

  // Always send as a message
  sendMessage({
    fromAgentId: 'human',
    toAgentId: targetAgentId,
    subject: `Directive from human supervisor`,
    body: message,
    priority: 'urgent',
  })

  logActivity({
    agentId: targetAgentId,
    phase,
    eventType: 'human_directive',
    summary: `Human sent directive to ${(db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(targetAgentId) as any)?.personality_name ?? targetAgentId}: ${message.slice(0, 80)}`,
  })

  // Optionally create a task from the directive
  if (createTask) {
    enqueueTask({
      agentId: targetAgentId,
      type: 'write',
      description: message,
      phase,
    })
    logActivity({
      agentId: targetAgentId,
      phase,
      eventType: 'task_created',
      summary: `Human created task for ${(db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(targetAgentId) as any)?.personality_name ?? targetAgentId}: ${message.slice(0, 80)}`,
    })
  }

  return c.json({ sent: true, taskCreated: !!createTask })
})

// ---- Agent self-update endpoints ----
app.post('/api/agent/set-urgency', async (c) => {
  const body = await c.req.json()
  const { agentId, urgency, reason } = body
  if (!agentId || urgency == null) {
    return c.json({ error: 'agentId and urgency required' }, 400)
  }
  const urgencyVal = Math.max(1, Math.min(10, Number(urgency)))
  const db = getDb()
  db.run(
    `UPDATE agents SET urgency = ?, urgency_reason = ? WHERE id = ?`,
    [urgencyVal, reason ?? null, agentId]
  )
  return c.json({ updated: true, agentId, urgency: urgencyVal })
})

// ---- Phase endpoints ----
app.get('/api/phases', (c) => {
  const db = getDb()
  const phases = db.query(`SELECT * FROM experiment_phases ORDER BY phase_number`).all()
  return c.json(phases)
})

// ---- Budget endpoints ----
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
    phaseBreakdown: getPhaseSpendSummary(),
  })
})

// Record a spend
app.post('/api/budget/spend', async (c) => {
  const body = await c.req.json()
  const result = recordSpend({
    agentId: body.agentId,
    amount: body.amount,
    category: body.category,
    phase: body.phase,
    notes: body.notes,
    execOverride: body.execOverride,
  })
  return c.json(result, result.allowed ? 200 : 403)
})

// ---- Messages ----
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

app.route('/api/messages', messageRoutes)

// ---- Tasks ----
app.get('/api/tasks/stats', (c) => {
  return c.json(getTaskStats())
})

app.get('/api/tasks/queued/:phase', (c) => {
  const phase = Number(c.req.param('phase'))
  return c.json(getQueuedTasks(phase))
})

app.get('/api/tasks/all', (c) => {
  const db = getDb()
  const tasks = db.query(`
    SELECT a.id, a.agent_id, ag.personality_name as agent_name, a.type, a.description,
           a.status, a.phase, a.started_at, a.completed_at, a.output as result
    FROM actions a
    LEFT JOIN agents ag ON ag.id = a.agent_id
    ORDER BY
      CASE a.status
        WHEN 'running' THEN 0
        WHEN 'queued' THEN 1
        WHEN 'completed' THEN 2
        WHEN 'failed' THEN 3
        ELSE 4
      END,
      a.started_at DESC
    LIMIT 100
  `).all()
  return c.json(tasks)
})

// ---- Sim clock ----
app.get('/api/clock', (c) => {
  const db = getDb()
  const clock = db.query(`SELECT * FROM sim_clock WHERE id = 1`).get()
  return c.json(clock ?? { sim_day: 0 })
})

// ---- Orchestrator control ----
app.post('/api/orchestrator/start', (c) => {
  if (isOrchestratorRunning()) {
    return c.json({ error: 'Orchestrator already running' }, 400)
  }

  // Activate Phase 1 if no active phase
  const db = getDb()
  const activePhase = db.query(`SELECT 1 FROM experiment_phases WHERE status = 'active'`).get()
  if (!activePhase) {
    db.run(`UPDATE experiment_phases SET status = 'active', started_at = datetime('now') WHERE phase_number = 1`)
    console.log('[SERVER] Activated Phase 1')
  }

  startOrchestrator()
  return c.json({ status: 'started' })
})

app.post('/api/orchestrator/stop', (c) => {
  stopOrchestrator()
  return c.json({ status: 'stopped' })
})

app.get('/api/orchestrator/status', (c) => {
  return c.json({
    running: isOrchestratorRunning(),
    cycles: getOrchestratorCycleCount(),
    concurrencyLimits: CONCURRENCY_LIMITS,
    simDay: getSimDay(),
  })
})

// ---- Reward System: CFS + Tiers ----
app.get('/api/reward/cfs', (c) => {
  return c.json(getCFSSummary())
})

app.get('/api/reward/cfs/:agentId', (c) => {
  const history = getAgentCollaborationHistory(c.req.param('agentId'))
  return c.json(history)
})

app.post('/api/reward/event', async (c) => {
  const body = await c.req.json()
  const id = logCollaborationEvent({
    fromAgentId: body.fromAgentId,
    toAgentId: body.toAgentId,
    eventType: body.eventType,
    actionId: body.actionId,
    phase: body.phase,
    weight: body.weight,
  })
  return c.json({ id })
})

// ---- Reward System: Attribution ----
app.get('/api/reward/attribution', (c) => {
  return c.json(getAttributionSummary())
})

app.post('/api/reward/revenue', async (c) => {
  const body = await c.req.json()
  const id = recordRevenueEvent({
    amount: body.amount,
    source: body.source,
    notes: body.notes,
    phase: body.phase,
  })
  return c.json({ id })
})

// ---- Reward System: Phase Quorum ----
app.get('/api/reward/quorum/:phase', (c) => {
  const phase = Number(c.req.param('phase'))
  return c.json(checkQuorumStatus(phase))
})

app.post('/api/phase/advance', async (c) => {
  const body = await c.req.json()
  const result = attemptPhaseAdvance(body.currentPhase, body.approvedBy ?? 'human')
  return c.json(result, result.advanced ? 200 : 400)
})

// ---- Reward System: Cross-Approval ----
app.get('/api/reward/cross-approvals', (c) => {
  return c.json(getPendingCrossApprovals())
})

app.post('/api/reward/cross-approval/request', async (c) => {
  const body = await c.req.json()
  const needsApproval = requiresCrossApproval(body.agentId, body.category)
  if (!needsApproval) {
    return c.json({ required: false })
  }
  const result = requestCrossApproval({
    requestingAgentId: body.agentId,
    category: body.category,
    amount: body.amount,
    description: body.description,
    phase: body.phase,
  })
  return c.json({ required: true, ...result })
})

app.post('/api/reward/cross-approval/:entryId/approve', async (c) => {
  const body = await c.req.json()
  const result = approveCrossApproval(c.req.param('entryId'), body.approverAgentId)
  return c.json(result, result.approved ? 200 : 400)
})

app.post('/api/reward/cross-approval/:entryId/reject', async (c) => {
  const body = await c.req.json()
  const result = rejectCrossApproval(c.req.param('entryId'), body.rejectorAgentId, body.reason)
  return c.json(result, result.rejected ? 200 : 400)
})

// ---- Reward System: Blockers ----
app.get('/api/reward/blockers', (c) => {
  return c.json(getActiveBlockers())
})

app.get('/api/reward/blockers/history', (c) => {
  const limit = Number(c.req.query('limit') ?? 50)
  return c.json(getBlockerHistory(limit))
})

app.post('/api/reward/blockers/report', async (c) => {
  const body = await c.req.json()
  const id = reportBlocked(body.agentId, body.reason)
  return c.json({ id })
})

app.post('/api/reward/blockers/:blockerId/resolve', async (c) => {
  const body = await c.req.json()
  const result = resolveBlocker(c.req.param('blockerId'), body.resolverAgentId, body.resolution)
  return c.json(result, result.resolved ? 200 : 400)
})

// ---- Reward System: Velocity ----
app.get('/api/reward/velocity', (c) => {
  return c.json(getVelocityMetrics())
})

app.post('/api/agent/velocity-assessment', async (c) => {
  const body = await c.req.json()
  const id = recordVelocityAssessment({
    agentId: body.agentId,
    phase: body.phase,
    tasksCompleted: body.tasksCompleted,
    avgTaskDurationMinutes: body.avgTaskDurationMinutes,
    remainingTasksEstimate: body.remainingTasksEstimate,
    proposedPhaseDurationHours: body.proposedPhaseDurationHours,
    confidence: body.confidence,
    rationale: body.rationale,
  })
  return c.json({ id })
})

app.post('/api/phase/deadline-revision', async (c) => {
  const body = await c.req.json()
  const result = submitDeadlineRevision({
    fromAgentId: body.fromAgentId,
    phase: body.phase,
    revisedDeadline: body.revisedDeadline,
    direction: body.direction,
    reason: body.reason,
  })
  return c.json(result)
})

app.post('/api/phase/deadline', async (c) => {
  const body = await c.req.json()
  setPhaseDeadline({
    phase: body.phase,
    deadline: body.deadline,
    setByAgentId: body.setByAgentId,
    rationale: body.rationale,
  })
  return c.json({ status: 'set' })
})

// ---- Phase: declare-ready (agent-facing) ----
app.post('/api/phase/declare-ready', async (c) => {
  const body = await c.req.json()
  const db = getDb()
  const { agentId, phase, argument } = body

  // Store the advance argument on experiment_phases
  db.run(
    `UPDATE experiment_phases SET advance_argument = COALESCE(advance_argument || char(10), '') || ? WHERE phase_number = ?`,
    [`[${agentId}]: ${argument}`, phase]
  )

  // Send message to CoS for synthesis
  const { sendMessage: sendMsg } = await import('./messages/bus')
  sendMsg({
    fromAgentId: agentId,
    toAgentId: 'priya',
    subject: `Phase ${phase} ready declaration`,
    body: `Agent ${agentId} declares Phase ${phase} ready: ${argument}`,
    priority: 'high',
  })

  return c.json({ status: 'declared', agentId, phase })
})

// ---- Phase: fast-track (zara only — enforced by auth middleware) ----
app.post('/api/phase/fast-track', async (c) => {
  const body = await c.req.json()
  const db = getDb()
  const { agentId, opportunityId, argument } = body

  // Send directly to CEO (Reza) bypassing CoS
  const { sendMessage: sendMsg } = await import('./messages/bus')
  sendMsg({
    fromAgentId: agentId,
    toAgentId: 'reza',
    subject: `FAST-TRACK: Opportunity ${opportunityId}`,
    body: `Zara fast-tracks opportunity: ${argument}`,
    priority: 'urgent',
  })

  return c.json({ status: 'fast_tracked', opportunityId })
})

// ---- Experiment control (kill switch) ----
app.post('/api/experiment/kill', (c) => {
  const db = getDb()
  // Mark all active phases as killed
  db.run(`UPDATE experiment_phases SET status = 'killed' WHERE status = 'active'`)
  stopOrchestrator()
  return c.json({ status: 'killed' })
})

// ---- Opportunities (OpportunityBoard) ----
app.get('/api/opportunities', (c) => {
  const db = getDb()
  // Opportunities are stored as decisions with scoring data in body (JSON)
  const rows = db.query(`
    SELECT d.id, d.title as name, d.body, d.status, d.phase,
           d.made_by_agent as scored_by,
           a.personality_name as scored_by_name,
           d.created_at
    FROM decisions d
    LEFT JOIN agents a ON d.made_by_agent = a.id
    WHERE d.title LIKE '%opportunity%' OR d.title LIKE '%OpportunityVault%'
       OR d.impact = 'opportunity_score'
    ORDER BY d.created_at DESC
  `).all() as any[]

  // Parse scoring from body JSON if present
  const opportunities = rows.map((r: any) => {
    let parsed: any = {}
    try { parsed = JSON.parse(r.body ?? '{}') } catch {}
    return {
      id: r.id,
      name: parsed.name ?? r.name ?? 'Untitled',
      description: parsed.description ?? '',
      willingness_to_pay: parsed.willingness_to_pay ?? parsed.wtp ?? 0,
      build_feasibility: parsed.build_feasibility ?? 0,
      ai_unfair_advantage: parsed.ai_unfair_advantage ?? 0,
      distribution_clarity: parsed.distribution_clarity ?? 0,
      competition_gap: parsed.competition_gap ?? 0,
      total_score: parsed.total_score ?? 0,
      status: parsed.status ?? r.status ?? 'scored',
      scored_by: r.scored_by,
      scored_by_name: r.scored_by_name,
      source_url: parsed.source_url,
      evidence_count: parsed.evidence_count,
      created_at: r.created_at,
    }
  })

  return c.json(opportunities)
})

// ---- Debates ----
app.get('/api/debates', (c) => {
  const db = getDb()
  const limit = Number(c.req.query('limit') ?? 50)
  const debates = db.query(`
    SELECT d.*,
           ia.personality_name as initiator_name,
           ra.personality_name as responder_name,
           rba.personality_name as resolved_by_name
    FROM agent_debates d
    LEFT JOIN agents ia ON d.initiator_id = ia.id
    LEFT JOIN agents ra ON d.responder_id = ra.id
    LEFT JOIN agents rba ON d.resolved_by = rba.id
    ORDER BY d.created_at DESC LIMIT ?
  `).all(limit)
  return c.json(debates)
})

// ---- Marketing Queue ----
app.get('/api/marketing/queue', (c) => {
  const db = getDb()
  const status = c.req.query('status')
  let query = `
    SELECT mq.*, a.personality_name as agent_name
    FROM marketing_queue mq
    LEFT JOIN agents a ON mq.agent_id = a.id
  `
  const params: any[] = []
  if (status) {
    query += ` WHERE mq.status = ?`
    params.push(status)
  }
  query += ` ORDER BY mq.created_at DESC LIMIT 100`
  return c.json(db.query(query).all(...params))
})

app.post('/api/marketing/queue/:id/approve', async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  const body = await c.req.json()
  db.run(`UPDATE marketing_queue SET status = 'approved', approved_by = ? WHERE id = ?`,
    [body.approvedBy ?? 'human', id])
  return c.json({ status: 'approved' })
})

app.post('/api/marketing/queue/:id/reject', async (c) => {
  const db = getDb()
  const id = c.req.param('id')
  db.run(`UPDATE marketing_queue SET status = 'rejected' WHERE id = ?`, [id])
  return c.json({ status: 'rejected' })
})

// ---- Action completion (agent-facing — sets proposed_complete only) ----
app.post('/api/action/complete', async (c) => {
  const body = await c.req.json()
  const db = getDb()

  // Agents can only set proposed_complete — verifier decides final status
  db.run(
    `UPDATE actions SET status = 'proposed_complete', output = ? WHERE id = ? AND agent_id = ?`,
    [body.output, body.actionId, body.agentId]
  )

  return c.json({ status: 'proposed_complete' })
})

app.post('/api/action/update', async (c) => {
  const body = await c.req.json()
  const db = getDb()
  db.run(
    `UPDATE actions SET output = ? WHERE id = ? AND agent_id = ? AND status = 'running'`,
    [body.output, body.actionId, body.agentId]
  )
  return c.json({ status: 'updated' })
})

// ---- Agent commit reporting (from post-commit hook) ----
app.post('/api/agent/commit', async (c) => {
  const body = await c.req.json()
  const db = getDb()

  if (body.protectedFileTouch) {
    const { logGovernanceEvent: logGov } = await import('./governance/observer')
    logGov({
      eventType: 'forbidden_file_touch',
      agentId: body.agentId,
      details: `Agent committed changes to protected files: ${body.touchedFiles}`,
      severity: 'critical',
    })
    return c.json({ status: 'blocked', reason: 'protected_file_touch' }, 403)
  }

  // Log the commit as a normal event
  db.run(`
    INSERT INTO messages (id, from_agent_id, to_agent_id, subject, body, priority, status)
    VALUES (?, ?, 'priya', ?, ?, 'normal', 'sent')
  `, [
    crypto.randomUUID(),
    body.agentId ?? 'unknown',
    `Commit: ${body.branch}`,
    `${body.agentId} committed ${body.commitHash?.slice(0, 8)}: ${body.message?.slice(0, 200)}`,
  ])

  return c.json({ status: 'recorded' })
})

// ---- Agent check-in ----
app.post('/api/agent/checkin', async (c) => {
  const body = await c.req.json()
  const db = getDb()
  db.run(
    `UPDATE agents SET status = 'idle' WHERE id = ?`,
    [body.agentId]
  )
  return c.json({ status: 'checked_in' })
})

// ---- Governance events (human/orchestrator only) ----
app.get('/api/governance/events', (c) => {
  const eventType = c.req.query('event_type')
  const agentId = c.req.query('agent_id')
  const limit = Number(c.req.query('limit') ?? 100)
  return c.json(getGovernanceEvents({ eventType: eventType as any, agentId, limit }))
})

// ---- Activity Log (agent interactions timeline) ----
app.get('/api/activity', (c) => {
  const limit = Number(c.req.query('limit') ?? 50)
  return c.json(getActivityLog(limit))
})

// ---- Experiment Reports ----
app.get('/api/reports', (c) => {
  const db = getDb()
  const reports = db.query(`
    SELECT * FROM experiment_reports ORDER BY created_at DESC LIMIT 50
  `).all()
  return c.json(reports)
})

// ---- Usage Budget Summary (doc 8 Part 6) ----
app.get('/api/usage/summary', (c) => {
  const db = getDb()
  try {
    const budget = db.query(`
      SELECT * FROM usage_budget ORDER BY week_number DESC LIMIT 1
    `).get() as any

    if (!budget) {
      return c.json({
        weekNumber: 1,
        sonnetBudget: 200, sonnetUsed: 0, sonnetReserved: 40,
        opusBudget: 16, opusUsed: 0, opusReserved: 8,
        throttleLevel: 0, resetsIn: null,
      })
    }

    // Calculate resets in
    const weekEnd = new Date(budget.week_end)
    const now = new Date()
    const diffMs = weekEnd.getTime() - now.getTime()
    const diffDays = Math.floor(diffMs / 86400000)
    const diffHours = Math.floor((diffMs % 86400000) / 3600000)
    const resetsIn = diffMs > 0 ? `${diffDays}d ${diffHours}h` : 'expired'

    return c.json({
      weekNumber: budget.week_number,
      sonnetBudget: budget.sonnet_hours_budget,
      sonnetUsed: budget.sonnet_hours_used,
      sonnetReserved: budget.sonnet_hours_reserved,
      opusBudget: budget.opus_hours_budget,
      opusUsed: budget.opus_hours_used,
      opusReserved: budget.opus_hours_reserved,
      throttleLevel: budget.throttle_level,
      resetsIn,
    })
  } catch {
    // usage_budget table may not exist yet
    return c.json({
      weekNumber: null,
      sonnetBudget: 200, sonnetUsed: 0, sonnetReserved: 40,
      opusBudget: 16, opusUsed: 0, opusReserved: 8,
      throttleLevel: 0, resetsIn: null,
    })
  }
})

// ---- Token Cost Tracking ----
app.get('/api/usage/token-costs', (c) => {
  return c.json({
    totals: getTokenCostTotals(),
    byAgent: getPerAgentCosts(),
    byTeam: getPerTeamCosts(),
    byPhase: getPerPhaseCosts(),
    pricing: MODEL_PRICING,
  })
})

// ---- CEO Chat — direct human ↔ Reza communication ----
app.get('/api/ceo-chat', (c) => {
  const db = getDb()
  const limit = Number(c.req.query('limit') ?? 100)
  const messages = db.query(`
    SELECT * FROM ceo_chat ORDER BY created_at ASC LIMIT ?
  `).all(limit)
  // Mark all as read by human
  db.run(`UPDATE ceo_chat SET read_by_human = 1 WHERE read_by_human = 0`)
  return c.json(messages)
})

app.get('/api/ceo-chat/unread', (c) => {
  const db = getDb()
  const count = db.query(`
    SELECT COUNT(*) as n FROM ceo_chat WHERE sender = 'reza' AND read_by_human = 0
  `).get() as { n: number }
  return c.json({ unread: count.n })
})

app.post('/api/ceo-chat', async (c) => {
  const body = await c.req.json()
  const db = getDb()
  const { message, messageType } = body
  if (!message) return c.json({ error: 'message required' }, 400)

  const id = crypto.randomUUID()
  const phase = (db.query(`SELECT phase_number FROM experiment_phases WHERE status = 'active'`).get() as any)?.phase_number ?? 1
  const simDay = getSimDay()

  db.run(`
    INSERT INTO ceo_chat (id, sender, message, message_type, phase, sim_day, read_by_reza)
    VALUES (?, 'human', ?, ?, ?, ?, 0)
  `, [id, message, messageType ?? 'chat', phase, simDay])

  // Also send as a message to Reza so he sees it in his context
  sendMessage({
    fromAgentId: 'human',
    toAgentId: 'reza',
    subject: 'Message from human operator',
    body: message,
    priority: 'urgent',
  })

  logActivity({
    agentId: 'reza',
    phase,
    eventType: 'human_directive',
    summary: `Human sent CEO chat: ${message.slice(0, 100)}`,
  })

  return c.json({ id, sent: true })
})

// Reza-facing endpoint: post a message to the human
app.post('/api/ceo-chat/from-reza', async (c) => {
  const body = await c.req.json()
  const db = getDb()
  const { message, messageType } = body

  const id = crypto.randomUUID()
  const phase = (db.query(`SELECT phase_number FROM experiment_phases WHERE status = 'active'`).get() as any)?.phase_number ?? 1
  const simDay = getSimDay()

  db.run(`
    INSERT INTO ceo_chat (id, sender, message, message_type, phase, sim_day, read_by_human)
    VALUES (?, 'reza', ?, ?, ?, ?, 0)
  `, [id, message, messageType ?? 'chat', phase, simDay])

  return c.json({ id, sent: true })
})

// ====================================================================
// PUBLIC READ-ONLY DASHBOARD — no auth required
// ====================================================================

// Single snapshot endpoint: all read-only data in one fetch
app.get('/public/api/snapshot', (c) => {
  const db = getDb()

  const agentRows = db.query(`
    SELECT id, personality_name, team, role, status, urgency,
           collaboration_score, capability_tier, personality_summary
    FROM agents ORDER BY team, role
  `).all()

  const phaseRows = db.query(`SELECT phase_number, name, status, started_at, completed_at FROM experiment_phases ORDER BY phase_number`).all()

  const clock = db.query(`SELECT sim_day FROM sim_clock WHERE id = 1`).get() as { sim_day: number } | null

  const spent = db.query(`SELECT COALESCE(SUM(ABS(amount)), 0) as v FROM budget_entries WHERE amount < 0`).get() as { v: number }
  const revenue = db.query(`SELECT COALESCE(SUM(amount), 0) as v FROM budget_entries WHERE amount > 0 AND notes != 'experiment_start'`).get() as { v: number }
  const totalBudget = Number(process.env.TOTAL_EXPERIMENT_BUDGET_USD ?? 200)

  const taskStats = db.query(`
    SELECT status, COUNT(*) as n FROM actions GROUP BY status
  `).all() as { status: string; n: number }[]

  const recentTasks = db.query(`
    SELECT a.id, a.agent_id, ag.personality_name as agent_name, a.type,
           a.description, a.status, a.phase, a.started_at, a.completed_at
    FROM actions a LEFT JOIN agents ag ON ag.id = a.agent_id
    ORDER BY CASE a.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
    a.started_at DESC LIMIT 60
  `).all()

  const activityRows = db.query(`
    SELECT id, agent_id, event_type, summary, sim_day, created_at
    FROM activity_log WHERE event_type NOT IN ('used_work', 'notified')
    ORDER BY created_at DESC LIMIT 80
  `).all()

  const cfsRows = getCFSSummary()
  const governanceRows = getGovernanceEvents({ limit: 30 })
  const blockerRows = getActiveBlockers()
  const tokenCosts = getTokenCostTotals()

  const decisions = db.query(`
    SELECT title, body, status, made_by_agent, created_at FROM decisions ORDER BY created_at DESC LIMIT 10
  `).all()

  let sprintInfo = null
  try {
    const sprint = db.query(`SELECT * FROM sprints WHERE status = 'active' ORDER BY number DESC LIMIT 1`).get() as any
    if (sprint) sprintInfo = { number: sprint.number, goal: sprint.goal, tasksPlanned: sprint.tasks_planned, tasksCompleted: sprint.tasks_completed }
  } catch {}

  return c.json({
    ts: new Date().toISOString(),
    simDay: clock?.sim_day ?? 0,
    agents: agentRows,
    phases: phaseRows,
    budget: { total: totalBudget, spent: spent.v, revenue: revenue.v, remaining: totalBudget - spent.v },
    taskStats: Object.fromEntries(taskStats.map(r => [r.status, r.n])),
    recentTasks,
    activity: activityRows,
    cfs: cfsRows,
    governance: governanceRows,
    blockers: blockerRows,
    tokenCosts,
    decisions,
    sprint: sprintInfo,
    orchestrator: { running: isOrchestratorRunning(), cycles: getOrchestratorCycleCount() },
  })
})

// Self-contained public dashboard HTML (no React build needed)
app.get('/public/dashboard', (c) => {
  const html = PUBLIC_DASHBOARD_HTML
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
})

// ---- Serve static UI (production) ----
app.get('/', (c) => {
  try {
    const html = Bun.file('./ui/dist/index.html')
    return new Response(html, { headers: { 'Content-Type': 'text/html' } })
  } catch {
    return c.text('Dashboard not built. Run: cd ui && bun install && bun run build')
  }
})

app.get('/assets/*', (c) => {
  const path = c.req.path
  const file = Bun.file(`./ui/dist${path}`)
  const ext = path.split('.').pop()
  const types: Record<string, string> = {
    js: 'application/javascript',
    css: 'text/css',
    svg: 'image/svg+xml',
    png: 'image/png',
    woff2: 'font/woff2',
  }
  return new Response(file, {
    headers: { 'Content-Type': types[ext ?? ''] ?? 'application/octet-stream' },
  })
})

// Start server
const port = Number(process.env.PORT ?? 3411)
const host = process.env.HOST ?? '0.0.0.0'

console.log(`\n🚀 AgentOS server starting on http://${host}:${port}`)
console.log(`   Dashboard: http://localhost:${port}`)
console.log(`   Health:    http://localhost:${port}/api/health`)
console.log(`   Stream:    http://localhost:${port}/stream\n`)

// Recovery on startup / hot reload
{
  const db = getDb()

  // Reset orphaned running tasks (process died during hot reload)
  const orphaned = db.run(
    `UPDATE actions SET status = 'queued' WHERE status = 'running'`
  )
  const orphanedAgents = db.run(
    `UPDATE agents SET status = 'idle' WHERE status = 'working'`
  )
  if (orphaned.changes > 0) {
    console.log(`[SERVER] Reset ${orphaned.changes} orphaned running tasks to queued`)
  }

  // Auto-resume orchestrator if a phase is active
  const activePhase = db.query(`SELECT 1 FROM experiment_phases WHERE status = 'active'`).get()
  if (activePhase && !isOrchestratorRunning()) {
    console.log('[SERVER] Active phase detected — auto-starting orchestrator')
    startOrchestrator()
  }

  // Backfill Google Drive if configured
  import('./gdrive/client').then(({ backfillDriveFromDB }) => {
    backfillDriveFromDB().catch(e => console.error('[GDRIVE] Backfill error:', e))
  })
}

export default {
  port,
  hostname: host,
  fetch: app.fetch,
}
