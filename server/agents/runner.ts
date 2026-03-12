import { getDb } from '../db/database'
import { buildAgentPrompt } from './prompts'
import { buildContextFile, updateAgentMemory, getCitedAgents, clearCitedAgents, getLearnedRules, saveLearnedRule, parseGeneralizedRules } from './memory'
import { AGENTS, resolveModel } from './registry'
import { broadcastAGUI } from '../orchestrator'
import { sendMessage, broadcastMessage } from '../messages/bus'
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
import { overrideDailyCap, recordSpend } from '../budget/enforcer'
import { parseHumanTaskSignals } from '../human-tasks'
import { logChangelog } from '../changelog'
import { checkCitationRateLimit, incrementCitationCount, adjustCitationWeight } from '../reward/citation-limiter'
import { getAgentProvider, spawnClaudeCLI, spawnCodexCLI, callOpenAI, type LLMResult } from '../providers/llm'

// ---------------------------------------------------------------------------
// Agent Runner — doc 7 Patch A (CORRECTED spawn format)
// + Retry logic from doc 6 Issue 9
// ---------------------------------------------------------------------------

const PRODUCT_REPO_PATH = process.env.PRODUCT_REPO_PATH ?? `${process.env.HOME}/experiment-product`
const COS_AGENT_ID = 'priya'
const CEO_AGENT_ID = 'reza'
const MAX_RETRIES = 3
const MAX_ESCALATION = 5  // Hard limit before exec escalation

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
  let prompt = buildAgentPrompt(agentConfig)

  // Reflexion: inject learned rules from past failures (capped at 10 most recent)
  const rules = getLearnedRules(agent.id).slice(-10)
  if (rules.length > 0) {
    prompt += `\n\n### LESSONS FROM PAST FAILURES (${rules.length} most recent)\nThese rules were extracted from your own post-mortem analyses. Violating them will result in repeated failure.\n`
    for (let i = 0; i < rules.length; i++) {
      prompt += `- ${rules[i]}\n`
    }
  }

  return prompt
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
    agent.id,
    task.id
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
  const provider = getAgentProvider(agent.id)

  // Read context file content to append to task description
  const contextContent = await Bun.file(contextFile).text()

  // ROI-Driven Prompt Injection -- if burn is high and revenue is zero,
  // inject urgency override for revenue-critical agents
  const urgencyOverride = shouldInjectUrgencyOverride(agent.id)
  const fullTaskDescription = urgencyOverride
    ? `${urgencyOverride}${task.description}\n\n--- CONTEXT ---\n${contextContent}`
    : `${task.description}\n\n--- CONTEXT ---\n${contextContent}`

  const systemPrompt = buildSystemPrompt(agent)

  console.log(`[RUNNER] Spawned ${agent.personality_name} (${model}/${provider}) for task ${task.id}: ${task.description.slice(0, 80)}...`)

  // ---------------------------------------------------------------------------
  // Provider dispatch — Claude CLI, Codex CLI, or OpenAI API
  // ---------------------------------------------------------------------------
  const agentEnv = {
    ...process.env,
    AGENT_ID: agent.id,
    AGENT_TOKEN: `agent-${agent.id}-${task.id}`,
    PHASE: String(task.phase),
    CONTEXT_FILE: contextFile,
  }

  const onChunk = (chunk: string) => {
    broadcastAGUI({
      type: 'TEXT_MESSAGE_CONTENT',
      agentId: agent.id,
      agentName: agent.personality_name,
      taskId: task.id,
      content: chunk,
    })
  }

  const onSuccess = async (llmResult: LLMResult) => {
    activeProcesses.delete(agent.id)
    try { unlinkSync(contextFile) } catch { /* ignore */ }
    await handleLLMResult(agent, task, model, llmResult, fullTaskDescription, systemPrompt)
  }

  const onError = async (err: Error) => {
    activeProcesses.delete(agent.id)
    try { unlinkSync(contextFile) } catch { /* ignore */ }
    console.error(`[RUNNER] ${provider} error for ${agent.personality_name}: ${err.message}`)
    const exitCode = err.message?.match(/exit (\d+)/)?.[1] ?? 1
    await handleTaskFailure(agent, task, Number(exitCode), err.message)
  }

  if (provider === 'openai') {
    // OpenAI API path: async API call, no subprocess
    activeProcesses.set(agent.id, { proc: null as any, taskId: task.id })
    callOpenAI({ systemPrompt, userMessage: fullTaskDescription, model, cwd: PRODUCT_REPO_PATH })
      .then(onSuccess).catch(onError)

  } else if (provider === 'codex') {
    // Codex CLI path: subprocess, uses ChatGPT subscription
    const { proc, result: codexResult } = spawnCodexCLI({
      systemPrompt, userMessage: fullTaskDescription, model,
      cwd: PRODUCT_REPO_PATH, env: agentEnv, onChunk,
    })
    activeProcesses.set(agent.id, { proc, taskId: task.id })
    codexResult.then(onSuccess).catch(onError)

  } else {
    // Claude CLI path: subprocess with streaming (default)
    const { proc, result: cliResult } = spawnClaudeCLI({
      systemPrompt, userMessage: fullTaskDescription, model,
      cwd: PRODUCT_REPO_PATH, env: agentEnv, onChunk,
    })
    activeProcesses.set(agent.id, { proc, taskId: task.id })
    cliResult.then(onSuccess).catch(onError)
  }
}

// ---------------------------------------------------------------------------
// Unified post-LLM handler — same logic for both providers
// ---------------------------------------------------------------------------
async function handleLLMResult(
  agent: { id: string; personality_name: string; team: string; role: string },
  task: { id: string; description: string; phase: number; type: string },
  model: string,
  llmResult: LLMResult,
  fullTaskDescription: string,
  systemPrompt: string,
): Promise<void> {
  const db = getDb()
  const stdout = llmResult.text
  const durationMs = llmResult.durationMs
  const resolvedModel = llmResult.model ?? model

  // Log diagnostic if output is empty
  if (!stdout || stdout.length === 0) {
    console.error(`[RUNNER] ${agent.personality_name} (${llmResult.provider}) returned EMPTY output`)
  }

  // Record token usage
  recordTokenUsage({
    taskId: task.id,
    agentId: agent.id,
    model: resolvedModel,
    usage: llmResult.usage,
    durationMs,
    phase: task.phase,
    source: llmResult.usage.input_tokens > 0 ? 'actual' : 'estimated',
  })
  console.log(`[TOKENS] ${agent.personality_name}: ${llmResult.usage.input_tokens} in / ${llmResult.usage.output_tokens} out (${resolvedModel}/${llmResult.provider})`)

  // Set to proposed_complete -- verifier decides final status
  db.run(
    `UPDATE actions SET status = 'proposed_complete', output = ? WHERE id = ?`,
    [stdout, task.id]
  )

  // Run verifier
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

    await updateAgentMemory(agent.personality_name, {
      description: task.description,
      phase: task.phase,
      output: stdout,
    })

    recordQuorumContribution(agent.id, agent.team, task.id, task.phase)

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

    recordTaskUsage({
      agentId: agent.id,
      taskId: task.id,
      model: resolvedModel,
      durationMs,
    })

    console.log(`[RUNNER] ${agent.personality_name} completed task ${task.id} (${stdout.length} chars, ${llmResult.provider})`)

    onTaskCompleted(agent, task, stdout)
  } else {
    setAgentStatus(agent.id, 'idle')

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

    spawnPostMortemIfNeeded(agent, task, stdout, `Verification failed: ${result.failedCheck} — ${result.notes}`)
  }
}

// ---------------------------------------------------------------------------
// Retry logic — doc 6 Issue 9 + Dead End Recovery Protocol (Endurance Overhaul)
//
// Three phases:
//   Retries 1-3:  Re-queue with accumulated failure_context (mutated context)
//   Retries 4-5:  Continue with warning, urgent notify to CoS
//   After 5:      Escalate -- mark 'escalated', enqueue decide task for CoS
// ---------------------------------------------------------------------------
async function handleTaskFailure(
  agent: { id: string; personality_name: string; team: string; role: string },
  task: { id: string; description: string; phase: number; type: string },
  exitCode: number | null,
  stderr: string
): Promise<void> {
  const db = getDb()

  const action = db.query(`SELECT retry_count, failure_context FROM actions WHERE id = ?`).get(task.id) as {
    retry_count: number
    failure_context: string | null
  } | null

  const retryCount = action?.retry_count ?? 0

  // Accumulate failure context across all retries
  const prevContext = action?.failure_context ?? ''
  const newEntry = `[Attempt ${retryCount + 1}] Exit: ${exitCode}. Error: ${stderr.slice(0, 300)}`
  const accumulatedContext = prevContext ? `${prevContext}\n${newEntry}` : newEntry

  if (retryCount < MAX_ESCALATION) {
    const backoffMs = Math.pow(2, Math.min(retryCount, 3)) * 30_000 // cap backoff at 240s

    // Phase 1 (retries 1-3): standard retry with accumulated context
    // Phase 2 (retries 4-5): retry continues but with urgent warning
    const isUrgentPhase = retryCount >= MAX_RETRIES

    console.warn(
      `[RUNNER] Agent ${agent.personality_name} task ${task.id} failed (exit ${exitCode}, attempt ${retryCount + 1}/${MAX_ESCALATION}${isUrgentPhase ? ' URGENT' : ''}), ` +
      `retrying in ${backoffMs / 1000}s. Stderr: ${stderr.slice(0, 200)}`
    )

    // Update task: increment retry, re-queue with backoff timestamp
    // retry_after prevents the orchestrator from picking it up immediately
    const retryAfter = new Date(Date.now() + backoffMs).toISOString()
    db.run(
      `UPDATE actions SET retry_count = ?, status = 'queued', failure_context = ?, retry_after = ? WHERE id = ?`,
      [retryCount + 1, accumulatedContext, retryAfter, task.id]
    )
    setAgentStatus(agent.id, 'idle')

    broadcastAGUI({
      type: 'TASK_RETRY',
      agentId: agent.id,
      agentName: agent.personality_name,
      taskId: task.id,
      attempt: retryCount + 1,
      maxRetries: MAX_ESCALATION,
      backoffMs,
    })

    // Phase 2: send urgent notification to CoS on retries 4-5
    if (isUrgentPhase) {
      sendMessage({
        fromAgentId: 'system',
        toAgentId: COS_AGENT_ID,
        subject: `REPEATED FAILURE: ${agent.personality_name} task failing (attempt ${retryCount + 1}/${MAX_ESCALATION})`,
        body: `Task: ${task.description}\n\nThis task has failed ${retryCount + 1} times. Failure history:\n${accumulatedContext}\n\nWill escalate after ${MAX_ESCALATION} failures.`,
        priority: 'urgent',
      })
    }
  } else {
    // Phase 3: Max escalation reached -- escalate to exec
    db.run(
      `UPDATE actions SET status = 'escalated', output = ?, failure_context = ? WHERE id = ?`,
      [stderr, accumulatedContext, task.id]
    )
    setAgentStatus(agent.id, 'idle')

    // Enqueue a decide task for CoS (Priya) to triage
    const escalationId = crypto.randomUUID()
    const escalationDesc = `ESCALATED DEAD-END: ${agent.personality_name}'s task has failed ${MAX_ESCALATION} times.\n\nOriginal task: ${task.description}\n\nFailure history:\n${accumulatedContext}\n\nDecide: SCOPE-CUT (remove from backlog), REASSIGN (to a different agent), or ABANDON (mark as not achievable).`

    db.run(`
      INSERT INTO actions (id, agent_id, type, description, status, phase)
      VALUES (?, ?, 'decide', ?, 'queued', ?)
    `, [escalationId, COS_AGENT_ID, escalationDesc, task.phase])

    // Notify CEO
    sendMessage({
      fromAgentId: 'system',
      toAgentId: CEO_AGENT_ID,
      subject: `ESCALATION: ${agent.personality_name}'s task failed ${MAX_ESCALATION} times`,
      body: `A dead-end task has been escalated to Priya (CoS) for triage.\n\nTask: ${task.description}\nAgent: ${agent.personality_name}\nFailures: ${MAX_ESCALATION}`,
      priority: 'urgent',
    })

    // Notify CoS
    sendMessage({
      fromAgentId: 'system',
      toAgentId: COS_AGENT_ID,
      subject: `DEAD-END ESCALATION: ${agent.personality_name}'s task needs triage`,
      body: escalationDesc,
      priority: 'urgent',
    })

    // Log activity
    logActivity({
      agentId: agent.id,
      phase: task.phase,
      eventType: 'dead_end_escalated',
      summary: `${agent.personality_name}'s task escalated after ${MAX_ESCALATION} failures: ${task.description.slice(0, 80)}`,
    })

    // Reflexion: force post-mortem on escalated failures
    spawnPostMortemIfNeeded(agent, task, stderr, `Escalated dead-end: ${MAX_ESCALATION} consecutive failures. ${accumulatedContext.slice(0, 300)}`)

    broadcastAGUI({
      type: 'TASK_FAILED',
      agentId: agent.id,
      agentName: agent.personality_name,
      taskId: task.id,
      exitCode,
      error: `ESCALATED after ${MAX_ESCALATION} failures. Triage task created for CoS.`,
    })

    console.error(
      `[RUNNER] DEAD-END ESCALATED: ${agent.personality_name} task ${task.id} failed ${MAX_ESCALATION} times. Triage task created.`
    )
  }
}

// ---------------------------------------------------------------------------
// Reflexion: Forced Post-Mortem — "Never Again" Protocol
//
// When an agent has catastrophic failures (2+ verification fails or escalation),
// we freeze their normal queue and spawn a mandatory post-mortem task.
// The agent must produce <GENERALIZED_RULE> tags that get saved permanently.
// ---------------------------------------------------------------------------
function spawnPostMortemIfNeeded(
  agent: { id: string; personality_name: string; team: string; role: string },
  task: { id: string; description: string; phase: number; type: string },
  failedOutput: string,
  errorDescription: string
): void {
  const db = getDb()

  // Don't spawn post-mortem for post-mortem tasks (prevent infinite loop)
  if (task.description.includes('[POST-MORTEM]')) return

  // Check if agent already has a pending post-mortem
  const existingPM = db.query(`
    SELECT 1 FROM actions
    WHERE agent_id = ? AND description LIKE '%[POST-MORTEM]%' AND status IN ('queued', 'running')
  `).get(agent.id)
  if (existingPM) return

  // Check failure count: need 2+ verification failures or 1 escalation to trigger
  const recentFailures = db.query(`
    SELECT COUNT(*) as n FROM actions
    WHERE agent_id = ? AND phase = ?
      AND status IN ('verification_failed', 'failed', 'escalated')
      AND completed_at > datetime('now', '-4 hours')
  `).get(agent.id, task.phase) as { n: number }

  if (recentFailures.n < 2) return

  // Build the post-mortem prompt
  const outputPreview = failedOutput.slice(0, 1500)
  const pmDescription = `[POST-MORTEM] SYSTEM FAILURE DETECTED — MANDATORY ROOT CAUSE ANALYSIS

You attempted: ${task.description.slice(0, 300)}

It failed because: ${errorDescription}

Your failed output (excerpt):
---
${outputPreview}
---

You MUST perform a root cause analysis. Think deeply about WHY this failed — not just what went wrong, but what assumption or pattern led to the failure.

Then output one or more generalized rules wrapped in <GENERALIZED_RULE></GENERALIZED_RULE> tags. These rules will be permanently injected into your system prompt for every future task. Make them specific, actionable, and universally applicable.

Example:
<GENERALIZED_RULE>Always verify that referenced files exist by checking the filesystem before attempting to read or modify them. Never assume a file path is valid based on another agent's description.</GENERALIZED_RULE>

Do NOT output generic platitudes. Each rule must be a concrete, falsifiable directive that prevents THIS SPECIFIC failure from recurring.`

  // Freeze normal queue: mark queued tasks as deferred
  db.run(`
    UPDATE actions SET status = 'deferred'
    WHERE agent_id = ? AND status = 'queued' AND description NOT LIKE '%[POST-MORTEM]%'
  `, [agent.id])

  // Spawn priority post-mortem task (uses 'review' type which is allowed)
  enqueueTask({
    agentId: agent.id,
    type: 'review',
    description: pmDescription,
    phase: task.phase,
    priority: true,
  })

  logActivity({
    agentId: agent.id,
    phase: task.phase,
    eventType: 'post_mortem',
    summary: `${agent.personality_name} forced into post-mortem after ${recentFailures.n} failures`,
  })

  console.log(`[REFLEXION] Spawned post-mortem for ${agent.personality_name} (${recentFailures.n} recent failures)`)
}

// ---------------------------------------------------------------------------
// Handle post-mortem output: extract and save generalized rules
// Called from onTaskCompleted when the task is a post-mortem
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Resolve a debate -- extract ruling from Priya's output and record in agent_debates
// ---------------------------------------------------------------------------
function resolveDebateFromOutput(taskDescription: string, output: string): void {
  const db = getDb()

  // Extract debate ID from task description
  const debateIdMatch = taskDescription.match(/\[debate:([a-f0-9-]+)\]/)
  if (!debateIdMatch) return

  const debateId = debateIdMatch[1]

  // Extract ruling from [DECISION] tag in output (greedy capture until next signal tag or end)
  const decisionMatch = output.match(/\[DECISION\s+title:[^\]]*\]\s*([\s\S]+?)(?=\n\[(?:MSG|DECISION|BLOCKER|ESCALATE|HANDOFF)|$)/)
  const resolution = decisionMatch
    ? decisionMatch[1].trim().slice(0, 2000)
    : output.slice(0, 2000) // fallback: use full output as ruling if no DECISION tag

  db.run(`
    UPDATE agent_debates SET
      resolution = ?,
      resolved_by = 'priya',
      resolved_at = datetime('now')
    WHERE id = ?
  `, [resolution, debateId])

  console.log(`[DEBATE] Resolved debate ${debateId}: ${resolution.slice(0, 100)}...`)
}

function handlePostMortemOutput(agentId: string, taskId: string, output: string): void {
  const db = getDb()
  const rules = parseGeneralizedRules(output)

  if (rules.length === 0) {
    console.warn(`[REFLEXION] ${agentId} post-mortem produced no <GENERALIZED_RULE> tags`)
    return
  }

  // Find the triggering error from the task description
  const task = db.query(`SELECT description FROM actions WHERE id = ?`).get(taskId) as { description: string } | null
  const errorMatch = task?.description.match(/It failed because: (.+?)(?:\n|$)/)
  const triggeringError = errorMatch?.[1] ?? 'Unknown failure'

  for (const rule of rules) {
    saveLearnedRule({
      agentId,
      triggeringError,
      generalizedRule: rule,
      sourceTaskId: taskId,
    })
  }

  // Unfreeze deferred tasks now that post-mortem is done
  db.run(`
    UPDATE actions SET status = 'queued'
    WHERE agent_id = ? AND status = 'deferred'
  `, [agentId])

  console.log(`[REFLEXION] ${agentId} learned ${rules.length} rule(s) from post-mortem`)
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

  // [BLOCKER] — flag the agent as blocked (with phantom blocker suppression)
  const blockerMatch = output.match(/\[BLOCKER\]\s*(.+?)(?:\n|$)/g)
  if (blockerMatch) {
    // Suppress if agent already has completed work this phase (phantom blocker)
    const hasCompletions = db.query(`
      SELECT 1 FROM actions WHERE agent_id = ? AND phase = ? AND status = 'completed' LIMIT 1
    `).get(agent.id, task.phase)

    // Suppress if agent already has an active blocker (prevent duplicates)
    const alreadyBlocked = db.query(`
      SELECT 1 FROM blocked_agents WHERE agent_id = ? AND resolved_by IS NULL LIMIT 1
    `).get(agent.id)

    if (hasCompletions || alreadyBlocked) {
      console.log(`[SIGNAL] Suppressed phantom/duplicate blocker from ${agent.personality_name}`)
    } else {
      for (const match of blockerMatch) {
        const reason = match.replace(/\[BLOCKER\]\s*/, '').trim()
        reportBlocked(agent.id, reason)
        console.log(`[SIGNAL] ${agent.personality_name} flagged blocker: ${reason.slice(0, 80)}`)
      }
    }
  }

  // [RESOLVE_BLOCKER <id>] — resolve a blocker (from help tasks)
  const resolveBlockerMatch = output.match(/\[RESOLVE_BLOCKER\s+([a-f0-9-]+)\]/g)
  if (resolveBlockerMatch) {
    const { resolveBlocker } = require('../reward/blockers')
    for (const match of resolveBlockerMatch) {
      const blockerId = match.replace(/\[RESOLVE_BLOCKER\s+/, '').replace(']', '').trim()
      const result = resolveBlocker(blockerId, agent.id, output.slice(0, 500))
      if (result.resolved) {
        console.log(`[SIGNAL] ${agent.personality_name} resolved blocker ${blockerId}`)
      }
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

  // [MSG to:<id> priority:<level>] -- inter-agent message
  const msgPattern = /\[MSG\s+to:(\w+)\s+priority:(\w+)\]\s*(.+?)(?:\n|$)/g
  let msgMatch
  while ((msgMatch = msgPattern.exec(output)) !== null) {
    const [, toId, priority, body] = msgMatch
    if (toId === 'all') {
      // Broadcast to all agents
      broadcastMessage(
        agent.id,
        `Message from ${agent.personality_name}`,
        body.trim(),
        priority as any,
      )
      console.log(`[SIGNAL] ${agent.personality_name} -> ALL: ${body.trim().slice(0, 60)}`)
    } else {
      sendMessage({
        fromAgentId: agent.id,
        toAgentId: toId,
        subject: `Message from ${agent.personality_name}`,
        body: body.trim(),
        priority: priority as any,
      })
      console.log(`[SIGNAL] ${agent.personality_name} -> ${toId}: ${body.trim().slice(0, 60)}`)
    }
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
    const desc = description.trim()
    enqueueTask({
      agentId: forId,
      type: type as any,
      description: desc,
      phase: task.phase,
    })
    console.log(`[SIGNAL] ${agent.personality_name} requested task for ${forId}: ${desc.slice(0, 60)}`)
  }

  // [SPEND amount:<$> category:<cat>] — agent requests to spend budget
  // Format: [SPEND amount:50 category:ads] Description of what it buys
  const spendPattern = /\[SPEND\s+amount:(\d+(?:\.\d+)?)\s+category:(\w+)\]\s*(.+?)(?:\n|$)/g
  let spendMatch
  while ((spendMatch = spendPattern.exec(output)) !== null) {
    const [, amountStr, category, description] = spendMatch
    const amount = parseFloat(amountStr)

    if (isNaN(amount) || amount <= 0) continue

    // Only ops (Jordan) and exec (Alex, Reza) can directly spend
    // Other agents' spend requests get routed to Alex (CFO) for approval
    const canSpendDirectly = ['ops', 'exec'].includes(agent.team) || agent.id === 'alex'

    if (canSpendDirectly) {
      const result = recordSpend({
        agentId: agent.id,
        amount,
        category,
        phase: task.phase,
        notes: `${agent.personality_name}: ${description.trim().slice(0, 200)}`,
      })

      if (result.allowed) {
        console.log(`[SPEND] ${agent.personality_name} spent $${amount} on ${category}: ${description.trim().slice(0, 60)}`)
        // Notify CEO of spend
        try {
          db.run(`
            INSERT INTO ceo_chat (id, sender, message, message_type, phase, sim_day, read_by_human)
            VALUES (?, 'reza', ?, 'alert', ?, ?, 0)
          `, [crypto.randomUUID(), `[SPEND] ${agent.personality_name} spent $${amount} on ${category}: ${description.trim().slice(0, 200)}`, task.phase, getSimDay()])
        } catch { /* ceo_chat may not exist */ }
      } else {
        console.log(`[SPEND] ${agent.personality_name} spend DENIED: ${result.reason}`)
        sendMessage({
          fromAgentId: 'system',
          toAgentId: agent.id,
          subject: `Spend request denied`,
          body: `Your request to spend $${amount} on ${category} was denied: ${result.reason}`,
          priority: 'high',
        })
      }
    } else {
      // Route to Alex (CFO) for approval
      sendMessage({
        fromAgentId: agent.id,
        toAgentId: 'alex',
        subject: `SPEND REQUEST: $${amount} for ${category}`,
        body: `${agent.personality_name} requests $${amount} for ${category}.\n\nReason: ${description.trim()}\n\nTo approve, use [SPEND amount:${amount} category:${category}] in your output.`,
        priority: 'high',
      })
      // Also post to CEO chat
      try {
        db.run(`
          INSERT INTO ceo_chat (id, sender, message, message_type, phase, sim_day, read_by_human)
          VALUES (?, 'reza', ?, 'alert', ?, ?, 0)
        `, [crypto.randomUUID(), `[SPEND REQUEST] ${agent.personality_name} wants $${amount} for ${category}: ${description.trim().slice(0, 200)}`, task.phase, getSimDay()])
      } catch { /* ceo_chat may not exist */ }
      console.log(`[SPEND] ${agent.personality_name} spend request routed to Alex: $${amount} for ${category}`)
    }
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

      // Create a task for Jordan to evaluate and implement (with dedup)
      const proposalDesc = `PROCESS PROPOSAL from ${agent.personality_name}:\n\n${proposal.slice(0, 1500)}\n\nAs Ops Manager, evaluate this proposal:\n1. Is this worth implementing? Why or why not?\n2. What's the effort to adopt it?\n3. If yes — draft the new standard and use [MSG] to announce it to the team.\n4. If no — explain why and message ${agent.personality_name} with your reasoning.`
      enqueueTask({
        agentId: 'jordan',
        type: 'decide',
        description: proposalDesc,
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

  // [DECISION] — exec/strategy agents record formal decisions
  const decisionMatches = output.match(/\[DECISION(?:\s+title:([^\]]*))?\]\s*(.+?)(?=\n\[|$)/gs)
  if (decisionMatches && ['exec', 'strategy'].includes(agent.team)) {
    for (const match of decisionMatches) {
      const titleMatch = match.match(/\[DECISION(?:\s+title:([^\]]*))?\]/)
      const title = titleMatch?.[1]?.trim() || `Decision by ${agent.personality_name}`
      const body = match.replace(/\[DECISION[^\]]*\]\s*/, '').trim()

      try {
        db.run(`
          INSERT INTO decisions (id, made_by_agent, title, body, impact, status, phase, created_at)
          VALUES (?, ?, ?, ?, 'exec', 'approved', ?, datetime('now'))
        `, [crypto.randomUUID(), agent.id, title, body, task.phase])

        // Broadcast decision to all agents
        broadcastMessage(
          agent.id,
          `DECISION: ${title}`,
          `${agent.personality_name} has made a decision:\n\n${body.slice(0, 500)}`,
          'urgent',
        )

        logActivity({
          agentId: agent.id,
          phase: task.phase,
          eventType: 'decision_made',
          summary: `${agent.personality_name} decided: ${title}`,
        })

        console.log(`[SIGNAL] ${agent.personality_name} made decision: ${title}`)

        // Check for Cap Burst decisions (daily spend cap override)
        const capBurstMatch = title.match(/cap\s*burst\s*day\s*(\d+)/i)
        if (capBurstMatch) {
          const targetDay = parseInt(capBurstMatch[1], 10)
          try {
            overrideDailyCap(targetDay, crypto.randomUUID())
            console.log(`[BUDGET] Cap Burst activated for Sim Day ${targetDay} by ${agent.personality_name}`)
          } catch (e) {
            console.error(`[BUDGET] Cap Burst override failed:`, e)
          }
        }

        // Log to changelog for substack
        logChangelog({
          eventType: 'agent_decision',
          title: `${agent.personality_name}: ${title}`,
          details: body.slice(0, 500),
          agentId: agent.id,
          impact: `Decision made by ${agent.personality_name} affecting product direction`,
          phase: task.phase,
        })
      } catch (e) {
        console.error(`[SIGNAL] Decision insert failed:`, e)
      }
    }
  }

  // [PROPOSE_INITIATIVE] — agent proposes an internal tool/dashboard/system
  const initiativePattern = /\[PROPOSE_INITIATIVE\s+name:([^\]]+)\]\s*(?:\[RATIONALE\]\s*(.+?))?\s*(?:\[OWNER\]\s*(\w+))?\s*(?:\[SCOPE\]\s*(.+?))?(?=\n\[|---|\n##|$)/gs
  let initMatch
  while ((initMatch = initiativePattern.exec(output)) !== null) {
    const [, name, rationale, owner, scope] = initMatch
    const initiativeName = (name ?? '').trim()
    const initiativeRationale = (rationale ?? '').trim()
    const initiativeOwner = (owner ?? agent.id).trim()
    const initiativeScope = (scope ?? '').trim()

    try {
      const rfcId = crypto.randomUUID()
      db.run(`
        INSERT INTO decisions (id, made_by_agent, title, body, impact, status, phase, created_at)
        VALUES (?, ?, ?, ?, 'internal_initiative', 'proposed', ?, datetime('now'))
      `, [
        rfcId,
        agent.id,
        `[RFC] ${initiativeName}`,
        `Proposed by: ${agent.personality_name}\nRationale: ${initiativeRationale}\nOwner: ${initiativeOwner}\nScope: ${initiativeScope}`,
        task.phase,
      ])

      // Send RFC to Reza (CEO) and Alex (Finance) for review
      const rfcBody = `INTERNAL INITIATIVE RFC from ${agent.personality_name}:\n\n**Initiative:** ${initiativeName}\n**Rationale:** ${initiativeRationale}\n**Proposed Owner:** ${initiativeOwner}\n**Scope:** ${initiativeScope}\n\nReview this initiative. If it will save tokens, increase market trust, or speed up Phase completion, APPROVE it. You may allocate up to $15 from the contingency budget and 10,000 tokens to build it.\n\nTo approve, use: [DECISION title:APPROVE RFC ${initiativeName}] <your reasoning>\nTo reject, use: [DECISION title:REJECT RFC ${initiativeName}] <your reasoning>`

      enqueueTask({
        agentId: 'reza',
        type: 'decide',
        description: rfcBody,
        phase: task.phase,
      })
      enqueueTask({
        agentId: 'alex',
        type: 'decide',
        description: rfcBody,
        phase: task.phase,
      })

      // Post to CEO chat
      try {
        db.run(`
          INSERT INTO ceo_chat (id, sender, message, message_type, phase, sim_day, read_by_human)
          VALUES (?, 'reza', ?, 'alert', ?, ?, 0)
        `, [crypto.randomUUID(), `[RFC PROPOSED] ${initiativeName} by ${agent.personality_name}\n\n${initiativeRationale.slice(0, 300)}`, task.phase, getSimDay()])
      } catch { /* ceo_chat may not exist */ }

      logActivity({
        agentId: agent.id,
        phase: task.phase,
        eventType: 'initiative_proposed',
        summary: `${agent.personality_name} proposed initiative: ${initiativeName}`,
      })

      console.log(`[SIGNAL] ${agent.personality_name} proposed initiative: ${initiativeName}`)
    } catch (e) {
      console.error(`[SIGNAL] Initiative insert failed:`, e)
    }
  }

  // [HUMAN_TASK] — agent requests human intervention
  parseHumanTaskSignals(agent.id, output, task.phase)

  // [FEASIBILITY_CHECK] — technical feasibility assessment result
  const feasibilityMatch = output.match(/\[FEASIBILITY_CHECK\s+result:(pass|fail)\s+risk:(low|medium|high|blocker)\]/i)
  if (feasibilityMatch) {
    try {
      const { recordFeasibilityResult } = require('../governance/feasibility')
      const result = (feasibilityMatch[1] ?? 'pass').toLowerCase() as 'pass' | 'fail'
      const riskLevel = (feasibilityMatch[2] ?? 'medium').toLowerCase() as 'low' | 'medium' | 'high' | 'blocker'

      // Extract findings from surrounding text (up to 500 chars after the signal)
      const signalIdx = output.indexOf(feasibilityMatch[0])
      const findings = output.slice(signalIdx + feasibilityMatch[0].length, signalIdx + feasibilityMatch[0].length + 500).trim()

      recordFeasibilityResult(agent.id, task.id, result, findings || 'No detailed findings provided', riskLevel)
      console.log(`[SIGNAL] ${agent.personality_name} feasibility check: ${result} (risk: ${riskLevel})`)
    } catch (e) {
      console.error(`[SIGNAL] Feasibility check recording failed:`, e)
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

  // -2. Reflexion: if this was a post-mortem, extract and save rules
  if (task.description.includes('[POST-MORTEM]')) {
    handlePostMortemOutput(agent.id, task.id, output)
  }

  // -1. Parse structured signals from agent output ([BLOCKER], [ESCALATE], [MSG], etc.)
  parseAgentSignals(agent, task, output)

  // -0.5. Resolve debate if this was a facilitated discussion
  if (task.description.includes('[debate:') && task.type === 'meeting') {
    resolveDebateFromOutput(task.description, output)
  }

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

  // 1. Credit only agents whose work was ACTUALLY referenced in the output
  // Three-tier citation: full credit if output mentions cited agent by name,
  // half credit if context was provided but not explicitly referenced (phantom),
  // zero if rate-limited or over cap.
  const citedAgentIds = getCitedAgents(task.id)
  clearCitedAgents(task.id) // free memory

  if (citedAgentIds.length > 0) {
    const citedAgents = db.query(`
      SELECT id as agent_id, personality_name
      FROM agents WHERE id IN (${citedAgentIds.map(() => '?').join(',')})
    `).all(...citedAgentIds) as { agent_id: string; personality_name: string }[]

    const outputLower = output.toLowerCase()

    for (const cited of citedAgents) {
      if (!checkCitationRateLimit(cited.agent_id, task.phase)) {
        console.log(`[CITATION] Rate limit reached for ${cited.personality_name} in Phase ${task.phase}, skipping`)
        continue
      }

      // Phantom detection: did the citing agent actually reference this agent's work?
      const nameReferenced = outputLower.includes(cited.personality_name.toLowerCase())
      const referenceMultiplier = nameReferenced ? 1.0 : 0.25 // phantom = 75% penalty

      logActivity({
        agentId: agent.id,
        otherAgentId: cited.agent_id,
        phase: task.phase,
        eventType: nameReferenced ? 'used_work' : 'context_provided',
        summary: nameReferenced
          ? `${agent.personality_name} referenced ${cited.personality_name}'s work in their output`
          : `${cited.personality_name}'s work was in context but not explicitly referenced by ${agent.personality_name}`,
      })

      const baseWeight = adjustCitationWeight(cited.agent_id, task.phase)
      const finalWeight = Math.round(baseWeight * referenceMultiplier * 100) / 100
      if (finalWeight > 0) {
        logCollaborationEvent({
          fromAgentId: agent.id,
          toAgentId: cited.agent_id,
          eventType: nameReferenced ? 'output_cited' : 'context_only',
          actionId: task.id,
          phase: task.phase,
          weight: finalWeight,
        })
        incrementCitationCount(cited.agent_id, task.phase)
      }
    }
  }

  // 2. Notify Morgan (PM) about completed primary work — skip meta-work to save tokens
  const outputPreview = output.slice(0, 500) + (output.length > 500 ? '...' : '')

  if (!['review', 'meeting', 'chat'].includes(task.type)) {
    sendMessage({
      fromAgentId: agent.id,
      toAgentId: 'morgan',
      subject: `${agent.personality_name} completed: ${task.description.slice(0, 60)}`,
      body: `Task completed by ${agent.personality_name} (${agent.team} team).\n\nTask: ${task.description}\n\nOutput preview:\n${outputPreview}`,
      priority: 'normal',
    })

    logActivity({
      agentId: agent.id,
      otherAgentId: 'morgan',
      phase: task.phase,
      eventType: 'notified',
      summary: `${agent.personality_name} reported completion to Morgan (PM)`,
    })
  }

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

  // 3c. CFS recalc moved to orchestrator (every 10 cycles) to save compute

  // 3d. Cross-team reviews — only for primary work, NOT reviews/meetings/chat
  // This prevents the cascade: task → review → cross-review → review of cross-review → ...
  if (!['review', 'meeting', 'chat', 'decide'].includes(task.type)) {
    try {
      checkCrossReviews(agent, task, output)
    } catch (e) {
      console.error('[COLLAB] Cross-review check error:', e)
    }
  }

  // 4. Team lead review — only for research and build (high-value primary work)
  // Skip write, review, meeting, chat — reduces cascading meta-work
  if (['research', 'build'].includes(task.type)) {
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

  // Cap reviews: max 2 pending reviews per reviewer per phase
  const pendingReviewCount = db.query(`
    SELECT COUNT(*) as n FROM actions
    WHERE agent_id = ? AND type = 'review' AND phase = ? AND status IN ('queued', 'running')
  `).get(reviewerId, task.phase) as { n: number }
  if (pendingReviewCount.n >= 2) return

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

// ---------------------------------------------------------------------------
// ROI-Driven Prompt Injection -- Dual Mandate Revenue Engine
//
// When token cost > $50 and revenue = $0, inject urgency override into
// prompts for revenue-critical agents (CEO, Marketing, Tech PM, Revenue).
// ---------------------------------------------------------------------------
const URGENCY_AGENTS = new Set(['reza', 'sol', 'vera', 'amir', 'paz'])

function shouldInjectUrgencyOverride(agentId: string): string | null {
  if (!URGENCY_AGENTS.has(agentId)) return null

  const db = getDb()

  // Check if token cost exceeds threshold
  const tokenCost = db.query(
    `SELECT COALESCE(SUM(cost_total_usd), 0) as total FROM token_usage`
  ).get() as { total: number }

  if (tokenCost.total <= 50) return null

  // Check if revenue is zero
  const revenue = db.query(
    `SELECT COALESCE(SUM(amount), 0) as total FROM budget_entries WHERE amount > 0 AND notes NOT LIKE '%experiment_start%'`
  ).get() as { total: number }

  if (revenue.total > 0) return null

  // Log the injection for audit
  logActivity({
    agentId,
    phase: 0,
    eventType: 'urgency_override',
    summary: `ROI urgency override injected: $${tokenCost.total.toFixed(2)} spent, $0 revenue`,
  })

  return `\n--- URGENCY OVERRIDE ---\nThe experiment has consumed $${tokenCost.total.toFixed(2)} in API costs with ZERO revenue generated. Every task you complete from now on MUST have a direct line to generating the first dollar. Do not produce research, strategy documents, or internal reports. Produce ONLY work that directly enables a customer to pay us money. If your current task does not lead to revenue within 24 sim-hours, escalate immediately with [ESCALATE] and request reassignment to revenue-critical work.\n--- END OVERRIDE ---\n\n`
}
