import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db/database'

// ---------------------------------------------------------------------------
// Reflexion Memory — "Never Again" Protocol
//
// Stores generalized rules agents learn from catastrophic failures.
// These rules are injected into every future system prompt so the agent
// never repeats the same mistake.
// ---------------------------------------------------------------------------

// Ensure the agent_memories table exists (idempotent)
try {
  const db = getDb()
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      triggering_error TEXT NOT NULL,
      generalized_rule TEXT NOT NULL,
      source_task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_agent_memories_agent ON agent_memories(agent_id)`)
} catch {
  // Table may already exist
}

/**
 * Save a learned rule from a post-mortem into the agent's permanent memory.
 */
export function saveLearnedRule(params: {
  agentId: string
  triggeringError: string
  generalizedRule: string
  sourceTaskId?: string
}): string {
  const db = getDb()
  const id = crypto.randomUUID()

  // Dedupe: don't store near-duplicate rules (Jaccard on words)
  const existing = db.query(`
    SELECT generalized_rule FROM agent_memories WHERE agent_id = ?
  `).all(params.agentId) as { generalized_rule: string }[]

  const newWords = new Set(params.generalizedRule.toLowerCase().split(/\s+/))
  for (const row of existing) {
    const oldWords = new Set(row.generalized_rule.toLowerCase().split(/\s+/))
    const intersection = new Set([...newWords].filter(w => oldWords.has(w)))
    const union = new Set([...newWords, ...oldWords])
    const jaccard = union.size > 0 ? intersection.size / union.size : 0
    if (jaccard > 0.7) {
      console.log(`[REFLEXION] Skipping duplicate rule for ${params.agentId} (Jaccard=${jaccard.toFixed(2)})`)
      return ''
    }
  }

  db.run(`
    INSERT INTO agent_memories (id, agent_id, triggering_error, generalized_rule, source_task_id)
    VALUES (?, ?, ?, ?, ?)
  `, [id, params.agentId, params.triggeringError, params.generalizedRule, params.sourceTaskId ?? null])

  console.log(`[REFLEXION] Saved rule for ${params.agentId}: ${params.generalizedRule.slice(0, 80)}`)
  return id
}

/**
 * Get all learned rules for an agent (for prompt injection).
 */
export function getLearnedRules(agentId: string): string[] {
  const db = getDb()
  const rows = db.query(`
    SELECT generalized_rule FROM agent_memories
    WHERE agent_id = ?
    ORDER BY created_at ASC
  `).all(agentId) as { generalized_rule: string }[]

  return rows.map(r => r.generalized_rule)
}

/**
 * Parse <GENERALIZED_RULE> tags from post-mortem output.
 */
export function parseGeneralizedRules(output: string): string[] {
  const rules: string[] = []
  const pattern = /<GENERALIZED_RULE>([\s\S]*?)<\/GENERALIZED_RULE>/g
  let match
  while ((match = pattern.exec(output)) !== null) {
    const rule = match[1].trim()
    if (rule.length > 10) rules.push(rule)
  }
  return rules
}

// ---------------------------------------------------------------------------
// Cited Agent ID tracking -- populated by buildContextFile(), consumed by runner.ts
// Maps taskId -> agent IDs whose work was actually used in smart context (top-3)
// ---------------------------------------------------------------------------
const citedAgentsMap = new Map<string, string[]>()

export function storeCitedAgents(taskId: string, agentIds: string[]): void {
  citedAgentsMap.set(taskId, agentIds)
}

export function getCitedAgents(taskId: string): string[] {
  return citedAgentsMap.get(taskId) ?? []
}

export function clearCitedAgents(taskId: string): void {
  citedAgentsMap.delete(taskId)
}

const MEMORY_DIR = join(process.env.HOME ?? '~', '.claude', 'agents')

// Ensure memory directory exists
if (!existsSync(MEMORY_DIR)) {
  mkdirSync(MEMORY_DIR, { recursive: true })
}

function getMemoryPath(personalityName: string): string {
  return join(MEMORY_DIR, `${personalityName.toLowerCase()}-memory.md`)
}

function getSimDay(): number {
  const db = getDb()
  const clock = db.query(`SELECT sim_day FROM sim_clock WHERE id = 1`).get() as { sim_day: number } | null
  return clock?.sim_day ?? 0
}

export async function readAgentMemory(personalityName: string): Promise<string> {
  const path = getMemoryPath(personalityName)
  try {
    const file = Bun.file(path)
    if (await file.exists()) {
      const text = await file.text()
      // Return last ~4000 chars to stay within reasonable context
      if (text.length > 4000) {
        return '...(earlier entries truncated)...\n\n' + text.slice(-4000)
      }
      return text
    }
  } catch {
    // File doesn't exist yet — that's fine
  }
  return ''
}

export async function updateAgentMemory(
  personalityName: string,
  action: {
    description: string
    phase: number
    output?: string
    files_changed?: string
    key_decisions?: string
  }
): Promise<void> {
  const path = getMemoryPath(personalityName)
  const simDay = getSimDay()

  let existing = ''
  try {
    const file = Bun.file(path)
    if (await file.exists()) {
      existing = await file.text()
    }
  } catch {
    // No existing file
  }

  const outputSummary = action.output
    ? action.output.slice(0, 300) + (action.output.length > 300 ? '...' : '')
    : 'none'

  const newEntry = `
## [Sim Day ${simDay}] ${action.description}
- Phase: ${action.phase}
- Output summary: ${outputSummary}
- Files changed: ${action.files_changed ?? 'none'}
- Key decisions: ${action.key_decisions ?? 'none'}
`

  await Bun.write(path, existing + newEntry)
}

// Get unresolved blockers for this agent
function getOpenTickets(agentId: string): string {
  const db = getDb()
  const blockers = db.query(`
    SELECT reason, created_at FROM blocked_agents
    WHERE agent_id = ? AND resolved_at IS NULL
    ORDER BY created_at DESC
  `).all(agentId) as { reason: string; created_at: string }[]

  if (blockers.length === 0) return ''

  return blockers.map((b, i) =>
    `${i + 1}. [BLOCKER] ${b.reason} (since ${b.created_at})`
  ).join('\n')
}

// Get current sprint info
function getSprintContext(agentId?: string): string {
  const db = getDb()
  const sprint = db.query(`
    SELECT id, number, goal, tasks_planned, tasks_completed, started_at
    FROM sprints WHERE status = 'active' ORDER BY number DESC LIMIT 1
  `).get() as { id: string; number: number; goal: string; tasks_planned: number; tasks_completed: number; started_at: string } | null

  if (!sprint) return ''

  let ctx = `Sprint #${sprint.number} -- Goal: ${sprint.goal}\nProgress: ${sprint.tasks_completed}/${sprint.tasks_planned} tasks completed`

  if (agentId) {
    const myTasks = db.query(`
      SELECT type, description, status FROM actions
      WHERE agent_id = ? AND sprint_id = ? AND status IN ('queued', 'running', 'completed')
      ORDER BY status DESC LIMIT 5
    `).all(agentId, sprint.id) as { type: string; description: string; status: string }[]

    if (myTasks.length > 0) {
      ctx += '\nYour sprint tasks:'
      for (const t of myTasks) {
        const prefix = t.status === 'completed' ? '[DONE]' : t.status === 'running' ? '[IN PROGRESS]' : '[QUEUED]'
        ctx += `\n  ${prefix} ${t.type}: ${t.description.slice(0, 80)}`
      }
    }
  }

  return ctx
}

export async function buildContextFile(
  personalityName: string,
  taskDescription: string,
  phase: number,
  agentId?: string,
  taskId?: string
): Promise<string> {
  const db = getDb()
  const memory = await readAgentMemory(personalityName)
  const simDay = getSimDay()
  const pendingMessages = agentId ? getPendingMessages(agentId) : ''

  // Use intelligence layer for smart context instead of dumping everything
  // Also track which agents' work was cited (for targeted citation in runner.ts)
  let smartContext = ''
  if (agentId) {
    try {
      const { buildSmartContextWithCitations } = await import('../intelligence/analyzer')
      const result = buildSmartContextWithCitations(agentId, personalityName, taskDescription, phase)
      smartContext = result.context

      // Store cited agent IDs so runner.ts can award output_cited to only these agents
      if (taskId && result.citedAgentIds.length > 0) {
        storeCitedAgents(taskId, result.citedAgentIds)
      }
    } catch (e) {
      // Fallback to old approach if intelligence layer fails
      smartContext = getRelevantTeamWork(agentId, phase)
      if (smartContext) smartContext = `## Completed Work From Other Agents\n${smartContext}\n`
    }
  }

  // Open tickets/blockers for this agent
  const openTickets = agentId ? getOpenTickets(agentId) : ''

  // Sprint context
  const sprintContext = getSprintContext(agentId)

  // Daily brief -- synthesized project state for cognitive coherence
  let dailyBrief = ''
  try {
    const { getLatestBrief } = await import('../briefs/daily-brief')
    const brief = getLatestBrief()
    if (brief) {
      dailyBrief = `## Today's Situation (Sim Day ${brief.sim_day})\n${brief.content}\n`
    }
  } catch {
    // Brief system not yet initialized -- skip
  }

  // Failure context -- if this task previously failed, inject context so agent avoids repeating
  let failureContext = ''
  if (taskId) {
    const failureRow = db.query(`SELECT failure_context FROM actions WHERE id = ?`).get(taskId) as { failure_context: string | null } | null
    if (failureRow?.failure_context) {
      failureContext = `## PREVIOUS FAILURE CONTEXT\n${failureRow.failure_context}\nDo NOT repeat the same approach. Try a fundamentally different strategy.\n\n`
    }
  }

  return `# Context for ${personalityName}
## Simulation Day: ${simDay}
## Current Phase: ${phase}

${sprintContext ? `## Current Sprint\n${sprintContext}\n` : ''}
${dailyBrief}
${failureContext}
${openTickets ? `## YOUR OPEN TICKETS\n${openTickets}\n` : ''}
${memory ? `## Your Previous Work\n${memory}\n` : ''}
${smartContext}
${pendingMessages ? `## Messages For You\n${pendingMessages}\n` : ''}
## Current Task
${taskDescription}
`
}

// Pull completed work from other agents that's relevant to this agent's task
function getRelevantTeamWork(agentId: string, phase: number): string {
  const db = getDb()

  // Get completed tasks from this phase by other agents
  const completedTasks = db.query(`
    SELECT a.agent_id, ag.personality_name, a.type, a.description,
           substr(a.output, 1, 2000) as output_preview
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.phase = ? AND a.status = 'completed' AND a.agent_id != ?
    ORDER BY a.completed_at DESC
    LIMIT 10
  `).all(phase, agentId) as any[]

  if (completedTasks.length === 0) return ''

  return completedTasks.map((t: any) =>
    `### ${t.personality_name} (${t.type}): ${t.description}\n${t.output_preview}\n`
  ).join('\n---\n')
}

// Get unread messages addressed to this agent
function getPendingMessages(agentId: string): string {
  const db = getDb()

  const messages = db.query(`
    SELECT m.from_agent_id, ag.personality_name as from_name,
           m.subject, m.body, m.priority, m.created_at
    FROM messages m
    LEFT JOIN agents ag ON ag.id = m.from_agent_id
    WHERE (m.to_agent_id = ? OR m.to_team = (SELECT team FROM agents WHERE id = ?))
      AND m.status = 'sent'
    ORDER BY m.created_at DESC
    LIMIT 10
  `).all(agentId, agentId) as any[]

  if (messages.length === 0) return ''

  // Mark as read
  for (const m of messages) {
    db.run(`UPDATE messages SET status = 'read' WHERE id = ?`, [(m as any).id])
  }

  return messages.map((m: any) =>
    `**From ${m.from_name ?? m.from_agent_id}** (${m.priority}): ${m.subject}\n${m.body}`
  ).join('\n\n')
}

export async function clearAgentMemory(personalityName: string): Promise<void> {
  const path = getMemoryPath(personalityName)
  try {
    await Bun.write(path, '')
  } catch {
    // Ignore
  }
}
