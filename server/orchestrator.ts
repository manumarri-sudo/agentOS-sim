import { getDb } from './db/database'
import { spawnAgentProcess, getActiveProcessCount } from './agents/runner'
import { dequeueTask, seedPhase1Tasks } from './tasks/queue'
import { verify } from './reward/verifier'
import { checkBudgetExhausted, checkPhaseSpendCeiling } from './budget/enforcer'
import { sendMessage } from './messages/bus'
import { advanceSimDayIfNeeded, getSimDay, isRetroDay } from './clock'
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
import { generatePhaseTasks, generateDynamicTasks, isDiminishingReturns } from './intelligence/analyzer'
import { runCollaborationChecks } from './collaboration/engine'
import { checkSprintBoundary, getCurrentSprint } from './sprints/manager'
import { checkPerformanceActions } from './performance/tracker'
import { checkReportGeneration, backfillOpportunities } from './reports/generator'
import { checkDailySummary } from './reports/daily-summary'
import { detectAnomalies, applyAnomalyPenalty, detectCircularReasoningFast } from './governance/anomalies'
import { getActiveBlockers } from './reward/blockers'
import { generateDailyBrief } from './briefs/daily-brief'

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
let lastBriefSimDay = -1  // Track last sim_day we generated a brief for
let lastRetroSimDay = -1  // Track last sim_day we triggered a retro

// ---------------------------------------------------------------------------
// Concurrency check -- cached per cycle to avoid 36+ DB queries
// ---------------------------------------------------------------------------
let _slotCache: { teamCounts: Map<string, number>; total: number; throttledTotal: number; ts: number } | null = null

function refreshSlotCache(): void {
  const db = getDb()
  const teamCounts = new Map<string, number>()
  const rows = db.query(`
    SELECT team, COUNT(*) as n FROM agents WHERE status = 'working' GROUP BY team
  `).all() as { team: string; n: number }[]
  let total = 0
  for (const r of rows) {
    teamCounts.set(r.team, r.n)
    total += r.n
  }

  const budget = getCurrentWeekBudget()
  const throttleLevel = calculateThrottleLevel(budget)
  const throttledTotal = Math.min(
    CONCURRENCY_LIMITS.total ?? 6,
    getMaxConcurrentAgents(throttleLevel)
  )

  _slotCache = { teamCounts, total, throttledTotal, ts: Date.now() }
}

function getAvailableSlot(team: string): boolean {
  // Refresh cache once per cycle (stale after 5s)
  if (!_slotCache || Date.now() - _slotCache.ts > 5_000) {
    refreshSlotCache()
  }

  const teamActive = _slotCache!.teamCounts.get(team) ?? 0
  const teamLimit = CONCURRENCY_LIMITS[team] ?? 1

  // Exec team bypasses total limit -- always available for decisions
  if (team === 'exec') {
    return teamActive < teamLimit
  }

  return teamActive < teamLimit && _slotCache!.total < _slotCache!.throttledTotal
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

  // Single query replaces N+1 pattern (was 19 queries, now 1)
  const failingAgents = db.query(`
    SELECT a.id, a.personality_name
    FROM agents a
    WHERE a.status NOT IN ('suspended', 'blocked')
      AND (
        SELECT COUNT(*) FROM (
          SELECT status FROM actions
          WHERE agent_id = a.id AND completed_at IS NOT NULL
          ORDER BY completed_at DESC LIMIT ?
        ) sub WHERE sub.status IN ('failed', 'verification_failed', 'escalated')
      ) = ?
  `).all(MAX_CONSECUTIVE_FAILURES, MAX_CONSECUTIVE_FAILURES) as { id: string; personality_name: string }[]

  for (const agent of failingAgents) {
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
// Recover stuck agents and tasks -- handles all permanent-death states
// Called every 30 cycles (~5 min)
// ---------------------------------------------------------------------------
function recoverStuckAgentsAndTasks(phase: number): void {
  const db = getDb()

  // 1. Reset rate_limited agents on new sim day
  // rate_limited means daily token budget exhausted -- resets each sim day
  const rateLimited = db.query(`
    SELECT a.id, a.personality_name FROM agents a
    WHERE a.status = 'rate_limited'
  `).all() as { id: string; personality_name: string }[]

  for (const agent of rateLimited) {
    // Check if usage_windows shows today's window -- if not, it's a new day
    const todayWindow = db.query(`
      SELECT id FROM usage_windows
      WHERE agent_id = ? AND window_date = date('now')
    `).get(agent.id) as { id: string } | null

    if (!todayWindow) {
      setAgentStatus(agent.id, 'idle')
      console.log(`[RECOVERY] Reset rate_limited agent ${agent.personality_name} (new sim day)`)
    }
  }

  // 2. Unsuspend agents after 2 hours (give post-mortem time to complete)
  const suspended = db.query(`
    SELECT a.id, a.personality_name FROM agents a
    WHERE a.status = 'suspended'
  `).all() as { id: string; personality_name: string }[]

  for (const agent of suspended) {
    // Check if last failure was > 2 hours ago
    const lastFailure = db.query(`
      SELECT completed_at FROM actions
      WHERE agent_id = ? AND status IN ('failed', 'verification_failed', 'escalated')
      ORDER BY completed_at DESC LIMIT 1
    `).get(agent.id) as { completed_at: string } | null

    if (lastFailure) {
      const failedAt = new Date(lastFailure.completed_at + 'Z').getTime()
      const elapsed = Date.now() - failedAt
      if (elapsed > 2 * 60 * 60 * 1000) { // 2 hours
        setAgentStatus(agent.id, 'idle')
        console.log(`[RECOVERY] Unsuspended agent ${agent.personality_name} after 2-hour cooldown`)
      }
    }
  }

  // 3. Recover tasks stuck in 'running' for > 30 minutes (subprocess died silently)
  const stuckRunning = db.query(`
    SELECT id, agent_id, type, description FROM actions
    WHERE status = 'running'
      AND started_at < datetime('now', '-30 minutes')
  `).all() as { id: string; agent_id: string; type: string; description: string }[]

  for (const task of stuckRunning) {
    db.run(`UPDATE actions SET status = 'queued', started_at = NULL, retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ?`, [task.id])
    // Also reset agent status in case it's stuck on 'working'
    const agentStatus = db.query(`SELECT status FROM agents WHERE id = ?`).get(task.agent_id) as { status: string } | null
    if (agentStatus?.status === 'working') {
      setAgentStatus(task.agent_id, 'idle')
    }
    console.log(`[RECOVERY] Re-queued stuck running task ${task.id} for ${task.agent_id}: ${task.description.slice(0, 60)}`)
  }

  // 4. Re-queue deferred tasks older than 30 minutes (from diminishing returns check)
  const staleDeferred = db.query(`
    SELECT id, agent_id FROM actions
    WHERE status = 'deferred'
      AND started_at IS NULL
      AND created_at < datetime('now', '-30 minutes')
      AND description NOT LIKE '%[POST-MORTEM]%'
  `).all() as { id: string; agent_id: string }[]

  if (staleDeferred.length > 0) {
    for (const task of staleDeferred) {
      db.run(`UPDATE actions SET status = 'queued' WHERE id = ?`, [task.id])
    }
    console.log(`[RECOVERY] Re-queued ${staleDeferred.length} stale deferred tasks`)
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
      description: `The human operator sent you a message. Respond directly and concisely as Reza (CEO).\n\nConversation history:\n${chatHistory}\n\nExperiment status: Phase ${phase}, ${completedCount} tasks completed, ${queuedCount} queued.\n\nRespond naturally. If they're asking about status, give a brief update. If they're giving direction, acknowledge and say what you'll do. 2-4 sentences max.\n\nCRITICAL: If the human is giving a directive meant for another agent (e.g. "tell Dani to..." or "have Kai build..."), you MUST relay it using the appropriate signal tags:\n- Use [MSG to:<agent_id> priority:urgent] to send the directive to the target agent\n- Use [NEXT_TASK for:<agent_id> type:<type>] to create an actionable task for them\nDo NOT just acknowledge -- actually route the directive. The human is counting on you to forward it.`,
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
// RFC Ratification -- when Reza approves an RFC, spawn build tasks
// ---------------------------------------------------------------------------
function checkRFCRatifications(phase: number): void {
  const db = getDb()

  // Find approved RFC decisions that haven't been actioned yet
  // Convention: title starts with "[RFC]" for proposed, "APPROVE RFC" for ratified
  const approvedRFCs = db.query(`
    SELECT d.id, d.title, d.body, d.made_by_agent
    FROM decisions d
    WHERE d.title LIKE 'APPROVE RFC%' AND d.status = 'approved'
      AND d.id NOT IN (
        SELECT DISTINCT substr(a.input, 1, 36) FROM actions a
        WHERE a.type = 'build_internal' AND a.input IS NOT NULL
      )
    ORDER BY d.created_at DESC
    LIMIT 5
  `).all() as Array<{ id: string; title: string; body: string; made_by_agent: string }>

  for (const rfc of approvedRFCs) {
    // Extract the initiative name from the approval title
    const nameMatch = rfc.title.match(/APPROVE RFC\s+(.+)/i)
    const initiativeName = nameMatch?.[1]?.trim() ?? 'Unknown Initiative'

    // Find the original proposed RFC to get scope details
    const original = db.query(`
      SELECT body FROM decisions
      WHERE title LIKE ? AND status = 'proposed'
      ORDER BY created_at DESC LIMIT 1
    `).get(`%${initiativeName}%`) as { body: string } | null

    const scopeDetails = original?.body ?? rfc.body

    // Parse owner from the RFC body
    const ownerMatch = scopeDetails.match(/Owner:\s*(\w+)/i)
    const buildOwner = ownerMatch?.[1] ?? 'kai'  // Default to Kai (full-stack)

    // Spawn priority build task -- bypasses phase gating by going to top of queue
    const buildTaskId = enqueueTask({
      agentId: buildOwner,
      type: 'build_internal',
      description: `[INTERNAL INITIATIVE -- APPROVED BY EXEC]\n\n**Initiative:** ${initiativeName}\n**Approved by:** ${rfc.made_by_agent}\n**Budget:** Up to $15 from contingency, 10,000 tokens\n\nScope from RFC:\n${scopeDetails.slice(0, 1500)}\n\nBuild this internal tool/dashboard/system. This is a priority task that takes precedence over current phase work. Keep it lean -- ship a working v1, not a perfect system.\n\nWhen complete, announce it to the team with [MSG to:all priority:high] and include usage instructions.`,
      phase,
      priority: true,
      input: rfc.id,  // Track which RFC this build is for (dedup key)
    })

    // Update the original proposed RFC status
    db.run(`
      UPDATE decisions SET status = 'ratified'
      WHERE title LIKE ? AND status = 'proposed'
    `, [`%${initiativeName}%`])

    // Notify the team
    sendMessage({
      fromAgentId: 'reza',
      toAgentId: buildOwner,
      subject: `APPROVED: Build ${initiativeName}`,
      body: `Your internal initiative "${initiativeName}" has been approved by the exec team. You have a $15 budget and 10,000 token allocation. This is top priority -- pause current work and build it.`,
      priority: 'urgent',
    })

    // Post to CEO chat
    try {
      db.run(`
        INSERT INTO ceo_chat (id, sender, message, message_type, phase, sim_day, read_by_human)
        VALUES (?, 'reza', ?, 'alert', ?, ?, 0)
      `, [crypto.randomUUID(), `[RFC APPROVED] ${initiativeName} -- build task assigned to ${buildOwner}`, phase, getSimDay()])
    } catch { /* ceo_chat may not exist */ }

    logActivity({
      agentId: 'reza',
      phase,
      eventType: 'rfc_ratified',
      summary: `RFC "${initiativeName}" ratified. Build task assigned to ${buildOwner}.`,
    })

    broadcastAGUI({
      type: 'RFC_RATIFIED',
      initiative: initiativeName,
      approvedBy: rfc.made_by_agent,
      buildOwner,
      taskId: buildTaskId,
    })

    console.log(`[RFC] "${initiativeName}" ratified by ${rfc.made_by_agent}. Build task assigned to ${buildOwner}.`)
  }
}

// ---------------------------------------------------------------------------
// Artifact Curation -- periodic cleanup/formatting of team outputs
//
// Sol (Marketing Lead) or Theo (Copywriter) gets a task to review and
// improve the structure, formatting, branding, and cross-linking of
// team artifacts (Notion docs, reports, deliverables).
// ---------------------------------------------------------------------------
function checkArtifactCuration(phase: number): void {
  const db = getDb()
  const simDay = getSimDay()

  // Dedup: max one curation task per sprint
  const sprint = getCurrentSprint()
  if (!sprint) return

  const existing = db.query(`
    SELECT 1 FROM actions WHERE type = 'write' AND sprint_id = ?
      AND description LIKE '%ARTIFACT CURATION%'
  `).get(sprint.id)
  if (existing) return

  // Gather recent team outputs that could use polish
  const recentOutputs = db.query(`
    SELECT ag.personality_name, ag.team, a.type, substr(a.description, 1, 120) as desc,
           substr(a.output, 1, 200) as preview
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.status = 'completed' AND a.phase = ?
      AND a.type IN ('write', 'research', 'decide', 'build')
    ORDER BY a.completed_at DESC LIMIT 10
  `).all(phase) as any[]

  if (recentOutputs.length < 3) return // not enough artifacts to curate

  const outputList = recentOutputs.map((o: any) =>
    `- **${o.personality_name}** (${o.team}/${o.type}): ${o.desc}`
  ).join('\n')

  // Alternate between Sol and Theo for variety
  const curator = simDay % 2 === 0 ? 'sol' : 'theo'
  const curatorName = curator === 'sol' ? 'Sol' : 'Theo'

  enqueueTask({
    agentId: curator,
    type: 'write',
    description: `[ARTIFACT CURATION -- Sprint ${sprint.number}]\n\nAs ${curatorName}, review the team's recent deliverables and improve their quality. Your job is to be the team's "design ops" -- making outputs more organized, linked, and branded.\n\nRecent team outputs:\n${outputList}\n\nDo the following:\n1. **Structure**: Identify outputs that lack clear headers, sections, or summaries. Draft improved versions or templates.\n2. **Cross-linking**: Find outputs that reference each other but aren't linked. Use [MSG] to tell authors to add references.\n3. **Branding nudge**: If the team hasn't established visual identity/brand guidelines yet, draft a proposal. Use [MSG to:vera priority:high] and [MSG to:theo priority:high] to coordinate.\n4. **Formatting standards**: Propose a team-wide formatting standard for deliverables (consistent headers, decision format, status format).\n5. **Notion/Doc cleanup**: If any Notion pages or shared docs exist, suggest structural improvements.\n\nOutput a brief "Curation Report" with what you improved and what still needs attention. Use [PROCESS_PROPOSAL] if you want to formalize any standards.`,
    phase,
  })

  logActivity({
    agentId: curator,
    phase,
    eventType: 'curation_scheduled',
    summary: `${curatorName} assigned artifact curation for Sprint ${sprint.number}`,
  })

  console.log(`[CURATOR] ${curatorName} assigned artifact curation for Sprint ${sprint.number}`)
}

// ---------------------------------------------------------------------------
// Friday Retro -- every 7 sim days, pause standard work and force ideation
// ---------------------------------------------------------------------------
function checkRetro(simDay: number, phase: number): void {
  if (!isRetroDay(simDay) || simDay <= lastRetroSimDay) return

  const db = getDb()

  // Check if retro tasks already exist for this sim day
  const existing = db.query(`
    SELECT 1 FROM actions WHERE type = 'retro' AND description LIKE ?
  `).get(`%Sim Day ${simDay}%`)
  if (existing) {
    lastRetroSimDay = simDay
    return
  }

  // Gather context for the retro: blockers, token burn, failures from last 7 days
  const recentFailures = db.query(`
    SELECT ag.personality_name, a.description, a.status
    FROM actions a JOIN agents ag ON ag.id = a.agent_id
    WHERE a.status IN ('failed', 'escalated', 'blocked')
      AND a.completed_at >= datetime('now', '-7 days')
    LIMIT 10
  `).all() as Array<{ personality_name: string; description: string; status: string }>

  const recentBlockers = db.query(`
    SELECT ag.personality_name, b.reason
    FROM blocked_agents b JOIN agents ag ON ag.id = b.agent_id
    WHERE b.created_at >= datetime('now', '-7 days')
    LIMIT 10
  `).all() as Array<{ personality_name: string; reason: string }>

  const tokenBurn = db.query(`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens
    FROM token_usage
    WHERE created_at >= datetime('now', '-7 days')
  `).get() as { total_tokens: number }

  const recentSpend = db.query(`
    SELECT COALESCE(SUM(ABS(amount)), 0) as spent
    FROM budget_entries
    WHERE amount < 0 AND created_at >= datetime('now', '-7 days')
  `).get() as { spent: number }

  // Build context string
  let retroContext = `## Retro Context (Last 7 Sim Days)\n\n`
  retroContext += `**Token burn:** ${tokenBurn.total_tokens.toLocaleString()} tokens\n`
  retroContext += `**Budget spent:** $${recentSpend.spent.toFixed(2)}\n\n`

  if (recentFailures.length > 0) {
    retroContext += `**Failures/Escalations:**\n`
    for (const f of recentFailures.slice(0, 5)) {
      retroContext += `- ${f.personality_name} (${f.status}): ${f.description.slice(0, 80)}\n`
    }
    retroContext += '\n'
  }

  if (recentBlockers.length > 0) {
    retroContext += `**Blockers reported:**\n`
    for (const b of recentBlockers.slice(0, 5)) {
      retroContext += `- ${b.personality_name}: ${b.reason.slice(0, 80)}\n`
    }
    retroContext += '\n'
  }

  const retroPrompt = `[SYSTEM RETROSPECTIVE -- Sim Day ${simDay}]\n\n${retroContext}\nLook at the activity feed, blockages, and token burn from the last 7 days. Identify the team's biggest operational weakness. You MUST propose exactly ONE new internal tool, dashboard, or tracking initiative to fix it.\n\nDraft an RFC (Request for Comment) memo with:\n1. **Problem Statement**: What is breaking, slow, or wasteful?\n2. **Proposed Solution**: Name the tool/dashboard/standard. Be specific.\n3. **Expected Impact**: How many tokens/dollars will this save? How much faster will the team move?\n4. **Build Scope**: What exactly needs to be built? Who should build it?\n5. **Cost Estimate**: How many tokens and dollars to build?\n\nOutput your RFC using:\n[PROPOSE_INITIATIVE name:<your initiative name>]\n[RATIONALE] <why>\n[OWNER] <agent_id>\n[SCOPE] <what to build>`

  // Issue retro tasks to Jordan (Ops) and Zara (Strategy)
  enqueueTask({
    agentId: 'jordan',
    type: 'retro',
    description: retroPrompt,
    phase,
  })

  enqueueTask({
    agentId: 'zara',
    type: 'retro',
    description: retroPrompt,
    phase,
  })

  // Notify team that retro is happening
  sendMessage({
    fromAgentId: 'system',
    toAgentId: 'reza',
    subject: `[RETRO] System Retrospective triggered -- Sim Day ${simDay}`,
    body: `The 7-day retrospective has been triggered. Jordan and Zara are reviewing operational performance and drafting RFC proposals.`,
    priority: 'high',
  })

  logActivity({
    agentId: 'system',
    phase,
    eventType: 'retro_triggered',
    summary: `System Retrospective triggered at Sim Day ${simDay}. Jordan + Zara assigned.`,
  })

  broadcastAGUI({
    type: 'RETRO_TRIGGERED',
    simDay,
    phase,
    assignees: ['jordan', 'zara'],
  })

  lastRetroSimDay = simDay
  console.log(`[RETRO] System Retrospective triggered at Sim Day ${simDay}`)
}

// ---------------------------------------------------------------------------
// Auto-resolve a blocker without CFS rewards (system action, not agent action)
// ---------------------------------------------------------------------------
function resolveBlockerAuto(blockerId: string, agentId: string, reason: string): void {
  const db = getDb()
  db.run(`
    UPDATE blocked_agents SET resolved_by = 'system', resolved_at = datetime('now')
    WHERE id = ? AND resolved_by IS NULL
  `, [blockerId])
  db.run(`UPDATE agents SET status = 'idle' WHERE id = ? AND status = 'blocked'`, [agentId])
  console.log(`[BLOCKER] Auto-resolved: ${reason}`)
}

// ---------------------------------------------------------------------------
// Phase Advancement — auto-advance when phase work is substantially done
//
// Conditions to advance from phase N to N+1:
// 1. At least 80% of actionable tasks are completed
// 2. No agents are currently working on phase tasks
// 3. At most 1 queued task remains
// 4. At least 5 completed tasks (prevent trivial advancement)
// 5. CEO (Reza) has at least 1 completed task in this phase (review/decision)
// ---------------------------------------------------------------------------
function checkPhaseAdvancement(currentPhase: number): void {
  const db = getDb()

  // Don't advance beyond phase 5
  if (currentPhase >= 5) return

  const stats = db.query(`
    SELECT status, COUNT(*) as n FROM actions WHERE phase = ? GROUP BY status
  `).all(currentPhase) as { status: string; n: number }[]

  const counts: Record<string, number> = {}
  let total = 0
  for (const s of stats) {
    counts[s.status] = s.n
    total += s.n
  }

  const completed = counts['completed'] ?? 0
  const queued = counts['queued'] ?? 0
  const running = counts['running'] ?? 0

  // Need at least some tasks to evaluate
  if (total < 3) return

  // Completion ratio: completed vs actionable (completed + queued + running)
  // Failed/cancelled/verification_failed are terminal — don't block advancement
  const actionable = completed + queued + running
  const completionRatio = actionable > 0 ? completed / actionable : 0

  // Must have >80% of actionable tasks completed and at most 1 queued + 0 running
  if (completionRatio < 0.80 || queued > 1 || running > 0) return

  // Minimum completed tasks to advance (prevents advancing with trivial work)
  if (completed < 5) return

  // CEO must have done at least one task this phase
  const ceoWork = db.query(`
    SELECT 1 FROM actions WHERE agent_id = 'reza' AND phase = ? AND status = 'completed' LIMIT 1
  `).get(currentPhase)
  if (!ceoWork) return

  // Check next phase exists and is pending
  const nextPhase = db.query(`
    SELECT phase_number, name FROM experiment_phases WHERE phase_number = ? AND status = 'pending'
  `).get(currentPhase + 1) as { phase_number: number; name: string } | null
  if (!nextPhase) return

  // Advance!
  db.run(`UPDATE experiment_phases SET status = 'complete', completed_at = datetime('now') WHERE phase_number = ?`, [currentPhase])
  db.run(`UPDATE experiment_phases SET status = 'active', started_at = datetime('now') WHERE phase_number = ?`, [currentPhase + 1])

  // Cancel remaining queued tasks from old phase (they're leftover)
  db.run(`UPDATE actions SET status = 'cancelled', completed_at = datetime('now') WHERE phase = ? AND status = 'queued'`, [currentPhase])

  // Auto-generate tasks for the new phase
  try {
    const newTasks = generatePhaseTasks(currentPhase + 1)
    for (const t of newTasks) {
      enqueueTask(t)
    }
    console.log(`[PHASE] Generated ${newTasks.length} tasks for Phase ${currentPhase + 1}`)
  } catch (e) {
    console.error('[PHASE] Task generation for new phase failed:', e)
  }

  // Notify team
  sendMessage({
    fromAgentId: 'system',
    toAgentId: 'reza',
    subject: `Phase ${currentPhase + 1} (${nextPhase.name}) is now active`,
    body: `Phase ${currentPhase} completed with ${completed}/${actionable} tasks done (${Math.round(completionRatio * 100)}%). Phase ${currentPhase + 1} has begun.`,
    priority: 'urgent',
  })

  broadcastAGUI({
    type: 'PHASE_ADVANCED',
    fromPhase: currentPhase,
    toPhase: currentPhase + 1,
    phaseName: nextPhase.name,
    completionRatio: Math.round(completionRatio * 100),
  })

  logActivity({
    agentId: 'system',
    phase: currentPhase + 1,
    eventType: 'phase_advanced',
    summary: `Phase ${currentPhase} → ${currentPhase + 1} (${nextPhase.name}). ${completed}/${actionable} tasks completed.`,
  })

  console.log(`[PHASE] ★ Advanced to Phase ${currentPhase + 1} (${nextPhase.name}) — ${completed}/${actionable} tasks completed in Phase ${currentPhase}`)
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

      // Generate daily brief + end-of-day summary on sim_day transition
      const currentSimDay = getSimDay()
      if (currentSimDay > lastBriefSimDay) {
        try {
          generateDailyBrief(currentSimDay, activePhase.phase_number)
          lastBriefSimDay = currentSimDay
        } catch (e) {
          console.error('[BRIEF] Error generating daily brief:', e)
        }
        // End-of-day agent summaries (CSV + Notion)
        try {
          checkDailySummary()
        } catch (e) {
          console.error('[SUMMARY] Error generating daily summary:', e)
        }
      }

      // Friday Retro -- check if we need to trigger a retrospective
      checkRetro(currentSimDay, activePhase.phase_number)

      // Check consecutive failures → suspend agents
      checkConsecutiveFailures()

      // Check token limits
      checkTokenLimits()

      // -----------------------------------------------------------------------
      // PERIODIC CHECKS -- grouped by frequency tier
      // -----------------------------------------------------------------------

      // EVERY 10 CYCLES (~1.5 min): fast health checks
      if (cycleCount % 10 === 0) {
        recalculateAllCFS()
        updateAllTiers()
        checkCEOChatPending(activePhase.phase_number)
        try { checkRFCRatifications(activePhase.phase_number) } catch (e) { console.error('[RFC] Error:', e) }
        try {
          const circularAnomalies = detectCircularReasoningFast(activePhase.phase_number)
          for (const anomaly of circularAnomalies) {
            applyAnomalyPenalty(anomaly)
            db.run(`
              UPDATE actions SET status = 'cancelled', completed_at = datetime('now')
              WHERE agent_id = ? AND status = 'queued' AND type NOT IN ('help', 'spike')
            `, [anomaly.agentId])
            console.log(`[CIRCULAR] Cancelled queued tasks for ${anomaly.agentId} -- breaking feedback loop`)
          }
        } catch (e) { console.error('[ORCHESTRATOR] Circular reasoning error:', e) }
      }

      // EVERY 20 CYCLES (~3 min): sprint + meetings
      if (cycleCount % 20 === 0) {
        try { checkSprintBoundary(cycleCount, activePhase.phase_number) } catch (e) { console.error('[SPRINT] Error:', e) }
        checkTeamMeetings(activePhase.phase_number)
      }

      // EVERY 30 CYCLES (~5 min): recovery, task generation, verification, anomalies, phase advancement
      if (cycleCount % 30 === 0) {
        // Recovery: unstick rate_limited, suspended, running, deferred agents/tasks
        try { recoverStuckAgentsAndTasks(activePhase.phase_number) } catch (e) { console.error('[RECOVERY] Error:', e) }

        // Orphan sweep: re-verify stuck proposed_complete tasks
        try {
          const orphaned = db.query(`
            SELECT id, agent_id, type, output, expected_output_path, expected_schema
            FROM actions WHERE status = 'proposed_complete'
          `).all() as any[]
          if (orphaned.length > 0) {
            console.log(`[ORCHESTRATOR] Re-verifying ${orphaned.length} orphaned proposed_complete tasks`)
            for (const a of orphaned) {
              verify({ id: a.id, agent_id: a.agent_id, type: a.type, output: a.output ?? '', expected_output_path: a.expected_output_path, expected_schema: a.expected_schema })
            }
          }
        } catch (e) { console.error('[ORCHESTRATOR] Orphan sweep error:', e) }

        // Smart task generation
        try {
          const totalTasks = db.query(`SELECT COUNT(*) as n FROM actions WHERE phase = ?`).get(activePhase.phase_number) as { n: number }
          const queuedOrRunning = db.query(`SELECT COUNT(*) as n FROM actions WHERE phase = ? AND status IN ('queued', 'running')`).get(activePhase.phase_number) as { n: number }

          if (totalTasks.n === 0 && activePhase.phase_number >= 2) {
            const newTasks = generatePhaseTasks(activePhase.phase_number)
            for (const t of newTasks) { enqueueTask(t) }
            if (newTasks.length > 0) console.log(`[INTELLIGENCE] Seeded ${newTasks.length} starter tasks for Phase ${activePhase.phase_number}`)
          } else if (queuedOrRunning.n === 0 && activePhase.phase_number >= 2) {
            const dynamicTasks = generateDynamicTasks(activePhase.phase_number)
            for (const t of dynamicTasks) { enqueueTask(t) }
            if (dynamicTasks.length > 0) console.log(`[INTELLIGENCE] Generated ${dynamicTasks.length} dynamic tasks from completed work`)
          }
        } catch (e) { console.error('[INTELLIGENCE] Task generation error:', e) }

        // Full anomaly detection
        try {
          const anomalies = detectAnomalies()
          for (const anomaly of anomalies) { applyAnomalyPenalty(anomaly) }
          if (anomalies.length > 0) console.log(`[ORCHESTRATOR] Anomaly detection: ${anomalies.length} anomalies found`)
        } catch (e) { console.error('[ORCHESTRATOR] Anomaly detection error:', e) }

        // Phase advancement
        try { checkPhaseAdvancement(activePhase.phase_number) } catch (e) { console.error('[PHASE] Error:', e) }

        // Cycle summary
        const working = db.query(`SELECT COUNT(*) as n FROM agents WHERE status = 'working'`).get() as { n: number }
        const queued = db.query(`SELECT COUNT(*) as n FROM actions WHERE status = 'queued' AND phase = ?`).get(activePhase.phase_number) as { n: number }
        console.log(`[ORCHESTRATOR] Cycle ${cycleCount} | Phase ${activePhase.phase_number} (${activePhase.name}) | Active: ${working.n}/${CONCURRENCY_LIMITS.total} | Queued: ${queued.n} | Sim Day: ${getSimDay()}`)
      }

      // EVERY 50 CYCLES (~8 min): reports
      if (cycleCount % 50 === 0) {
        try { checkReportGeneration(cycleCount); backfillOpportunities() } catch (e) { console.error('[REPORTS] Error:', e) }
      }

      // EVERY 60 CYCLES (~10 min): collaboration + deadlock
      if (cycleCount % 60 === 0) {
        checkDeadlock()
        try { runCollaborationChecks(activePhase.phase_number) } catch (e) { console.error('[COLLAB] Error:', e) }
      }

      // EVERY 100 CYCLES (~17 min): performance + log rotation
      if (cycleCount % 100 === 0) {
        try {
          const sprint = getCurrentSprint()
          if (sprint) checkPerformanceActions(activePhase.phase_number)
        } catch (e) { console.error('[PERFORMANCE] Error:', e) }
        try { rotateLogs() } catch { /* non-critical */ }
      }

      // EVERY 200 CYCLES (~33 min): artifact curation
      if (cycleCount % 200 === 0 && activePhase.phase_number >= 2) {
        try { checkArtifactCuration(activePhase.phase_number) } catch (e) { console.error('[CURATOR] Error:', e) }
      }

      // -----------------------------------------------------------------------
      // EVERY CYCLE: blocker cleanup + agent dispatch
      // -----------------------------------------------------------------------

      // Auto-resolve stale/phantom blockers
      try {
        const activeBlockers = getActiveBlockers()
        for (const blocker of activeBlockers) {
          if (blocker.durationMinutes > 120) {
            resolveBlockerAuto(blocker.id, blocker.agentId, 'Auto-resolved: stale blocker (>2 hours)')
            console.log(`[ORCHESTRATOR] Auto-resolved stale blocker for ${blocker.agentName} (${blocker.durationMinutes}min old)`)
            continue
          }
          const hasCompletions = db.query(`SELECT 1 FROM actions WHERE agent_id = ? AND phase = ? AND status = 'completed' LIMIT 1`).get(blocker.agentId, activePhase.phase_number)
          if (hasCompletions) {
            resolveBlockerAuto(blocker.id, blocker.agentId, 'Auto-resolved: agent has completed work this phase')
            console.log(`[ORCHESTRATOR] Auto-resolved phantom blocker for ${blocker.agentName}`)
            continue
          }
        }
      } catch (e) { console.error('[ORCHESTRATOR] Blocker cleanup error:', e) }

      // Dispatch tasks to ready agents
      const readyAgents = getReadyAgents()
      for (const agent of readyAgents) {
        if (!getAvailableSlot(agent.team)) continue
        const task = dequeueTask(agent.id, activePhase.phase_number)
        if (!task) continue

        // Diminishing returns check
        try {
          if (isDiminishingReturns(agent.id, task.type, activePhase.phase_number)) {
            console.log(`[INTELLIGENCE] Diminishing returns for ${agent.personality_name} on ${task.type} -- deferring`)
            db.run(`UPDATE actions SET status = 'deferred', started_at = NULL WHERE id = ?`, [task.id])
            setAgentStatus(agent.id, 'idle')
            continue
          }
        } catch { /* non-critical -- proceed with task */ }

        setAgentStatus(agent.id, 'working')
        broadcastAGUI({ type: 'RUN_STARTED', agentId: agent.id, agentName: agent.personality_name, taskId: task.id, taskDescription: task.description, phase: activePhase.phase_number })
        spawnAgentProcess(agent, task).catch(err => { console.error(`[ORCHESTRATOR] Failed to spawn ${agent.personality_name}:`, err); setAgentStatus(agent.id, 'idle') })
      }

      // Phase quorum check (every cycle -- lightweight query)
      checkQuorumStatus(activePhase.phase_number)

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
