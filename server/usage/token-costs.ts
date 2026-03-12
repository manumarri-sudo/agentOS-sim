import { getDb } from '../db/database'

// ---------------------------------------------------------------------------
// Token Cost Calculator
//
// Uses ACTUAL token counts from Claude CLI --output-format json response.
// Pricing from https://docs.anthropic.com/en/docs/about-claude/pricing
// Last verified: 2026-03-11
// ---------------------------------------------------------------------------

// API-equivalent pricing per million tokens (USD)
// Even on Claude Max (subscription), we track equivalent API cost
// so we know the real resource consumption per agent.
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  // Anthropic models
  haiku: {
    input: 1.00,      // $1.00 / MTok
    output: 5.00,     // $5.00 / MTok
    cacheWrite: 1.25, // 1.25x input = $1.25 / MTok
    cacheRead: 0.10,  // 0.1x input = $0.10 / MTok
  },
  sonnet: {
    input: 3.00,      // $3.00 / MTok
    output: 15.00,    // $15.00 / MTok
    cacheWrite: 3.75, // 1.25x input = $3.75 / MTok
    cacheRead: 0.30,  // 0.1x input = $0.30 / MTok
  },
  opus: {
    input: 5.00,      // $5.00 / MTok
    output: 25.00,    // $25.00 / MTok
    cacheWrite: 6.25, // 1.25x input = $6.25 / MTok
    cacheRead: 0.50,  // 0.1x input = $0.50 / MTok
  },
  // OpenAI models (used when provider = 'openai')
  'gpt-4.1-mini': {
    input: 0.40,      // $0.40 / MTok
    output: 1.60,     // $1.60 / MTok
    cacheWrite: 0.40,
    cacheRead: 0.10,
  },
  'gpt-4.1': {
    input: 2.00,      // $2.00 / MTok
    output: 8.00,     // $8.00 / MTok
    cacheWrite: 2.00,
    cacheRead: 0.50,
  },
  'o3': {
    input: 2.00,      // $2.00 / MTok (input)
    output: 8.00,     // $8.00 / MTok (output)
    cacheWrite: 2.00,
    cacheRead: 0.50,
  },
  'o4-mini': {
    input: 1.10,      // $1.10 / MTok
    output: 4.40,     // $4.40 / MTok
    cacheWrite: 1.10,
    cacheRead: 0.28,
  },
  // Codex CLI models (same pricing as OpenAI API equivalents, but billed through subscription)
  // Tracked here for equivalent-cost accounting even though subscription covers actual cost
  'codex-o4-mini': {
    input: 1.10,
    output: 4.40,
    cacheWrite: 1.10,
    cacheRead: 0.28,
  },
  'codex-o3': {
    input: 2.00,
    output: 8.00,
    cacheWrite: 2.00,
    cacheRead: 0.50,
  },
}

// ---------------------------------------------------------------------------
// Parse Claude CLI JSON response and extract usage
// ---------------------------------------------------------------------------
export interface CLIUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
}

export interface CLIJsonResponse {
  // --print --output-format json returns { result: string, usage: {...}, ... }
  result?: string
  // Some versions return content blocks instead
  content?: { type: string; text: string }[]
  totalTokens?: number
  usage?: CLIUsage
  total_cost_usd?: number
  duration_ms?: number
  type?: string
}

export function parseCliJsonResponse(raw: string): { text: string; usage: CLIUsage; totalTokens: number } | null {
  try {
    const parsed: CLIJsonResponse = JSON.parse(raw)

    // Claude CLI --print --output-format json returns { result: "...", usage: {...} }
    let text = ''

    if (parsed.result && typeof parsed.result === 'string') {
      // New format: direct result string
      text = parsed.result
    } else if (parsed.content && Array.isArray(parsed.content)) {
      // Legacy format: content blocks
      text = parsed.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')
    }

    return {
      text,
      usage: parsed.usage ?? { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      totalTokens: parsed.totalTokens ?? (parsed.usage ? (parsed.usage.input_tokens + parsed.usage.output_tokens) : 0),
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Compute cost from actual token counts
// ---------------------------------------------------------------------------
export function computeCost(model: string, usage: CLIUsage): {
  costInput: number
  costOutput: number
  costCacheWrite: number
  costCacheRead: number
  costTotal: number
} {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING.haiku

  const costInput = (usage.input_tokens / 1_000_000) * pricing.input
  const costOutput = (usage.output_tokens / 1_000_000) * pricing.output
  const costCacheWrite = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * pricing.cacheWrite
  const costCacheRead = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * pricing.cacheRead
  const costTotal = costInput + costOutput + costCacheWrite + costCacheRead

  return { costInput, costOutput, costCacheWrite, costCacheRead, costTotal }
}

// ---------------------------------------------------------------------------
// Record token usage to DB
// ---------------------------------------------------------------------------
export function recordTokenUsage(params: {
  taskId: string
  agentId: string
  model: string
  usage: CLIUsage
  durationMs: number
  phase: number
  source: 'actual' | 'estimated'
}): void {
  const db = getDb()
  const costs = computeCost(params.model, params.usage)
  const totalTokens = params.usage.input_tokens + params.usage.output_tokens +
    (params.usage.cache_creation_input_tokens ?? 0) + (params.usage.cache_read_input_tokens ?? 0)

  try {
    db.run(`
      INSERT INTO token_usage (id, task_id, agent_id, model, input_tokens, output_tokens,
        cache_creation_tokens, cache_read_tokens, total_tokens,
        cost_input_usd, cost_output_usd, cost_cache_write_usd, cost_cache_read_usd, cost_total_usd,
        duration_ms, phase, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      crypto.randomUUID(),
      params.taskId,
      params.agentId,
      params.model,
      params.usage.input_tokens,
      params.usage.output_tokens,
      params.usage.cache_creation_input_tokens ?? 0,
      params.usage.cache_read_input_tokens ?? 0,
      totalTokens,
      costs.costInput,
      costs.costOutput,
      costs.costCacheWrite,
      costs.costCacheRead,
      costs.costTotal,
      params.durationMs,
      params.phase,
      params.source,
    ])
  } catch (e) {
    console.error('[TOKEN] Failed to record token usage:', e)
  }
}

// ---------------------------------------------------------------------------
// Query: per-agent cost breakdown
// ---------------------------------------------------------------------------
export function getPerAgentCosts(): any[] {
  const db = getDb()
  try {
    return db.query(`
      SELECT
        tu.agent_id,
        ag.personality_name,
        ag.team,
        ag.role,
        tu.model,
        COUNT(*) as task_count,
        SUM(tu.input_tokens) as total_input_tokens,
        SUM(tu.output_tokens) as total_output_tokens,
        SUM(tu.cache_creation_tokens) as total_cache_write_tokens,
        SUM(tu.cache_read_tokens) as total_cache_read_tokens,
        SUM(tu.total_tokens) as total_tokens,
        SUM(tu.cost_input_usd) as total_cost_input,
        SUM(tu.cost_output_usd) as total_cost_output,
        SUM(tu.cost_cache_write_usd) as total_cost_cache_write,
        SUM(tu.cost_cache_read_usd) as total_cost_cache_read,
        SUM(tu.cost_total_usd) as total_cost,
        AVG(tu.duration_ms) as avg_duration_ms,
        SUM(tu.duration_ms) as total_duration_ms,
        SUM(CASE WHEN tu.source = 'actual' THEN 1 ELSE 0 END) as actual_count,
        SUM(CASE WHEN tu.source = 'estimated' THEN 1 ELSE 0 END) as estimated_count
      FROM token_usage tu
      JOIN agents ag ON ag.id = tu.agent_id
      GROUP BY tu.agent_id, tu.model
      ORDER BY total_cost DESC
    `).all()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Query: per-team cost breakdown
// ---------------------------------------------------------------------------
export function getPerTeamCosts(): any[] {
  const db = getDb()
  try {
    return db.query(`
      SELECT
        ag.team,
        COUNT(*) as task_count,
        SUM(tu.total_tokens) as total_tokens,
        SUM(tu.cost_total_usd) as total_cost,
        SUM(tu.input_tokens) as total_input_tokens,
        SUM(tu.output_tokens) as total_output_tokens
      FROM token_usage tu
      JOIN agents ag ON ag.id = tu.agent_id
      GROUP BY ag.team
      ORDER BY total_cost DESC
    `).all()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Query: per-phase cost breakdown
// ---------------------------------------------------------------------------
export function getPerPhaseCosts(): any[] {
  const db = getDb()
  try {
    return db.query(`
      SELECT
        tu.phase,
        COUNT(*) as task_count,
        SUM(tu.total_tokens) as total_tokens,
        SUM(tu.cost_total_usd) as total_cost
      FROM token_usage tu
      GROUP BY tu.phase
      ORDER BY tu.phase
    `).all()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Query: experiment totals
// ---------------------------------------------------------------------------
export function getTokenCostTotals(): any {
  const db = getDb()
  try {
    const totals = db.query(`
      SELECT
        COUNT(*) as total_tasks,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens,
        SUM(total_tokens) as total_tokens,
        SUM(cost_total_usd) as total_cost,
        SUM(cost_input_usd) as total_cost_input,
        SUM(cost_output_usd) as total_cost_output,
        SUM(cost_cache_write_usd) as total_cost_cache_write,
        SUM(cost_cache_read_usd) as total_cost_cache_read,
        SUM(duration_ms) as total_duration_ms,
        SUM(CASE WHEN source = 'actual' THEN 1 ELSE 0 END) as actual_count,
        SUM(CASE WHEN source = 'estimated' THEN 1 ELSE 0 END) as estimated_count
      FROM token_usage
    `).get() as any

    return totals ?? {
      total_tasks: 0, total_input_tokens: 0, total_output_tokens: 0,
      total_tokens: 0, total_cost: 0, total_cost_input: 0, total_cost_output: 0,
      total_cost_cache_write: 0, total_cost_cache_read: 0, total_duration_ms: 0,
      actual_count: 0, estimated_count: 0,
    }
  } catch {
    return {
      total_tasks: 0, total_input_tokens: 0, total_output_tokens: 0,
      total_tokens: 0, total_cost: 0, actual_count: 0, estimated_count: 0,
    }
  }
}
