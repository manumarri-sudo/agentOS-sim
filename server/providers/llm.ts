// ---------------------------------------------------------------------------
// LLM Provider Abstraction — Per-Agent Provider Assignment
//
// Each agent can run on a different provider. Supports:
//   1. "claude" — spawns Claude Code CLI (default, uses Claude Max subscription)
//   2. "openai" — calls OpenAI API directly (pay-per-token)
//   3. "codex" — spawns Codex CLI (uses ChatGPT Pro/Plus subscription credits)
//
// Per-agent assignment stored in DB (agents.llm_provider column).
// Global default set via ENV: LLM_PROVIDER=claude|openai
//
// API:
//   GET  /api/provider                    — get global + per-agent config
//   POST /api/provider                    — set global default { provider: "openai" }
//   POST /api/provider/:agentId           — set per-agent { provider: "openai" }
//   POST /api/provider/bulk               — set multiple { agents: ["kai","sol"], provider: "openai" }
//   POST /api/provider/team/:team         — set whole team { provider: "openai" }
// ---------------------------------------------------------------------------

import { getDb } from '../db/database'

export type LLMProvider = 'claude' | 'openai' | 'codex'

// Runtime state — globalThis survives hot reload
const _state = (globalThis as any).__llmProviderState ??= {
  globalDefault: (process.env.LLM_PROVIDER as LLMProvider) || 'claude',
  perAgent: new Map<string, LLMProvider>(),  // in-memory cache, DB is source of truth
}

// ---------------------------------------------------------------------------
// Ensure DB column exists (idempotent migration)
// ---------------------------------------------------------------------------
export function ensureProviderColumn(): void {
  const db = getDb()
  try {
    db.run(`ALTER TABLE agents ADD COLUMN llm_provider TEXT DEFAULT NULL`)
    console.log('[PROVIDER] Added llm_provider column to agents table')
  } catch {
    // Column already exists
  }
  // Load existing overrides into memory cache
  const rows = db.query(`SELECT id, llm_provider FROM agents WHERE llm_provider IS NOT NULL`).all() as { id: string; llm_provider: string }[]
  for (const row of rows) {
    _state.perAgent.set(row.id, row.llm_provider as LLMProvider)
  }
}

// ---------------------------------------------------------------------------
// Provider resolution — per-agent > global default
// ---------------------------------------------------------------------------
export function getGlobalProvider(): LLMProvider {
  return _state.globalDefault
}

export function setGlobalProvider(p: LLMProvider): void {
  _state.globalDefault = p
  console.log(`[PROVIDER] Global default switched to: ${p}`)
}

export function getAgentProvider(agentId: string): LLMProvider {
  return _state.perAgent.get(agentId) ?? _state.globalDefault
}

export function setAgentProvider(agentId: string, provider: LLMProvider | null): void {
  const db = getDb()
  if (provider === null) {
    // Clear override -- agent falls back to global default
    _state.perAgent.delete(agentId)
    db.run(`UPDATE agents SET llm_provider = NULL WHERE id = ?`, [agentId])
    console.log(`[PROVIDER] ${agentId}: cleared override, using global (${_state.globalDefault})`)
  } else {
    _state.perAgent.set(agentId, provider)
    db.run(`UPDATE agents SET llm_provider = ? WHERE id = ?`, [provider, agentId])
    console.log(`[PROVIDER] ${agentId}: set to ${provider}`)
  }
}

export function setTeamProvider(team: string, provider: LLMProvider): void {
  const db = getDb()
  const agents = db.query(`SELECT id FROM agents WHERE team = ?`).all(team) as { id: string }[]
  for (const agent of agents) {
    setAgentProvider(agent.id, provider)
  }
  console.log(`[PROVIDER] Team ${team} (${agents.length} agents): set to ${provider}`)
}

export function getProviderConfig(): {
  globalDefault: LLMProvider
  perAgent: Record<string, LLMProvider>
  openaiConfigured: boolean
  codexInstalled: boolean
} {
  // Check if codex CLI is available
  let codexInstalled = false
  try {
    const check = Bun.spawnSync(['which', 'codex'], { stdout: 'pipe', stderr: 'pipe' })
    codexInstalled = check.exitCode === 0
  } catch { /* not installed */ }

  return {
    globalDefault: _state.globalDefault,
    perAgent: Object.fromEntries(_state.perAgent),
    openaiConfigured: !!process.env.OPENAI_API_KEY,
    codexInstalled,
  }
}

// ---------------------------------------------------------------------------
// Model mapping — translate internal model names to provider-specific IDs
// ---------------------------------------------------------------------------
const CLAUDE_MODELS: Record<string, string> = {
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
}

const OPENAI_MODELS: Record<string, string> = {
  haiku: 'gpt-4.1-mini',      // cost-equivalent to haiku
  sonnet: 'gpt-4.1',          // cost-equivalent to sonnet
  opus: 'o3',                  // reasoning-equivalent to opus
}

// Codex CLI uses the same OpenAI model IDs but billed through ChatGPT subscription
const CODEX_MODELS: Record<string, string> = {
  haiku: 'o4-mini',            // fast + cheap on subscription
  sonnet: 'o3',                // strong reasoning
  opus: 'o3',                  // strongest available
}

export function resolveProviderModel(internalModel: string, provider: LLMProvider): string {
  if (provider === 'openai') {
    return OPENAI_MODELS[internalModel] ?? 'gpt-4.1-mini'
  }
  if (provider === 'codex') {
    return CODEX_MODELS[internalModel] ?? 'o4-mini'
  }
  return CLAUDE_MODELS[internalModel] ?? 'haiku'
}

// ---------------------------------------------------------------------------
// OpenAI API completion — direct HTTP call (no SDK dependency)
// ---------------------------------------------------------------------------
export interface LLMResult {
  text: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number | null
    cache_read_input_tokens: number | null
  }
  durationMs: number
  provider: LLMProvider
  model: string
}

export async function callOpenAI(params: {
  systemPrompt: string
  userMessage: string
  model: string
  cwd?: string
}): Promise<LLMResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set. Add it to .env to use OpenAI provider.')
  }

  const providerModel = OPENAI_MODELS[params.model] ?? 'gpt-4.1-mini'
  const start = Date.now()

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: providerModel,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userMessage },
      ],
      max_tokens: 16384,
      temperature: 0.7,
    }),
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenAI API error (${response.status}): ${err.slice(0, 500)}`)
  }

  const data = await response.json() as any
  const durationMs = Date.now() - start

  const text = data.choices?.[0]?.message?.content ?? ''
  const usage = data.usage ?? {}

  return {
    text,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
    durationMs,
    provider: 'openai',
    model: providerModel,
  }
}

// ---------------------------------------------------------------------------
// Claude CLI spawn — wraps Bun.spawn into the same LLMResult interface
// ---------------------------------------------------------------------------
export function spawnClaudeCLI(params: {
  systemPrompt: string
  userMessage: string
  model: string
  cwd: string
  env: Record<string, string | undefined>
  onChunk?: (chunk: string) => void
}): {
  proc: ReturnType<typeof Bun.spawn>
  result: Promise<LLMResult>
} {
  const start = Date.now()

  const proc = Bun.spawn([
    '/opt/homebrew/bin/claude',
    '--print',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--system-prompt', params.systemPrompt,
    '--model', params.model,
    params.userMessage,
  ], {
    cwd: params.cwd,
    env: (() => {
      const env = { ...params.env }
      delete env.CLAUDECODE
      delete env.CLAUDE_CODE_ENTRY_POINT
      delete env.CLAUDE_CODE_SESSION_ID
      return {
        ...env,
        PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
      }
    })(),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const result = new Promise<LLMResult>(async (resolve, reject) => {
    let rawStdout = ''
    const decoder = new TextDecoder()

    const reader = proc.stdout.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value)
        rawStdout += chunk
        params.onChunk?.(chunk)
      }
    } catch { /* stream ended */ }

    let stderr = ''
    const errReader = proc.stderr.getReader()
    try {
      while (true) {
        const { done, value } = await errReader.read()
        if (done) break
        stderr += decoder.decode(value)
      }
    } catch { /* stream ended */ }

    const code = await proc.exited
    const durationMs = Date.now() - start

    if (code !== 0) {
      reject(new Error(`Claude CLI exit ${code}: ${stderr.slice(0, 500)}`))
      return
    }

    let text = rawStdout
    let usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null as number | null, cache_read_input_tokens: null as number | null }

    try {
      const parsed = JSON.parse(rawStdout)
      if (parsed.result && typeof parsed.result === 'string') {
        text = parsed.result
      } else if (parsed.content && Array.isArray(parsed.content)) {
        text = parsed.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      }
      if (parsed.usage) {
        usage = {
          input_tokens: parsed.usage.input_tokens ?? 0,
          output_tokens: parsed.usage.output_tokens ?? 0,
          cache_creation_input_tokens: parsed.usage.cache_creation_input_tokens ?? null,
          cache_read_input_tokens: parsed.usage.cache_read_input_tokens ?? null,
        }
      }
    } catch {
      usage = {
        input_tokens: Math.ceil((params.systemPrompt.length + params.userMessage.length) / 4),
        output_tokens: Math.ceil(text.length / 4),
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      }
    }

    resolve({ text, usage, durationMs, provider: 'claude', model: params.model })
  })

  return { proc, result }
}

// ---------------------------------------------------------------------------
// Codex CLI spawn — uses ChatGPT Pro/Plus subscription credits
//
// codex exec --json --dangerously-bypass-approvals-and-sandbox -m <model> -C <cwd> "<prompt>"
// JSONL output: each line is an event { type: "message", ... }
// The last message event contains the agent's final response.
// ---------------------------------------------------------------------------
export function spawnCodexCLI(params: {
  systemPrompt: string
  userMessage: string
  model: string
  cwd: string
  env: Record<string, string | undefined>
  onChunk?: (chunk: string) => void
}): {
  proc: ReturnType<typeof Bun.spawn>
  result: Promise<LLMResult>
} {
  const start = Date.now()
  const codexModel = CODEX_MODELS[params.model] ?? 'o4-mini'

  // Codex doesn't have a separate --system-prompt flag.
  // We prepend the system prompt to the user message.
  const fullPrompt = `<system>\n${params.systemPrompt}\n</system>\n\n${params.userMessage}`

  // Write prompt to a temp file to avoid shell escaping issues with long prompts
  const promptPath = `/tmp/codex-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  Bun.spawnSync(['bash', '-c', `cat > ${promptPath}`], {
    stdin: new TextEncoder().encode(fullPrompt),
  })

  // -o captures the last message to a file (reliable extraction)
  const outputPath = `/tmp/codex-output-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`

  const proc = Bun.spawn([
    '/opt/homebrew/bin/codex',
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m', codexModel,
    '-C', params.cwd,
    '-o', outputPath,
    '-',  // read prompt from stdin
  ], {
    cwd: params.cwd,
    env: {
      ...params.env,
      PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`,
    },
    stdin: Bun.file(promptPath),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const result = new Promise<LLMResult>(async (resolve, reject) => {
    let rawStdout = ''
    const decoder = new TextDecoder()

    // Stream JSONL events from stdout
    const reader = proc.stdout.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value)
        rawStdout += chunk
        // Extract text content from JSONL events for live streaming
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.type === 'message' && event.content) {
              params.onChunk?.(typeof event.content === 'string' ? event.content : JSON.stringify(event.content))
            }
          } catch { /* not valid JSON line */ }
        }
      }
    } catch { /* stream ended */ }

    // Collect stderr
    let stderr = ''
    const errReader = proc.stderr.getReader()
    try {
      while (true) {
        const { done, value } = await errReader.read()
        if (done) break
        stderr += decoder.decode(value)
      }
    } catch { /* stream ended */ }

    const code = await proc.exited
    const durationMs = Date.now() - start

    // Clean up temp files
    try { Bun.spawnSync(['rm', '-f', promptPath]) } catch { /* ignore */ }

    if (code !== 0) {
      try { Bun.spawnSync(['rm', '-f', outputPath]) } catch { /* ignore */ }
      reject(new Error(`Codex CLI exit ${code}: ${stderr.slice(0, 500)}`))
      return
    }

    // Read the output file (-o flag captures last message cleanly)
    let text = ''
    try {
      text = await Bun.file(outputPath).text()
    } catch {
      // Fallback: parse JSONL for the last message event
      const lines = rawStdout.trim().split('\n').reverse()
      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          if (event.type === 'message' || event.message) {
            text = event.content ?? event.message ?? ''
            if (typeof text !== 'string') text = JSON.stringify(text)
            break
          }
        } catch { /* skip */ }
      }
    }

    // Clean up output file
    try { Bun.spawnSync(['rm', '-f', outputPath]) } catch { /* ignore */ }

    // Codex doesn't report token usage in CLI output -- estimate from text length
    const usage = {
      input_tokens: Math.ceil((params.systemPrompt.length + params.userMessage.length) / 4),
      output_tokens: Math.ceil(text.length / 4),
      cache_creation_input_tokens: null as number | null,
      cache_read_input_tokens: null as number | null,
    }

    resolve({ text, usage, durationMs, provider: 'codex', model: codexModel })
  })

  return { proc, result }
}
