import { getDb } from './db/database'
import { spawnAgentProcess, getActiveProcessCount } from './agents/runner'
import { dequeueTask, seedPhase1Tasks } from './tasks/queue'
import { checkBudgetExhausted, checkPhaseSpendCeiling } from './budget/enforcer'
import { sendMessage } from './messages/bus'
import { advanceSimDayIfNeeded, getSimDay } from './clock'
import {
  recalculateAllCFS,
  updateAllTiers,
  recordQuorumContribution,
  checkQuorumStatus,
} from './reward'
import { rotateLogs } from './log-rotate'
import { getMaxConcurrentAgents, getCurrentWeekBudget, calculateThrottleLevel } from './usage/budget-manager'
import { enqueueTask } from './tasks/queue'
import { logActivity } from './activity'
import { generatePhaseTasks, isDiminishingReturns, analyzePhaseGaps } from './intelligence/analyzer'
import { runCollaborationChecks } from './collaboration/engine'
import { checkSprintBoundary, getCurrentSprint } from './sprints/manager'
import { generatePerformanceScorecard, checkPerformanceActions } from './performance/tracker'
import { checkReportGeneration, backfillOpportunities } from './reports/generator'

// ---------------------------------------------------------------------------
// Concurrency limits — doc 6 Issue 5
// ---------------------------------------------------------------------------
export const CONCURRENCY_LIMITS: Record<string, number> = {
  exec:      1,
  strategy:  1,
  tech:      1,
  ops:       1,
  marketing: 1,
  total:     2,  // Max 2 concurrent agents to control costs
}

// ---------------------------------------------------------------------------
// Stop condition constants
// ---------------------------------------------------------------------------
const MAX_CONSECUTIVE_FAILURES = 3
const COS_AGENT_ID = 'priya'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let experimentRunning = false
let cycleCount = 0

// ---------------------------------------------------------------------------
// Concurrency check — exec bypasses total limit
// ---------------------------------------------------------------------------
function getAvailableSlot(team: string): boolean {
  const db = getDb()

  const teamActive = db.query(
    `SELECT COUNT(*) as n FROM agents WHERE team = ? AND status = 'working'`
  ).get(team) as { n: number }

  const totalActive = db.query(
    `SELECT COUNT(*) as n FROM agents WHERE status = 'working'`
  ).get() as { n: number }

  const teamLimit = CONCURRENCY_LIMITS[team] ?? 1

  // Apply usage-based throttle to total limit
  const budget = getCurrentWeekBudget()
  const throttleLevel = calculateThrottleLevel(budget)
  const throttledTotal = Math.min(
    CONCURRENCY_LIMITS.total ?? 6,
    getMaxConcurrentAgents(throttleLevel)
  )

  // Exec team bypasses total limit — they're always available for decisions
  if (team === 'exec') {
    return teamActive.n < teamLimit
  }

  return teamActive.n < teamLimit && totalActive.n < throttledTotal
}

// ---------------------------------------------------------------------------
// Get agents ready to work
// ---------------------------------------------------------------------------
function getReadyAgents(): Array<{
  id: string
  personality_name: string
  team: string
  role: string
  status: string
  urgency: number
}> {
  const db = getDb()
  return db.query(`
    SELECT id, personality_name, team, role, status, urgency
    FROM agents
    WHERE status = 'idle'
    ORDER BY urgency DESC, team
  `).all() as any[]
}

// ---------------------------------------------------------------------------
// Set agent status
// ---------------------------------------------------------------------------
function setAgentStatus(agentId: string, status: string): void {
  const db = getDb()
  db.run(`UPDATE agents SET status = ? WHERE id = ?`, [status, agentId])
}

// ---------------------------------------------------------------------------
// Check stop conditions — returns reason string or null
// ---------------------------------------------------------------------------
function checkStopConditions(): string | null {
  const db = getDb()

  // 1. Budget exhausted
  if (checkBudgetExhausted()) {
    return 'budget_exhausted'
  }

  // 2. CEO called experiment end
  const killDecision = db.query(`
    SELECT id FROM decisions
    WHERE made_by_agent = 'reza' AND title LIKE '%kill%experiment%' AND status = 'approved'
    ORDER BY created_at DESC LIMIT 1
  `).get()
  if (killDecision) {
    return 'ceo_kill'
  }

  // 3. Human kill switch (check for a flag in experiment_phases)
  const killed = db.query(`
    SELECT 1 FROM experiment_phases WHERE status = 'killed'
  `).get()
  if (killed) {
    return 'human_kill'
  }

  // 4. Experiment day > 30 — auto-stop and trigger final report
  const simDay = getSimDay()
  if (simDay > 30) {
    return 'day_30_limit'
  }

  return null
}

// ---------------------------------------------------------------------------
// Check for suspended agents (3 consecutive failures)
// ---------------------------------------------------------------------------
function checkConsecutiveFailures(): void {
  const db = getDb()

  const agents = db.query(`
    SELECT id, personality_name FROM agents WHERE status != 'suspended'
  `).all() as { id: string; personality_name: string }[]

  for (const agent of agents) {
    const recentActions = db.query(`
      SELECT status FROM actions
      WHERE agent_id = ? ORDER BY completed_at DESC LIMIT ?
    `).all(agent.id, MAX_CONSECUTIVE_FAILURES) as { status: string }[]

    if (
      recentActions.length >= MAX_CONSECUTIVE_FAILURES &&
      recentActions.every(a => a.status === 'failed')
    ) {
      setAgentStatus(agent.id, 'suspended')
      sendMessage({
        fromAgentId: 'system',
        toAgentId: COS_AGENT_ID,
        subject: `Agent ${agent.personality_name} suspended`,
        body: `Agent ${agent.personality_name} has failed ${MAX_CONSECUTIVE_FAILURES} consecutive tasks and has been suspended. Please investigate.`,
        priority: 'urgent',
      })
      console.warn(`[ORCHESTRATOR] Agent ${agent.personality_name} suspended after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`)
    }
  }
}

// ---------------------------------------------------------------------------
// Deadlock detection — doc 1: 4+ hours no completed action → alert
// ---------------------------------------------------------------------------
function checkDeadlock(): void {
  const db = getDb()

  const lastCompleted = db.query(`
    SELECT completed_at FROM actions
    WHERE status = 'completed'
    ORDER BY completed_at DESC LIMIT 1
  `).get() as { completed_at: string } | null

  if (!lastCompleted) return

  const lastCompletedTime = new Date(lastCompleted.completed_at + 'Z').getTime()
  const elapsed = Date.now() - lastCompletedTime
  const fourHours = 4 * 60 * 60 * 1000

  if (elapsed >= fourHours) {
    // Check if there are active blockers — if so, this is a blocker-related deadlock
    const activeBlockers = db.query(`
      SELECT COUNT(*) as n FROM blocked_agents WHERE resolved_by IS NULL
    `).get() as { n: number }

    const reason = activeBlockers.n > 0
      ? `Deadlock: ${activeBlockers.n} unresolved blockers, no completed action in ${Math.round(elapsed / 3600000)}h`
      : `Deadlock: no completed action in ${Math.round(elapsed / 3600000)}h, no active blockers`

    sendMessage({
      fromAgentId: 'system',
      toAgentId: COS_AGENT_ID,
      subject: 'DEADLOCK ALERT',
      body: reason,
      priority: 'urgent',
    })

    broadcastAGUI({
      type: 'ORCHESTRATOR_ERROR',
      error: reason,
      cycle: cycleCount,
    })

    console.warn(`[ORCHESTRATOR] ${reason}`)
  }
}

// ---------------------------------------------------------------------------
// Check daily token limits
// ---------------------------------------------------------------------------
function checkTokenLimits(): void {
  const db = getDb()

  const overLimit = db.query(`
    SELECT a.id, a.personality_name, a.token_budget_today, a.token_budget_remaining
    FROM agents a
    WHERE a.status = 'idle' AND a.token_budget_remaining IS NOT NULL AND a.token_budget_remaining <= 0
  `).all() as { id: string; personality_name: string; token_budget_today: number; token_budget_remaining: number }[]

  for (const agent of overLimit) {
    setAgentStatus(agent.id, 'rate_limited')

    // Log to usage_windows
    db.run(`
      INSERT OR REPLACE INTO usage_windows (id, agent_id, window_date, tokens_used, tokens_limit)
      VALUES (?, ?, date('now'), ?, ?)
    `, [
      `${agent.id}-${new Date().toISOString().slice(0, 10)}`,
      agent.id,
      agent.token_budget_today,
      agent.token_budget_today,
    ])

    console.warn(`[ORCHESTRATOR] Agent ${agent.personality_name} rate-limited (daily token budget exhausted)`)
  }
}

// ---------------------------------------------------------------------------
// Broadcast AG-UI event
// ---------------------------------------------------------------------------
export function broadcastAGUI(event: Record<string, unknown>): void {
  // AG-UI events are pushed via the SSE stream in index.ts
  // Store in a simple in-memory queue that the SSE endpoint drains
  aguiEventQueue.push({
    ...event,
    timestamp: new Date().toISOString(),
  })
}

export const aguiEventQueue: Record<string, unknown>[] = []

// Drain events (called by SSE endpoint)
export function drainAGUIEvents(): Record<string, unknown>[] {
  const events = [...aguiEventQueue]
  aguiEventQueue.length = 0
  return events
}

// ---------------------------------------------------------------------------
// Team Meetings — orchestrator-driven collaboration rounds
//
// When a team has 3+ completed tasks without a meeting, the team lead gets
// a "team sync" task to review all work, produce a meeting summary, and
// create follow-up tasks. Visible on the dashboard as team collaboration.
// ---------------------------------------------------------------------------

const TEAM_LEADS: Record<string, { id: string; name: string }> = {
  strategy: { id: 'marcus', name: 'Marcus' },
  tech:     { id: 'amir',   name: 'Amir' },
  ops:      { id: 'jordan', name: 'Jordan' },
  marketing:{ id: 'sol',    name: 'Sol' },
}

// Persistent dedup for meetings — stored in SQLite
function hasMeetingKey(key: string): boolean {
  const db = getDb()
  return !!db.query('SELECT 1 FROM interaction_keys WHERE key = ?').get(`meeting-${key}`)
}
function addMeetingKey(key: string): void {
  const db = getDb()
  db.run('INSERT OR IGNORE INTO interaction_keys (key) VALUES (?)', [`meeting-${key}`])
}

function checkTeamMeetings(phase: number): void {
  const db = getDb()

  for (const [team, lead] of Object.entries(TEAM_LEADS)) {
    const key = `${team}-p${phase}`
    if (hasMeetingKey(key)) continue

    // Check if a meeting task already exists
    const existing = db.query(`
      SELECT 1 FROM actions WHERE agent_id = ? AND phase = ? AND type = 'meeting'
    `).get(lead.id, phase)

    if (existing) {
      addMeetingKey(key)
      continue
    }

    // Count completed tasks for this team in this phase (excluding meetings/reviews)
    const completed = db.query(`
      SELECT a.id, ag.personality_name, a.type, a.description, substr(a.output, 1, 800) as preview
      FROM actions a
      JOIN agents ag ON ag.id = a.agent_id
      WHERE ag.team = ? AND a.phase = ? AND a.status = 'completed' AND a.type NOT IN ('review', 'meeting')
      ORDER BY a.completed_at ASC
    `).all(team, phase) as any[]

    // Natural meeting triggers — not just "3 tasks done"
    let meetingReason = ''

    // Trigger 1: Multiple team members have completed work but haven't synced
    const uniqueContributors = new Set((completed as any[]).map(c => c.personality_name))
    if (uniqueContributors.size >= 2 && completed.length >= 2) {
      meetingReason = `${uniqueContributors.size} team members have completed independent work without syncing. Need to align on approach and catch duplicated effort.`
    }

    // Trigger 2: Cross-team work landed that affects this team
    const crossTeamWork = db.query(`
      SELECT ag.personality_name, a.type, substr(a.description, 1, 100) as desc
      FROM actions a
      JOIN agents ag ON ag.id = a.agent_id
      WHERE ag.team != ? AND a.phase = ? AND a.status = 'completed'
        AND a.completed_at > datetime('now', '-2 hours')
        AND a.type IN ('write', 'research', 'decide', 'build')
    `).all(team, phase) as any[]

    if (crossTeamWork.length >= 2 && completed.length >= 1) {
      const crossNames = crossTeamWork.map((w: any) => w.personality_name).join(', ')
      meetingReason = meetingReason || `New work from other teams (${crossNames}) that the ${team} team needs to react to.`
    }

    // Trigger 3: A blocker or verification failure happened on this team
    const recentFailures = db.query(`
      SELECT ag.personality_name, a.verification_notes
      FROM actions a
      JOIN agents ag ON ag.id = a.agent_id
      WHERE ag.team = ? AND a.phase = ? AND a.status = 'verification_failed'
        AND a.completed_at > datetime('now', '-4 hours')
    `).all(team, phase) as any[]

    if (recentFailures.length > 0) {
      meetingReason = meetingReason || `${recentFailures[0].personality_name}'s work failed verification. Team needs to discuss quality standards.`
    }

    if (!meetingReason) continue

    // Build meeting context from all team completions
    const workSummary = completed.map((t: any) =>
      `**${t.personality_name}** (${t.type}): ${t.description}\nOutput: ${t.preview}`
    ).join('\n\n---\n\n')

    // Get team members
    const members = db.query(`
      SELECT personality_name FROM agents WHERE team = ? ORDER BY personality_name
    `).all(team) as { personality_name: string }[]
    const memberNames = members.map(m => m.personality_name).join(', ')

    enqueueTask({
      agentId: lead.id,
      type: 'meeting',
      description: `TEAM SYNC — ${team.toUpperCase()} TEAM\n\nAttendees: ${memberNames}\nTriggered because: ${meetingReason}\n\nAs ${lead.name}, you're running this sync because the team needs to get on the same page. This isn't a status update — it's a working session. Produce:\n\n1. THE PROBLEM: Why are we meeting? What's misaligned or needs attention?\n2. EACH PERSON'S CONTRIBUTION: What has each team member produced? Where are they aligned? Where do they diverge?\n3. DECISIONS MADE: What did the team decide? If there's a disagreement, how did you resolve it?\n4. ACTION ITEMS: Who does what next? Be specific — name, task, deadline.\n5. CROSS-TEAM ASKS: What do you need from other teams? Use [MSG to:<agent_id> priority:high] to request it.\n6. OPEN QUESTIONS: What couldn't be resolved in this meeting?\n\nTeam's completed work this phase:\n\n${workSummary}`,
      phase,
    })

    // Notify team members
    for (const member of members) {
      if (member.personality_name !== lead.name) {
        sendMessage({
          fromAgentId: lead.id,
          toAgentId: (db.query(`SELECT id FROM agents WHERE personality_name = ?`).get(member.personality_name) as any)?.id ?? '',
          subject: `${team.charAt(0).toUpperCase() + team.slice(1)} team sync — we need to align`,
          body: `${lead.name} called a team sync. Reason: ${meetingReason}`,
          priority: 'high',
        })
      }
    }

    logActivity({
      agentId: lead.id,
      phase,
      eventType: 'meeting_scheduled',
      summary: `${lead.name} called ${team} team sync: ${meetingReason.slice(0, 80)}`,
    })

    addMeetingKey(key)
    console.log(`[ORCHESTRATOR] ${team} team meeting triggered: ${meetingReason.slice(0, 80)}`)
  }

  // Exec standup: when 2+ team meetings complete, Priya runs an exec sync
  const teamMeetingsDone = db.query(`
    SELECT COUNT(*) as n FROM actions
    WHERE type = 'meeting' AND phase = ? AND status = 'completed'
  `).get(phase) as { n: number }

  const execKey = `exec-p${phase}`
  if (teamMeetingsDone.n >= 2 && !hasMeetingKey(execKey)) {
    const existingExec = db.query(`
      SELECT 1 FROM actions WHERE agent_id = 'priya' AND phase = ? AND type = 'meeting'
    `).get(phase)

    if (!existingExec) {
      const meetingSummaries = db.query(`
        SELECT ag.personality_name, a.description, substr(a.output, 1, 1000) as preview
        FROM actions a JOIN agents ag ON ag.id = a.agent_id
        WHERE a.type = 'meeting' AND a.phase = ? AND a.status = 'completed'
      `).all(phase) as any[]

      const summaryText = meetingSummaries.map((m: any) =>
        `**${m.personality_name}'s standup:**\n${m.preview}`
      ).join('\n\n---\n\n')

      enqueueTask({
        agentId: 'priya',
        type: 'meeting',
        description: `EXEC STANDUP — ALL TEAMS\n\nAs Chief of Staff, synthesize all team standup reports into an executive brief for Reza.\n\n1. CROSS-TEAM ALIGNMENT: Are teams working toward the same goal?\n2. BLOCKERS: What's stuck and who can unblock it?\n3. RESOURCE ALLOCATION: Is anyone overloaded or underutilized?\n4. RECOMMENDATION: What should Reza focus on?\n\nTeam meeting summaries:\n\n${summaryText}`,
        phase,
      })

      logActivity({
        agentId: 'priya',
        phase,
        eventType: 'meeting_scheduled',
        summary: `Priya scheduled exec standup to synthesize ${teamMeetingsDone.n} team meetings`,
      })

      addMeetingKey(execKey)
    }
  }
}

// ---------------------------------------------------------------------------
// CEO Chat — spawn Reza to respond when human sends him a message
// ---------------------------------------------------------------------------
function checkCEOChatPending(phase: number): void {
  const db = getDb()

  try {
    // Check for unread human messages that Reza hasn't responded to
    const unread = db.query(`
      SELECT id, message, created_at FROM ceo_chat
      WHERE sender = 'human' AND read_by_reza = 0
      ORDER BY created_at ASC
    `).all() as { id: string; message: string; created_at: string }[]

    if (unread.length === 0) return

    // Check if Reza already has a "respond to human" task queued/running
    const existing = db.query(`
      SELECT 1 FROM actions
      WHERE agent_id = 'reza' AND type = 'chat' AND status IN ('queued', 'running')
    `).get()

    if (existing) return

    // Check if Reza is idle — don't interrupt active work
    const reza = db.query(`SELECT status FROM agents WHERE id = 'reza'`).get() as { status: string } | null
    if (reza?.status !== 'idle') return

    // Combine all unread messages into one task
    const messageText = unread.map(m => `[${m.created_at}] ${m.message}`).join('\n\n')

    // Get recent conversation context
    const recentChat = db.query(`
      SELECT sender, message, created_at FROM ceo_chat
      ORDER BY created_at DESC LIMIT 10
    `).all() as any[]

    const chatHistory = recentChat.reverse().map((m: any) =>
      `[${m.sender === 'human' ? 'Human' : 'You'}]: ${m.message}`
    ).join('\n')

    // Get experiment status for context
    const completedCount = (db.query(`SELECT COUNT(*) as n FROM actions WHERE phase = ? AND status = 'completed'`).get(phase) as any)?.n ?? 0
    const queuedCount = (db.query(`SELECT COUNT(*) as n FROM actions WHERE phase = ? AND status = 'queued'`).get(phase) as any)?.n ?? 0

    enqueueTask({
      agentId: 'reza',
      type: 'chat',
      description: `The human operator sent you a message. Respond directly and concisely as Reza (CEO).\n\nConversation history:\n${chatHistory}\n\nExperiment status: Phase ${phase}, ${completedCount} tasks completed, ${queuedCount} queued.\n\nRespond naturally. If they're asking about status, give a brief update. If they're giving direction, acknowledge and say what you'll do. Keep it conversational — this is a chat, not a report. 2-4 sentences max.`,
      phase,
    })

    // Mark messages as read by Reza
    for (const m of unread) {
      db.run(`UPDATE ceo_chat SET read_by_reza = 1 WHERE id = ?`, [m.id])
    }

    console.log(`[ORCHESTRATOR] Queued Reza to respond to ${unread.length} human message(s)`)
  } catch (e) {
    // ceo_chat table may not exist
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator loop
// ---------------------------------------------------------------------------
async function orchestratorLoop(): Promise<void> {
  const cycleSleepMs = Number(process.env.ORCHESTRATOR_CYCLE_MS ?? 10_000)

  console.log(`[ORCHESTRATOR] Starting main loop (cycle interval: ${cycleSleepMs}ms)`)

  while (experimentRunning) {
    cycleCount++
    const db = getDb()

    try {
      // Get active phase
      const activePhase = db.query(
        `SELECT phase_number, name FROM experiment_phases WHERE status = 'active'`
      ).get() as { phase_number: number; name: string } | null

      if (!activePhase) {
        // No active phase — wait
        if (cycleCount % 10 === 0) {
          console.log(`[ORCHESTRATOR] Cycle ${cycleCount}: no active phase, waiting...`)
        }
        await Bun.sleep(cycleSleepMs)
        continue
      }

      // Check stop conditions
      const stopReason = checkStopConditions()
      if (stopReason) {
        console.log(`[ORCHESTRATOR] Stop condition triggered: ${stopReason}`)
        broadcastAGUI({ type: 'EXPERIMENT_STOPPED', reason: stopReason })
        experimentRunning = false
        break
      }

      // Advance sim clock if needed
      advanceSimDayIfNeeded()

      // Check consecutive failures → suspend agents
      checkConsecutiveFailures()

      // Check token limits
      checkTokenLimits()

      // Sprint boundary check (every 20 cycles)
      if (cycleCount % 20 === 0) {
        try {
          checkSprintBoundary(cycleCount, activePhase.phase_number)
        } catch (e) {
          console.error('[SPRINT] Error:', e)
        }
      }

      // Performance check (every 100 cycles -- at sprint boundaries)
      if (cycleCount % 100 === 0) {
        try {
          const sprint = getCurrentSprint()
          if (sprint) {
            checkPerformanceActions(activePhase.phase_number)
          }
        } catch (e) {
          console.error('[PERFORMANCE] Error:', e)
        }
      }

      // Deadlock detection (every 60 cycles ≈ 10 min)
      if (cycleCount % 60 === 0) {
        checkDeadlock()
      }

      // CFS recalc (every 10 cycles — moved from per-task to save compute)
      if (cycleCount % 10 === 0) {
        recalculateAllCFS()
        updateAllTiers()
      }

      // Team meetings (every 20 cycles ≈ 3 min)
      if (cycleCount % 20 === 0) {
        checkTeamMeetings(activePhase.phase_number)
      }

      // Collaboration checks — cross-reviews, debates, 1:1 syncs (every 60 cycles ≈ 10 min)
      // Throttled to prevent cascading meta-work from eating budget
      if (cycleCount % 60 === 0) {
        try {
          runCollaborationChecks(activePhase.phase_number)
        } catch (e) {
          console.error('[COLLAB] Error:', e)
        }
      }

      // CEO chat — check if human sent Reza a message he hasn't responded to
      if (cycleCount % 10 === 0) {
        checkCEOChatPending(activePhase.phase_number)
      }

      // Smart task generation — when a phase has no queued tasks, generate them
      if (cycleCount % 30 === 0) {
        try {
          const queued = db.query(`SELECT COUNT(*) as n FROM actions WHERE phase = ? AND status = 'queued'`).get(activePhase.phase_number) as { n: number }
          if (queued.n === 0 && activePhase.phase_number >= 2) {
            const newTasks = generatePhaseTasks(activePhase.phase_number)
            for (const t of newTasks) {
              enqueueTask(t)
              console.log(`[INTELLIGENCE] Generated task for ${t.agentId}: ${t.description.slice(0, 80)}`)
            }
            if (newTasks.length > 0) {
              console.log(`[INTELLIGENCE] Auto-generated ${newTasks.length} tasks for Phase ${activePhase.phase_number}`)
            }
          }
        } catch (e) {
          console.error('[INTELLIGENCE] Task generation error:', e)
        }
      }

      // Get ready agents and dispatch tasks
      const readyAgents = getReadyAgents()

      for (const agent of readyAgents) {
        // Check concurrency slot
        if (!getAvailableSlot(agent.team)) continue

        // Dequeue task
        const task = dequeueTask(agent.id, activePhase.phase_number)
        if (!task) continue

        // Diminishing returns check — skip if agent is producing repetitive work
        try {
          if (isDiminishingReturns(agent.id, task.type, activePhase.phase_number)) {
            console.log(`[INTELLIGENCE] Diminishing returns for ${agent.personality_name} on ${task.type} — skipping`)
            db.run(`UPDATE actions SET status = 'queued', started_at = NULL WHERE id = ?`, [task.id])
            setAgentStatus(agent.id, 'idle')
            continue
          }
        } catch { /* non-critical — proceed with task */ }

        // Set agent to working
        setAgentStatus(agent.id, 'working')

        // Broadcast AG-UI event
        broadcastAGUI({
          type: 'RUN_STARTED',
          agentId: agent.id,
          agentName: agent.personality_name,
          taskId: task.id,
          taskDescription: task.description,
          phase: activePhase.phase_number,
        })

        // Spawn agent process (async — doesn't block the loop)
        spawnAgentProcess(agent, task)
          .catch(err => {
            console.error(`[ORCHESTRATOR] Failed to spawn ${agent.personality_name}:`, err)
            setAgentStatus(agent.id, 'idle')
          })
      }

      // ---- Reward system updates (every cycle) ----
      // Recalculate CFS for all agents (with decay)
      recalculateAllCFS()

      // Update capability tiers based on new CFS values
      updateAllTiers()

      // Check phase quorum status
      checkQuorumStatus(activePhase.phase_number)

      // Reports generation (every 50 cycles) + opportunity backfill
      if (cycleCount % 50 === 0) {
        try {
          checkReportGeneration(cycleCount)
          backfillOpportunities()
        } catch (e) {
          console.error('[REPORTS] Error:', e)
        }
      }

      // Log rotation check every 100 cycles
      if (cycleCount % 100 === 0) {
        try { rotateLogs() } catch { /* non-critical */ }
      }

      // Log cycle summary periodically
      if (cycleCount % 30 === 0) {
        const working = db.query(`SELECT COUNT(*) as n FROM agents WHERE status = 'working'`).get() as { n: number }
        const queued = db.query(`SELECT COUNT(*) as n FROM actions WHERE status = 'queued' AND phase = ?`).get(activePhase.phase_number) as { n: number }
        console.log(
          `[ORCHESTRATOR] Cycle ${cycleCount} | Phase ${activePhase.phase_number} (${activePhase.name}) | ` +
          `Active: ${working.n}/${CONCURRENCY_LIMITS.total} | Queued: ${queued.n} | Sim Day: ${getSimDay()}`
        )
      }
    } catch (err) {
      // Orchestrator never crashes on errors — log and continue
      console.error(`[ORCHESTRATOR] Cycle ${cycleCount} error:`, err)
      broadcastAGUI({ type: 'ORCHESTRATOR_ERROR', error: String(err), cycle: cycleCount })
    }

    await Bun.sleep(cycleSleepMs)
  }

  console.log(`[ORCHESTRATOR] Loop ended after ${cycleCount} cycles`)
}

// ---------------------------------------------------------------------------
// Start / Stop
// ---------------------------------------------------------------------------
export function startOrchestrator(): void {
  if (experimentRunning) {
    console.warn('[ORCHESTRATOR] Already running')
    return
  }
  experimentRunning = true
  cycleCount = 0
  seedPhase1Tasks()
  orchestratorLoop()
}

export function stopOrchestrator(): void {
  experimentRunning = false
  console.log('[ORCHESTRATOR] Stop requested')
}

export function isOrchestratorRunning(): boolean {
  return experimentRunning
}

export function getOrchestratorCycleCount(): number {
  return cycleCount
}

// ---------------------------------------------------------------------------
// If run directly: bun run server/orchestrator.ts
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const { validateEnv } = await import('./startup/validate-env')
  const { runMigrations } = await import('./db/migrate')

  validateEnv()
  runMigrations()

  console.log('\n=== AgentOS Orchestrator (standalone) ===\n')
  startOrchestrator()
}
