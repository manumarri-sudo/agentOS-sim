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
  phase: number
): Promise<string> {
  const memory = await readAgentMemory(personalityName)
  const simDay = getSimDay()

  return `# Context for ${personalityName}
## Simulation Day: ${simDay}
## Current Phase: ${phase}

${memory ? `## Memory (Previous Actions)\n${memory}\n` : ''}
## Current Task
${taskDescription}
`
}

export async function clearAgentMemory(personalityName: string): Promise<void> {
  const path = getMemoryPath(personalityName)
  try {
    await Bun.write(path, '')
  } catch {
    // Ignore
  }
}
