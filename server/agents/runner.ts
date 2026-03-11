import { getDb } from '../db/database'
import { buildAgentPrompt } from './prompts'
import { buildContextFile, updateAgentMemory } from './memory'
import { AGENTS, resolveModel } from './registry'
import { broadcastAGUI } from '../orchestrator'
import { sendMessage } from '../messages/bus'
import { recordQuorumContribution, logCollaborationEvent, recalculateAllCFS, updateAllTiers } from '../reward'
import { verify } from '../reward/verifier'
import { shouldSpotCheck, runSpotChecks } from '../reward/spot-check'
import { unlinkSync } from 'node:fs'
import { recordTaskUsage } from '../usage/budget-manager'
import { parseCliJsonResponse, recordTokenUsage, computeCost } from '../usage/token-costs'
import { enqueueTask } from '../tasks/queue'
import { logTaskToDrive } from '../gdrive/client'
import { logTaskToNotion } from '../notion/sync'
import { getSimDay } from '../clock'
import { logActivity } from '../activity'
import { reportBlocked } from '../reward/blockers'
import { checkCrossReviews } from '../collaboration/engine'

// ---------------------------------------------------------------------------
// Agent Runner — doc 7 Patch A (CORRECTED spawn format)
// + Retry logic from doc 6 Issue 9
// ---------------------------------------------------------------------------

const PRODUCT_REPO_PATH = process.env.PRODUCT_REPO_PATH ?? `${process.env.HOME}/experiment-product`
const COS_AGENT_ID = 'priya'
const MAX_RETRIES = 3

// Track active processes for concurrency management
const activeProcesses = new Map<string, { proc: ReturnType<typeof Bun.spawn>; taskId: string }>()

export function getActiveProcessCount(): number {
  return activeProcesses.size
}

// ---------------------------------------------------------------------------
// Build system prompt for an agent
// ---------------------------------------------------------------------------
function buildSystemPrompt(agent: { id: string; personality_name: string; team: string; role: string }): string {
  const agentConfig = AGENTS.find(a => a.id === agent.id)
  if (!agentConfig) {
    throw new Error(`Agent config not found for ${agent.id}`)
  }
  return buildAgentPrompt(agentConfig)
}

// ---------------------------------------------------------------------------
// Build context file for a task
// ---------------------------------------------------------------------------
async function writeContextFile(
  agent: { id: string; personality_name: string },
  task: { id: string; description: string; phase: number }
): Promise<string> {
  const contextContent = await buildContextFile(
    agent.personality_name,
    task.description,
    task.phase,
    agent.id
  )

  const contextPath = `/tmp/agent-context-${task.id}.md`
  await Bun.write(contextPath, contextContent)
  return contextPath
}

// ---------------------------------------------------------------------------
// Set agent status in DB
// ---------------------------------------------------------------------------
function setAgentStatus(agentId: string, status: string): void {
  const db = getDb()
  db.run(`UPDATE agents SET status = ? WHERE id = ?`, [status, agentId])
}

// ---------------------------------------------------------------------------
// Spawn agent process — doc 7 Patch A corrected format
// ---------------------------------------------------------------------------
export async function spawnAgentProcess(
  agent: { id: string; personality_name: string; team: string; role: string },
  task: { id: string; description: string; phase: number; type: string }
): Promise<void> {
  const db = getDb()

  // Check mock mode
  const mockMode = process.env.MOCK_AGENTS === 'true'

  if (mockMode) {
    await handleMockAgent(agent, task)
    return
  }

  // Build context file
  const contextFile = await writeContextFile(agent, task)

  // Resolve model based on agent + task type
  const model = resolveModel(agent.id, task.type)

  // Track spawn time for usage recording
  const spawnTime = Date.now()

  // Read context file content to append to task description
  const contextContent = await Bun.file(contextFile).text()
  const fullTaskDescription = `${task.description}\n\n--- CONTEXT ---\n${contextContent}`

  // Correct Claude Code CLI invocation — doc 7 Patch A
  // Uses --output-format json to capture actual token usage from CLI response
  const proc = Bun.spawn([
    '/opt/homebrew/bin/claude',
    '--print',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--system-prompt', buildSystemPrompt(agent),
    '--model', model,
    fullTaskDescription,
  ], {
    cwd: PRODUCT_REPO_PATH,
    env: {
      ...process.env,
      PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
      CLAUDECODE: '',  // unset to prevent nested session detection
      CLAUDE_CODE_ENTRY_POINT: '',
      AGENT_ID: agent.id,
      AGENT_TOKEN: `agent-${agent.id}-${task.id}`,
      PHASE: String(task.phase),
      CONTEXT_FILE: contextFile,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Track active process
  activeProcesses.set(agent.id, { proc, taskId: task.id })

  console.log(`[RUNNER] Spawned ${agent.personality_name} (${model}) for task ${task.id}: ${task.description.slice(0, 80)}...`)

  // Collect stdout (JSON format -- parsed after process exits)
  let rawStdout = ''
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()

  // Stream output -- with JSON format we still collect chunks for live broadcast,
  // but the full JSON is parsed after exit to extract usage data
  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value)
        rawStdout += chunk

        // Broadcast raw chunk for live streaming (dashboard shows progress)
        broadcastAGUI({
          type: 'TEXT_MESSAGE_CONTENT',
          agentId: agent.id,
          agentName: agent.personality_name,
          taskId: task.id,
          content: chunk,
        })
      }
    } catch {
      // Stream ended
    }
  })()

  // Collect stderr
  let stderr = ''
  const errReader = proc.stderr.getReader()
  ;(async () => {
    try {
      while (true) {
        const { done, value } = await errReader.read()
        if (done) break
        stderr += decoder.decode(value)
      }
    } catch {
      // Stream ended
    }
  })()

  // Handle process exit — with retry logic from doc 6 Issue 9
  proc.exited.then(async (code) => {
    // Clean up tracking
    activeProcesses.delete(agent.id)

    // Clean up context file
    try { unlinkSync(contextFile) } catch { /* ignore */ }

    if (code === 0) {
      // Parse JSON response to extract text content and real token usage
      const parsed = parseCliJsonResponse(rawStdout)
      const stdout = parsed?.text ?? rawStdout  // fallback to raw if JSON parse fails
      const durationMs = Date.now() - spawnTime

      // Record ACTUAL token usage if we got it from the CLI JSON response
      if (parsed?.usage) {
        recordTokenUsage({
          taskId: task.id,
          agentId: agent.id,
          model,
          usage: parsed.usage,
          durationMs,
          phase: task.phase,
          source: 'actual',
        })
        console.log(`[TOKENS] ${agent.personality_name}: ${parsed.usage.input_tokens} in / ${parsed.usage.output_tokens} out (${model})`)
      } else {
        // Fallback: estimate from text length (~4 chars per token)
        const estInputTokens = Math.ceil((buildSystemPrompt(agent).length + fullTaskDescription.length) / 4)
        const estOutputTokens = Math.ceil(stdout.length / 4)
        recordTokenUsage({
          taskId: task.id,
          agentId: agent.id,
          model,
          usage: {
            input_tokens: estInputTokens,
            output_tokens: estOutputTokens,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
          durationMs,
          phase: task.phase,
          source: 'estimated',
        })
        console.log(`[TOKENS] ${agent.personality_name}: ~${estInputTokens} in / ~${estOutputTokens} out (${model}, ESTIMATED)`)
      }

      // Set to proposed_complete — verifier decides final status
      db.run(
        `UPDATE actions SET status = 'proposed_complete', output = ? WHERE id = ?`,
        [stdout, task.id]
      )

      // Run verifier — the ONLY thing that sets status = 'completed'
      const action = db.query(`SELECT * FROM actions WHERE id = ?`).get(task.id) as any
      const result = verify({
        id: task.id,
        agent_id: agent.id,
        type: task.type,
        output: stdout,
        expected_output_path: action?.expected_output_path,
        expected_schema: action?.expected_schema,
      })

      if (result.passed) {
        setAgentStatus(agent.id, 'idle')

        // Update agent memory
        await updateAgentMemory(agent.personality_name, {
          description: task.description,
          phase: task.phase,
          output: stdout,
        })

        // Record quorum contribution for the agent's team
        recordQuorumContribution(agent.id, agent.team, task.id, task.phase)

        // Run spot checks on ~30% of completed actions (hidden)
        if (shouldSpotCheck()) {
          runSpotChecks({
            id: task.id,
            agent_id: agent.id,
            type: task.type,
            output: stdout,
          })
        }

        broadcastAGUI({
          type: 'RUN_COMPLETED',
          agentId: agent.id,
          agentName: agent.personality_name,
          taskId: task.id,
          outputLength: stdout.length,
        })

        // Record usage for budget tracking (hours-based throttle system)
        recordTaskUsage({
          agentId: agent.id,
          taskId: task.id,
          model,
          durationMs,
        })

        console.log(`[RUNNER] ${agent.personality_name} completed task ${task.id} (${stdout.length} chars)`)

        // Post-completion collaboration hooks
        onTaskCompleted(agent, task, stdout)
      } else {
        // Verification failed — NO CFS, notify CoS
        setAgentStatus(agent.id, 'idle')

        // Notify CoS of verification failure
        sendMessage({
          fromAgentId: 'system',
          toAgentId: COS_AGENT_ID,
          subject: `Verification failed: ${agent.personality_name}`,
          body: `Task ${task.id} by ${agent.personality_name} failed verification: ${result.failedCheck} — ${result.notes}`,
          priority: 'high',
        })

        broadcastAGUI({
          type: 'VERIFICATION_FAILED',
          agentId: agent.id,
          agentName: agent.personality_name,
          taskId: task.id,
          failedCheck: result.failedCheck,
          notes: result.notes,
        })

        console.warn(`[RUNNER] ${agent.personality_name} task ${task.id} verification failed: ${result.failedCheck} — ${result.notes}`)
      }
    } else {
      // Failure — retry with exponential backoff (doc 6 Issue 9)
      await handleTaskFailure(agent, task, code, stderr)
    }
  })
}

// ---------------------------------------------------------------------------
// Retry logic — doc 6 Issue 9
// ---------------------------------------------------------------------------
async function handleTaskFailure(
  agent: { id: string; personality_name: string; team: string; role: string },
  task: { id: string; description: string; phase: number; type: string },
  exitCode: number | null,
  stderr: string
): Promise<void> {
  const db = getDb()

  const action = db.query(`SELECT retry_count FROM actions WHERE id = ?`).get(task.id) as {
    retry_count: number
  } | null

  const retryCount = action?.retry_count ?? 0

  if (retryCount < MAX_RETRIES) {
    const backoffMs = Math.pow(2, retryCount) * 30_000 // 30s, 60s, 120s

    console.warn(
      `[RUNNER] Agent ${agent.personality_name} task ${task.id} failed (exit ${exitCode}, attempt ${retryCount + 1}/${MAX_RETRIES}), ` +
      `retrying in ${backoffMs / 1000}s. Stderr: ${stderr.slice(0, 200)}`
    )

    db.run(
      `UPDATE actions SET retry_count = ?, status = 'queued' WHERE id = ?`,
      [retryCount + 1, task.id]
    )
    setAgentStatus(agent.id, 'idle')

    // Schedule retry with backoff
    setTimeout(() => {
      // Re-dispatch will happen naturally through the orchestrator loop
      // since the task is re-queued and agent is idle
    }, backoffMs)

    broadcastAGUI({
      type: 'TASK_RETRY',
      agentId: agent.id,
      agentName: agent.personality_name,
      taskId: task.id,
      attempt: retryCount + 1,
      maxRetries: MAX_RETRIES,
      backoffMs,
    })
  } else {
    // Max retries exhausted
    db.run(`UPDATE actions SET status = 'failed', output = ? WHERE id = ?`, [stderr, task.id])
    setAgentStatus(agent.id, 'idle')

    // Notify CoS
    sendMessage({
      fromAgentId: 'system',
      toAgentId: COS_AGENT_ID,
      subject: `Agent ${agent.personality_name} task failed after ${MAX_RETRIES} retries`,
      body: `Task: ${task.description}\nExit code: ${exitCode}\nStderr: ${stderr.slice(0, 500)}`,
      priority: 'urgent',
    })

    broadcastAGUI({
      type: 'TASK_FAILED',
      agentId: agent.id,
      agentName: agent.personality_name,
      taskId: task.id,
      exitCode,
      error: stderr.slice(0, 300),
    })

    console.error(
      `[RUNNER] Agent ${agent.personality_name} task ${task.id} failed after ${MAX_RETRIES} retries`
    )
  }
}

// ---------------------------------------------------------------------------
// Mock agent handler (for dry runs / compressed mode testing)
// ---------------------------------------------------------------------------
async function handleMockAgent(
  agent: { id: string; personality_name: string; team: string; role: string },
  task: { id: string; description: string; phase: number; type: string }
): Promise<void> {
  const db = getDb()

  console.log(`[RUNNER:MOCK] ${agent.personality_name} processing task: ${task.description.slice(0, 60)}...`)

  const mockSpawnTime = Date.now()

  // Simulate processing time (1-3 seconds in mock mode)
  await Bun.sleep(1000 + Math.random() * 2000)

  const mockOutput = `[MOCK] ${agent.personality_name} (${agent.role}) completed: ${task.description}\n\nThis is a mock response for dry-run testing. In real mode, Claude Code would process this task autonomously. The simulation ran successfully with all expected parameters and produced valid output for the given task requirements.`

  // Set to proposed_complete — verifier decides final status (same flow as real agents)
  db.run(
    `UPDATE actions SET status = 'proposed_complete', output = ? WHERE id = ?`,
    [mockOutput, task.id]
  )

  const action = db.query(`SELECT * FROM actions WHERE id = ?`).get(task.id) as any
  const result = verify({
    id: task.id,
    agent_id: agent.id,
    type: task.type,
    output: mockOutput,
    expected_output_path: action?.expected_output_path,
    expected_schema: action?.expected_schema,
  })

  if (result.passed) {
    setAgentStatus(agent.id, 'idle')

    await updateAgentMemory(agent.personality_name, {
      description: task.description,
      phase: task.phase,
      output: mockOutput,
    })

    // Record quorum contribution in mock mode too
    recordQuorumContribution(agent.id, agent.team, task.id, task.phase)

    // Run spot checks on ~30% of completed actions (hidden)
    if (shouldSpotCheck()) {
      runSpotChecks({
        id: task.id,
        agent_id: agent.id,
        type: task.type,
        output: mockOutput,
      })
    }

    // Record usage for budget tracking
    const mockDuration = Date.now() - mockSpawnTime
    const mockModel = resolveModel(agent.id, task.type)
    recordTaskUsage({
      agentId: agent.id,
      taskId: task.id,
      model: mockModel,
      durationMs: mockDuration,
    })

    // Record token usage (estimated for mock mode)
    const estInput = Math.ceil((task.description.length + 2000) / 4)  // ~2k prompt overhead
    const estOutput = Math.ceil(mockOutput.length / 4)
    recordTokenUsage({
      taskId: task.id,
      agentId: agent.id,
      model: mockModel,
      usage: {
        input_tokens: estInput,
        output_tokens: estOutput,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
      durationMs: mockDuration,
      phase: task.phase,
      source: 'estimated',
    })

    broadcastAGUI({
      type: 'RUN_COMPLETED',
      agentId: agent.id,
      agentName: agent.personality_name,
      taskId: task.id,
      outputLength: mockOutput.length,
      mock: true,
    })
  } else {
    setAgentStatus(agent.id, 'idle')

    broadcastAGUI({
      type: 'VERIFICATION_FAILED',
      agentId: agent.id,
      agentName: agent.personality_name,
      taskId: task.id,
      failedCheck: result.failedCheck,
      notes: result.notes,
      mock: true,
    })

    // Notify CoS of mock verification failure
    sendMessage({
      fromAgentId: 'system',
      toAgentId: COS_AGENT_ID,
      subject: `Verification failed: ${agent.personality_name}`,
      body: `Task ${task.id} by ${agent.personality_name} failed verification: ${result.failedCheck} — ${result.notes}`,
      priority: 'high',
    })

    console.warn(`[RUNNER:MOCK] ${agent.personality_name} task ${task.id} verification failed: ${result.notes}`)
  }
}

// ---------------------------------------------------------------------------
// Kill a running agent process
// ---------------------------------------------------------------------------
export function killAgentProcess(agentId: string): boolean {
  const entry = activeProcesses.get(agentId)
  if (!entry) return false

  entry.proc.kill()
  activeProcesses.delete(agentId)
  setAgentStatus(agentId, 'idle')
  return true
}

// ---------------------------------------------------------------------------
// Get active process info (for dashboard)
// ---------------------------------------------------------------------------
export function getActiveProcesses(): Array<{ agentId: string; taskId: string }> {
  return Array.from(activeProcesses.entries()).map(([agentId, { taskId }]) => ({
    agentId,
    taskId,
  }))
}

// ---------------------------------------------------------------------------
// Signal Parser — extracts structured signals from agent output
// Agents use [BLOCKER], [MSG], [ESCALATE], [HANDOFF], [NEXT_TASK] tags
// ---------------------------------------------------------------------------
function parseAgentSignals(
  agent: { id: string; personality_name: string; team: string },
  task: { id: string; phase: number },
  output: string
): void {
  const db = getDb()

  // [BLOCKER] — flag the agent as blocked
  const blockerMatch = output.match(/\[BLOCKER\]\s*(.+?)(?:\n|$)/g)
  if (blockerMatch) {
    for (const match of blockerMatch) {
      const reason = match.replace(/\[BLOCKER\]\s*/, '').trim()
      reportBlocked(agent.id, reason)
      console.log(`[SIGNAL] ${agent.personality_name} flagged blocker: ${reason.slice(0, 80)}`)
    }
  }

  // [ESCALATE] — send urgent message to CEO
  const escalateMatches = output.match(/\[ESCALATE\]\s*(.+?)(?:\n|$)/g)
  if (escalateMatches) {
    for (const match of escalateMatches) {
      const message = match.replace(/\[ESCALATE\]\s*/, '').trim()
      sendMessage({
        fromAgentId: agent.id,
        toAgentId: 'reza',
        subject: `ESCALATION from ${agent.personality_name}`,
        body: message,
        priority: 'urgent',
      })
      // Also post to CEO chat so human sees it
      try {
        db.run(`
          INSERT INTO ceo_chat (id, sender, message, message_type, phase, sim_day, read_by_human)
          VALUES (?, 'reza', ?, 'alert', ?, ?, 0)
        `, [crypto.randomUUID(), `[ESCALATION from ${agent.personality_name}]\n\n${message}`, task.phase, getSimDay()])
      } catch { /* ceo_chat may not exist */ }
      console.log(`[SIGNAL] ${agent.personality_name} escalated to CEO: ${message.slice(0, 80)}`)
    }
  }

  // [MSG to:<id> priority:<level>] — inter-agent message
  const msgPattern = /\[MSG\s+to:(\w+)\s+priority:(\w+)\]\s*(.+?)(?:\n|$)/g
  let msgMatch
  while ((msgMatch = msgPattern.exec(output)) !== null) {
    const [, toId, priority, body] = msgMatch
    sendMessage({
      fromAgentId: agent.id,
      toAgentId: toId,
      subject: `Message from ${agent.personality_name}`,
      body: body.trim(),
      priority: priority as any,
    })
    console.log(`[SIGNAL] ${agent.personality_name} → ${toId}: ${body.trim().slice(0, 60)}`)
  }

  // [HANDOFF to:<id>] — hand work off to another agent
  const handoffPattern = /\[HANDOFF\s+to:(\w+)\]\s*(.+?)(?:\n|$)/g
  let handoffMatch
  while ((handoffMatch = handoffPattern.exec(output)) !== null) {
    const [, toId, description] = handoffMatch
    sendMessage({
      fromAgentId: agent.id,
      toAgentId: toId,
      subject: `Handoff from ${agent.personality_name}`,
      body: description.trim(),
      priority: 'high',
    })
    logCollaborationEvent({
      fromAgentId: agent.id,
      toAgentId: toId,
      eventType: 'scope_expansion',
      actionId: task.id,
      phase: task.phase,
    })
    console.log(`[SIGNAL] ${agent.personality_name} handoff → ${toId}: ${description.trim().slice(0, 60)}`)
  }

  // [NEXT_TASK for:<id> type:<type>] — request a follow-up task
  const nextTaskPattern = /\[NEXT_TASK\s+for:(\w+)\s+type:(\w+)\]\s*(.+?)(?:\n|$)/g
  let taskMatch
  while ((taskMatch = nextTaskPattern.exec(output)) !== null) {
    const [, forId, type, description] = taskMatch
    enqueueTask({
      agentId: forId,
      type: type as any,
      description: description.trim(),
      phase: task.phase,
    })
    console.log(`[SIGNAL] ${agent.personality_name} requested task for ${forId}: ${description.trim().slice(0, 60)}`)
  }

  // [PROCESS_PROPOSAL] — agent suggests a process improvement
  const processMatches = output.match(/\[PROCESS_PROPOSAL\]\s*(.+?)(?:\n\[|$)/gs)
  if (processMatches) {
    for (const match of processMatches) {
      const proposal = match.replace(/\[PROCESS_PROPOSAL\]\s*/, '').trim()

      // Send to Jordan (Ops) and Priya (CoS) for review
      sendMessage({
        fromAgentId: agent.id,
        toAgentId: 'jordan',
        subject: `Process proposal from ${agent.personality_name}`,
        body: proposal,
        priority: 'high',
      })
      sendMessage({
        fromAgentId: agent.id,
        toAgentId: 'priya',
        subject: `Process proposal from ${agent.personality_name}`,
        body: proposal,
        priority: 'high',
      })

      // Create a task for Jordan to evaluate and implement
      enqueueTask({
        agentId: 'jordan',
        type: 'decide',
        description: `PROCESS PROPOSAL from ${agent.personality_name}:\n\n${proposal.slice(0, 1500)}\n\nAs Ops Manager, evaluate this proposal:\n1. Is this worth implementing? Why or why not?\n2. What's the effort to adopt it?\n3. If yes — draft the new standard and use [MSG] to announce it to the team.\n4. If no — explain why and message ${agent.personality_name} with your reasoning.`,
        phase: task.phase,
      })

      // Post to CEO chat so human sees it
      try {
        db.run(`
          INSERT INTO ceo_chat (id, sender, message, message_type, phase, sim_day, read_by_human)
          VALUES (?, 'reza', ?, 'alert', ?, ?, 0)
        `, [crypto.randomUUID(), `[PROCESS PROPOSAL from ${agent.personality_name}]\n\n${proposal.slice(0, 500)}`, task.phase, getSimDay()])
      } catch { /* ceo_chat may not exist */ }

      logActivity({
        agentId: agent.id,
        phase: task.phase,
        eventType: 'process_proposal',
        summary: `${agent.personality_name} proposed: ${proposal.slice(0, 80)}`,
      })

      console.log(`[SIGNAL] ${agent.personality_name} proposed process improvement: ${proposal.slice(0, 80)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Post-completion collaboration hooks
//
// When an agent finishes a task, the orchestrator creates:
// 1. Messages to relevant agents about the completed work
// 2. Follow-up tasks (e.g., CEO review after research completes)
// 3. Cross-team notifications
// ---------------------------------------------------------------------------
function onTaskCompleted(
  agent: { id: string; personality_name: string; team: string; role: string },
  task: { id: string; description: string; phase: number; type: string },
  output: string
): void {
  const db = getDb()

  // -1. Parse structured signals from agent output ([BLOCKER], [ESCALATE], [MSG], etc.)
  parseAgentSignals(agent, task, output)

  // 0. Log to Google Drive + Notion
  const simDay = getSimDay()
  logTaskToDrive(agent.personality_name, agent.team, task.type, task.description, output, task.phase, simDay)
  logTaskToNotion(agent.personality_name, agent.team, task.type, task.description, output, task.phase, simDay)

  // 0z. Log collaboration events so CFS actually accumulates
  // Every completed task earns the agent a base collaboration event
  logCollaborationEvent({
    fromAgentId: agent.id,
    toAgentId: agent.id,
    eventType: 'message_actioned', // base credit for completing work (+1.0)
    actionId: task.id,
    phase: task.phase,
  })

  // 0a. If Reza completed a review/decide task, auto-post summary to CEO chat
  if (agent.id === 'reza' && ['decide', 'review', 'meeting', 'chat'].includes(task.type)) {
    try {
      const summary = output.slice(0, 1500)
      const messageType = task.type === 'decide' ? 'decision' :
                          task.description.toLowerCase().includes('phase') ? 'phase_request' : 'chat'
      db.run(`
        INSERT INTO ceo_chat (id, sender, message, message_type, phase, sim_day, read_by_human)
        VALUES (?, 'reza', ?, ?, ?, ?, 0)
      `, [crypto.randomUUID(), `[${task.type.toUpperCase()}] ${task.description.slice(0, 100)}\n\n${summary}`, messageType, task.phase, simDay])
    } catch (e) {
      // ceo_chat table may not exist yet
      console.error('[RUNNER] CEO chat post failed:', e)
    }
  }

  // 0b. Log activity: task completed
  logActivity({
    agentId: agent.id,
    phase: task.phase,
    eventType: 'task_completed',
    summary: `${agent.personality_name} completed ${task.type}: ${task.description.slice(0, 80)}`,
  })

  // 1. Check what other agents' work was included in this agent's context
  const usedOutputs = db.query(`
    SELECT DISTINCT a.agent_id, ag.personality_name
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.phase = ? AND a.status = 'completed' AND a.agent_id != ?
  `).all(task.phase, agent.id) as { agent_id: string; personality_name: string }[]

  for (const used of usedOutputs) {
    logActivity({
      agentId: agent.id,
      otherAgentId: used.agent_id,
      phase: task.phase,
      eventType: 'used_work',
      summary: `${agent.personality_name} used ${used.personality_name}'s research as context for their task`,
    })

    // Credit the cited agent — their output was useful (+2.0)
    logCollaborationEvent({
      fromAgentId: agent.id,
      toAgentId: used.agent_id,
      eventType: 'output_cited',
      actionId: task.id,
      phase: task.phase,
    })
  }

  // 2. Notify team lead / CEO about completed work
  const outputPreview = output.slice(0, 500) + (output.length > 500 ? '...' : '')

  // Notify Priya (CoS) about all completed work — she tracks everything
  sendMessage({
    fromAgentId: agent.id,
    toAgentId: 'priya',
    subject: `${agent.personality_name} completed: ${task.description.slice(0, 60)}`,
    body: `Task completed by ${agent.personality_name} (${agent.team} team).\n\nTask: ${task.description}\n\nOutput preview:\n${outputPreview}`,
    priority: 'normal',
  })

  logActivity({
    agentId: agent.id,
    otherAgentId: 'priya',
    phase: task.phase,
    eventType: 'notified',
    summary: `${agent.personality_name} reported completion to Priya (CoS)`,
  })

  // 3. Cross-team notifications for dependent work
  if (agent.team === 'strategy' && task.type === 'write') {
    sendMessage({
      fromAgentId: agent.id,
      toAgentId: 'dani',
      subject: `Strategy deliverable ready: ${task.description.slice(0, 60)}`,
      body: `${agent.personality_name} has completed a strategy deliverable that may inform product decisions.\n\nTask: ${task.description}\n\nPreview:\n${outputPreview}`,
      priority: 'high',
    })
    logActivity({
      agentId: agent.id,
      otherAgentId: 'dani',
      phase: task.phase,
      eventType: 'handoff',
      summary: `${agent.personality_name} handed off strategy deliverable to Dani (CPO)`,
    })

    // Cross-team handoff credit (+2.0)
    logCollaborationEvent({
      fromAgentId: agent.id,
      toAgentId: 'dani',
      eventType: 'scope_expansion',
      actionId: task.id,
      phase: task.phase,
    })
  }

  // 3b. Review tasks earn cross_approval credit for the reviewer
  if (task.type === 'review') {
    logCollaborationEvent({
      fromAgentId: agent.id,
      toAgentId: agent.id,
      eventType: 'cross_approval',
      actionId: task.id,
      phase: task.phase,
    })
  }

  // 3c. Recalculate CFS and tiers after new events
  recalculateAllCFS()
  updateAllTiers()

  // 3d. Cross-team reviews — only for primary work, NOT reviews/meetings/chat
  // This prevents the cascade: task → review → cross-review → review of cross-review → ...
  if (!['review', 'meeting', 'chat', 'decide'].includes(task.type)) {
    try {
      checkCrossReviews(agent, task, output)
    } catch (e) {
      console.error('[COLLAB] Cross-review check error:', e)
    }
  }

  // 4. Team lead review — only for primary work (research, build, write)
  // Skip reviews of reviews, meetings, chats — these are meta-work
  if (['research', 'build', 'write'].includes(task.type)) {
    createTeamLeadReview(agent, task, output)
  }

  // 5. Check if all Phase 1 tasks are done → create CEO review task
  if (task.phase === 1) {
    checkPhase1Completion()
  }

  // 6. Check if all phase tasks are done → create CEO review for any phase
  checkPhaseReviewNeeded(task.phase)
}

// Team lead reviews employee output and suggests improvements
const TEAM_LEADS: Record<string, string> = {
  strategy: 'marcus',  // Opportunity Analyst reviews strategy team
  tech: 'amir',        // Tech PM reviews engineering team
  ops: 'jordan',       // Ops Manager reviews ops team
  marketing: 'sol',    // Marketing Lead reviews marketing team
}

// Exec team reports to Reza directly
const EXEC_REVIEWER = 'reza'

function createTeamLeadReview(
  agent: { id: string; personality_name: string; team: string; role: string },
  task: { id: string; description: string; phase: number; type: string },
  output: string
): void {
  const db = getDb()

  // Don't create review of a review (avoid infinite loops)
  if (task.type === 'review') return

  // Don't review the reviewer's own work
  const reviewerId = agent.team === 'exec'
    ? EXEC_REVIEWER
    : TEAM_LEADS[agent.team]

  if (!reviewerId || reviewerId === agent.id) return

  // Check if a review already exists for this task
  const existing = db.query(
    `SELECT 1 FROM actions WHERE agent_id = ? AND description LIKE ? AND phase = ?`
  ).get(reviewerId, `%Review ${agent.personality_name}%${task.id.slice(0, 8)}%`, task.phase)

  if (existing) return

  const reviewerName = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(reviewerId) as any)?.personality_name ?? reviewerId

  const outputPreview = output.slice(0, 800) + (output.length > 800 ? '...' : '')

  enqueueTask({
    agentId: reviewerId,
    type: 'review',
    description: `Review ${agent.personality_name}'s completed work (task ${task.id.slice(0, 8)}).\n\nOriginal task: ${task.description}\n\nTheir output:\n${outputPreview}\n\nAs their manager, evaluate:\n1. Did they fully address the task?\n2. What's missing or could be stronger?\n3. Any specific follow-up tasks you'd assign them?\n4. Rate quality: exceptional / solid / needs work\n\nBe specific and actionable in your feedback.`,
    phase: task.phase,
  })

  logActivity({
    agentId: reviewerId,
    otherAgentId: agent.id,
    phase: task.phase,
    eventType: 'review_assigned',
    summary: `${reviewerName} assigned to review ${agent.personality_name}'s work: ${task.description.slice(0, 60)}`,
  })
}

// Check if Phase 1 research is complete enough for CEO review
function checkPhase1Completion(): void {
  const db = getDb()

  // Count completed vs total Phase 1 tasks
  const stats = db.query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM actions WHERE phase = 1
  `).get() as { total: number; completed: number }

  // Need at least Zara's OpportunityVault + Nina's customer report + Marcus's scoring
  // Check if key agents have completed at least one task
  const keyCompletions = db.query(`
    SELECT DISTINCT agent_id FROM actions
    WHERE phase = 1 AND status = 'completed' AND agent_id IN ('zara', 'nina', 'marcus')
  `).all() as { agent_id: string }[]

  const completedAgents = new Set(keyCompletions.map(r => r.agent_id))

  // If Zara and Nina are done but Marcus hasn't started scoring yet, that's fine
  // But if Zara and Nina are done, notify Marcus to use their outputs
  if (completedAgents.has('zara') && completedAgents.has('nina') && !completedAgents.has('marcus')) {
    // Check if we already sent this notification
    const alreadyNotified = db.query(`
      SELECT 1 FROM messages
      WHERE to_agent_id = 'marcus' AND subject LIKE '%research is ready%'
    `).get()

    if (!alreadyNotified) {
      sendMessage({
        fromAgentId: 'system',
        toAgentId: 'marcus',
        subject: 'Research is ready for scoring',
        body: 'Zara has completed the OpportunityVault and Nina has completed the voice-of-customer report. Your scoring tasks should now have full context from their research outputs.',
        priority: 'high',
      })
    }
  }

  // If all three key agents have completed work, create CEO review task
  if (completedAgents.has('zara') && completedAgents.has('nina') && completedAgents.has('marcus')) {
    createCEOReviewTask(1)
  }
}

// Create a CEO review task for a phase
function createCEOReviewTask(phase: number): void {
  const db = getDb()

  // Check if CEO review task already exists for this phase
  const existing = db.query(`
    SELECT 1 FROM actions WHERE agent_id = 'reza' AND phase = ? AND description LIKE '%review%phase%'
  `).get(phase)

  if (existing) return

  // Get all completed outputs for this phase
  const completedWork = db.query(`
    SELECT ag.personality_name, a.description, substr(a.output, 1, 1000) as output_preview
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.phase = ? AND a.status = 'completed'
    ORDER BY a.completed_at ASC
  `).all(phase) as any[]

  const workSummary = completedWork.map((w: any) =>
    `**${w.personality_name}**: ${w.description}\nOutput: ${w.output_preview}`
  ).join('\n\n---\n\n')

  enqueueTask({
    agentId: 'reza',
    type: 'decide',
    description: `Review Phase ${phase} deliverables and decide: advance to Phase ${phase + 1}, or send back with specific feedback.\n\nCompleted work from the team:\n\n${workSummary}`,
    phase,
  })

  // Also create a CoS task to prepare the phase advance recommendation
  enqueueTask({
    agentId: 'priya',
    type: 'write',
    description: `Prepare Phase ${phase} completion summary for CEO review. Assess: (1) Are all required deliverables present? (2) Quality assessment of each. (3) Recommendation: advance or iterate. (4) Key risks if we advance now.\n\nCompleted work from the team:\n\n${workSummary}`,
    phase,
  })

  sendMessage({
    fromAgentId: 'system',
    toAgentId: 'reza',
    subject: `Phase ${phase} deliverables ready for your review`,
    body: `The team has completed Phase ${phase} work. A review task has been created for you. Priya is also preparing a summary recommendation.`,
    priority: 'urgent',
  })

  logActivity({
    agentId: 'reza',
    otherAgentId: 'priya',
    phase,
    eventType: 'review_requested',
    summary: `Phase ${phase} deliverables sent to Reza (CEO) for review. Priya preparing summary.`,
  })

  console.log(`[RUNNER] Created CEO review task for Phase ${phase}`)
}

// Generic phase review check — creates CEO review when enough work is done
function checkPhaseReviewNeeded(phase: number): void {
  if (phase === 1) return // handled by checkPhase1Completion

  const db = getDb()

  const stats = db.query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) as pending
    FROM actions WHERE phase = ?
  `).get(phase) as { total: number; completed: number; pending: number }

  // If all tasks for this phase are done (none pending), trigger CEO review
  if (stats.total > 0 && stats.pending === 0 && stats.completed === stats.total) {
    createCEOReviewTask(phase)
  }
}
