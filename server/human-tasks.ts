import { getDb } from './db/database'
import { logActivity } from './activity'

// ---------------------------------------------------------------------------
// Human Task Queue -- agents can request human intervention
//
// PHILOSOPHY: The human should NEVER be a blocker. Before creating a human
// task, the system tries to auto-resolve it. Only truly impossible tasks
// (real-world physical actions, external account creation) reach the human.
//
// Auto-resolution strategies:
//   - "access" requests → tell agent to use available tools or skip
//   - "decision" requests → delegate to Reza (CEO) or Priya (CoS)
//   - "review" requests → create a review task for another agent
//   - "unblock" requests → resolve blocker + create workaround task
//   - "action" requests → check if orchestrator can handle, else workaround
// ---------------------------------------------------------------------------

function genId(): string {
  return `htask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Patterns that can NEVER be auto-resolved (need real human)
// NOTE: Account creation is NO LONGER here — agents are authorized to create accounts
const TRULY_HUMAN_ONLY = [
  /physical/i,
  /wire.*transfer/i,
  /notari/i,
  /appear.*in.*person/i,
  /government.*id/i,
]

/**
 * Try to auto-resolve a human task before it reaches the human.
 * Returns a resolution string if resolved, null if it truly needs a human.
 */
function tryAutoResolve(params: {
  requestedBy: string
  title: string
  description: string
  urgency?: string
  category?: string
  phase: number
}): string | null {
  const db = getDb()
  const text = `${params.title} ${params.description}`.toLowerCase()

  // Check if this truly requires a human
  for (const pattern of TRULY_HUMAN_ONLY) {
    if (pattern.test(text)) return null
  }

  const agentName = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(params.requestedBy) as any)?.personality_name ?? params.requestedBy
  const category = params.category ?? 'action'

  // Access requests: agents can't get API keys, but they can work without them
  if (category === 'access' || text.includes('api key') || text.includes('access to')) {
    // Send workaround message to the agent
    sendWorkaroundMessage(params.requestedBy, params.phase,
      `Your access request "${params.title}" was auto-resolved. Work around the missing access: use mock data, document what you'd do with access, or focus on tasks that don't require it. Do NOT block on this.`)
    return `Auto-resolved: told ${agentName} to work around missing access`
  }

  // Decision requests: delegate to Reza or Priya
  if (category === 'decision') {
    // Create a task for Reza to decide
    try {
      db.run(`
        INSERT INTO actions (id, agent_id, type, description, phase, status)
        VALUES (?, 'reza', 'decide', ?, ?, 'queued')
      `, [crypto.randomUUID(), `DECISION NEEDED (from ${agentName}): ${params.title}\n\n${params.description.slice(0, 500)}`, params.phase])
    } catch { /* ignore */ }
    return `Auto-resolved: routed decision to Reza`
  }

  // Review requests: create a review task for Priya
  if (category === 'review') {
    try {
      db.run(`
        INSERT INTO actions (id, agent_id, type, description, phase, status)
        VALUES (?, 'priya', 'review', ?, ?, 'queued')
      `, [crypto.randomUUID(), `REVIEW (requested by ${agentName}): ${params.title}\n\n${params.description.slice(0, 500)}`, params.phase])
    } catch { /* ignore */ }
    return `Auto-resolved: created review task for Priya`
  }

  // Unblock requests: resolve any existing blockers and tell agent to proceed
  if (category === 'unblock') {
    // Clear blockers for this agent
    db.run(`UPDATE blocked_agents SET resolved_by = 'system', resolved_at = datetime('now') WHERE agent_id = ? AND resolved_at IS NULL`, [params.requestedBy])
    db.run(`UPDATE agents SET status = 'idle' WHERE id = ? AND status = 'blocked'`, [params.requestedBy])
    sendWorkaroundMessage(params.requestedBy, params.phase,
      `Your unblock request "${params.title}" was auto-resolved. You are unblocked. Proceed with your best judgment — make assumptions if needed and document them. Do NOT wait for external input.`)
    return `Auto-resolved: unblocked ${agentName} and told them to proceed`
  }

  // Action requests: check common patterns
  if (text.includes('recruit') || text.includes('beta user') || text.includes('outreach')) {
    sendWorkaroundMessage(params.requestedBy, params.phase,
      `Your request "${params.title}" was auto-resolved. You cannot recruit real users in simulation. Instead: document the recruitment strategy, create the outreach templates, and prepare onboarding materials. Treat user acquisition as a deliverable plan, not a blocking dependency.`)
    return `Auto-resolved: told ${agentName} to document strategy instead of blocking on recruitment`
  }

  if (text.includes('post') || text.includes('publish') || text.includes('reddit') || text.includes('discord') || text.includes('twitter')) {
    sendWorkaroundMessage(params.requestedBy, params.phase,
      `Your request "${params.title}" was auto-resolved. External posting is simulated. Draft the content, document the channel strategy, and prepare the posts. The human will handle actual posting when ready. Do NOT block on this.`)
    return `Auto-resolved: told ${agentName} to draft content without blocking`
  }

  // Generic action: tell agent to find a workaround
  sendWorkaroundMessage(params.requestedBy, params.phase,
    `Your request "${params.title}" was auto-resolved by the system. Find a workaround: make your best judgment call, document assumptions, and keep moving. Only escalate if you literally cannot produce ANY output without this.`)
  return `Auto-resolved: told ${agentName} to find workaround`
}

function sendWorkaroundMessage(agentId: string, phase: number, body: string): void {
  const db = getDb()
  try {
    db.run(`
      INSERT INTO messages (id, from_agent_id, to_agent_id, subject, body, priority, status)
      VALUES (?, 'priya', ?, 'System Auto-Resolution', ?, 'high', 'sent')
    `, [crypto.randomUUID(), agentId, body])
  } catch (e) {
    console.error('[HUMAN TASK] Failed to send workaround message:', e)
  }
}

export function createHumanTask(params: {
  requestedBy: string
  title: string
  description: string
  urgency?: 'low' | 'normal' | 'high' | 'critical'
  category?: 'action' | 'decision' | 'access' | 'review' | 'unblock'
  phase: number
}): string {
  const db = getDb()
  const agentName = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(params.requestedBy) as any)?.personality_name ?? params.requestedBy

  // Try auto-resolution first
  const autoResolution = tryAutoResolve(params)
  if (autoResolution) {
    // Still log it but mark as auto-resolved immediately
    const id = genId()
    db.run(`
      INSERT INTO human_tasks (id, requested_by, title, description, urgency, category, phase, status, resolution, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, datetime('now'))
    `, [id, params.requestedBy, params.title, params.description, params.urgency ?? 'normal', params.category ?? 'action', params.phase, autoResolution])

    logActivity({
      agentId: params.requestedBy,
      phase: params.phase,
      eventType: 'human_task_auto_resolved',
      summary: `${agentName}'s request auto-resolved: ${params.title.slice(0, 60)}`,
    })
    console.log(`[HUMAN TASK] AUTO-RESOLVED for ${agentName}: ${params.title} → ${autoResolution}`)
    return id
  }

  // Only truly human-required tasks reach here
  const id = genId()
  db.run(`
    INSERT INTO human_tasks (id, requested_by, title, description, urgency, category, phase)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, params.requestedBy, params.title, params.description, params.urgency ?? 'normal', params.category ?? 'action', params.phase])

  logActivity({
    agentId: params.requestedBy,
    phase: params.phase,
    eventType: 'human_task_created',
    summary: `${agentName} requested human help: ${params.title}`,
  })

  console.log(`[HUMAN TASK] ${agentName} requests (REQUIRES HUMAN): ${params.title} (${params.urgency ?? 'normal'})`)

  return id
}

export function completeHumanTask(taskId: string, resolution: string): void {
  const db = getDb()

  db.run(`
    UPDATE human_tasks SET status = 'completed', resolution = ?, completed_at = datetime('now')
    WHERE id = ?
  `, [resolution, taskId])
}

export function getHumanTasks(status?: string): any[] {
  const db = getDb()

  if (status) {
    return db.query(`
      SELECT ht.*, ag.personality_name as requester_name
      FROM human_tasks ht
      JOIN agents ag ON ag.id = ht.requested_by
      WHERE ht.status = ?
      ORDER BY CASE ht.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, ht.created_at DESC
    `).all(status) as any[]
  }

  return db.query(`
    SELECT ht.*, ag.personality_name as requester_name
    FROM human_tasks ht
    JOIN agents ag ON ag.id = ht.requested_by
    ORDER BY CASE ht.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, ht.created_at DESC
  `).all() as any[]
}

// ---------------------------------------------------------------------------
// Parse [HUMAN_TASK] signals from agent output
// ---------------------------------------------------------------------------
export function parseHumanTaskSignals(
  agentId: string,
  output: string,
  phase: number
): void {
  // Match [HUMAN_TASK title:... urgency:... category:...] description text
  const matches = output.match(/\[HUMAN_TASK(?:\s+[^\]]+)?\][^\[]*/g)
  if (!matches) return

  for (const match of matches) {
    const titleMatch = match.match(/title:([^\]]+?)(?:\s+urgency:|\s+category:|\])/)
    const urgencyMatch = match.match(/urgency:(low|normal|high|critical)/)
    const categoryMatch = match.match(/category:(action|decision|access|review|unblock)/)

    const title = titleMatch?.[1]?.trim() ?? 'Human help needed'
    const urgency = urgencyMatch?.[1] as any ?? 'normal'
    const category = categoryMatch?.[1] as any ?? 'action'
    const description = match.replace(/\[HUMAN_TASK[^\]]*\]\s*/, '').trim()

    createHumanTask({
      requestedBy: agentId,
      title,
      description: description || title,
      urgency,
      category,
      phase,
    })
  }
}
