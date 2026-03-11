import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from '../db/database'

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

export async function buildContextFile(
  personalityName: string,
  taskDescription: string,
  phase: number,
  agentId?: string
): Promise<string> {
  const memory = await readAgentMemory(personalityName)
  const simDay = getSimDay()
  const pendingMessages = agentId ? getPendingMessages(agentId) : ''

  // Use intelligence layer for smart context instead of dumping everything
  let smartContext = ''
  if (agentId) {
    try {
      const { buildSmartContext } = await import('../intelligence/analyzer')
      smartContext = buildSmartContext(agentId, personalityName, taskDescription, phase)
    } catch (e) {
      // Fallback to old approach if intelligence layer fails
      smartContext = getRelevantTeamWork(agentId, phase)
      if (smartContext) smartContext = `## Completed Work From Other Agents\n${smartContext}\n`
    }
  }

  return `# Context for ${personalityName}
## Simulation Day: ${simDay}
## Current Phase: ${phase}

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
