import { getDb } from '../db/database'
import { getSimDay } from '../clock'

// ---------------------------------------------------------------------------
// End-of-Day Agent Summaries — CSV export + optional Notion push
//
// Generates per-agent summary rows at sim_day transitions.
// Output: logs/daily-summaries.csv (append-only)
// ---------------------------------------------------------------------------

const CSV_PATH = 'logs/daily-summaries.csv'
const HEADER = 'Date,Sim Day,Phase,Agent,Team,Role,Tasks Completed,Tasks Failed,Tasks Queued,Tokens Used,Budget Spent,Key Outputs,Blockers,Learned Rules'

// Track last sim_day we generated summaries for
let lastSummarizedDay = -1

/**
 * Check if we need to generate end-of-day summaries.
 * Called from orchestrator loop. Generates once per sim_day.
 */
export async function checkDailySummary(): Promise<void> {
  const simDay = getSimDay()
  if (simDay <= lastSummarizedDay) return

  // On first call, check if we already wrote for this day
  if (lastSummarizedDay === -1) {
    try {
      const existing = Bun.file(CSV_PATH)
      if (await existing.exists() && existing.size > 0) {
        const text = await existing.text()
        if (text.includes(`,${simDay},`)) {
          lastSummarizedDay = simDay
          return
        }
      }
    } catch {
      // File doesn't exist yet
    }
  }

  generateDailySummary(simDay)
  lastSummarizedDay = simDay
}

/**
 * Generate end-of-day CSV summary for all agents.
 */
export async function generateDailySummary(simDay?: number): Promise<void> {
  const db = getDb()
  const day = simDay ?? getSimDay()
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  // Get active phase
  const phase = db.query(`
    SELECT phase_number FROM experiment_phases WHERE status = 'active' LIMIT 1
  `).get() as { phase_number: number } | null
  const phaseNum = phase?.phase_number ?? 0

  // Get all agents
  const agents = db.query(`
    SELECT id, personality_name, team, role FROM agents ORDER BY team, personality_name
  `).all() as { id: string; personality_name: string; team: string; role: string }[]

  const rows: string[] = []

  for (const agent of agents) {
    // Task counts for this phase
    const stats = db.query(`
      SELECT status, COUNT(*) as n FROM actions
      WHERE agent_id = ? AND phase = ?
      GROUP BY status
    `).all(agent.id, phaseNum) as { status: string; n: number }[]

    const statMap: Record<string, number> = {}
    for (const s of stats) statMap[s.status] = s.n

    const completed = statMap['completed'] ?? 0
    const failed = (statMap['failed'] ?? 0) + (statMap['verification_failed'] ?? 0)
    const queued = statMap['queued'] ?? 0

    // Token usage
    const tokens = db.query(`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total_tokens,
             COALESCE(SUM(cost_total_usd), 0) as total_cost
      FROM token_usage WHERE agent_id = ?
    `).get(agent.id) as { total_tokens: number; total_cost: number }

    // Recent completed task outputs (last 3, truncated)
    const recentOutputs = db.query(`
      SELECT substr(description, 1, 80) as desc FROM actions
      WHERE agent_id = ? AND phase = ? AND status = 'completed'
      ORDER BY completed_at DESC LIMIT 3
    `).all(agent.id, phaseNum) as { desc: string }[]

    const keyOutputs = recentOutputs.map(o => o.desc.replace(/"/g, "'")).join('; ') || 'none'

    // Active blockers
    const blockers = db.query(`
      SELECT reason FROM blocked_agents
      WHERE agent_id = ? AND resolved_at IS NULL
    `).all(agent.id) as { reason: string }[]

    const blockerText = blockers.map(b => b.reason.slice(0, 60).replace(/"/g, "'")).join('; ') || 'none'

    // Learned rules from reflexion
    const rules = db.query(`
      SELECT generalized_rule FROM agent_memories WHERE agent_id = ?
    `).all(agent.id) as { generalized_rule: string }[]

    const rulesText = rules.map(r => r.generalized_rule.slice(0, 60).replace(/"/g, "'")).join('; ') || 'none'

    rows.push([
      `"${now}"`,
      day,
      phaseNum,
      `"${agent.personality_name}"`,
      `"${agent.team}"`,
      `"${agent.role.slice(0, 40)}"`,
      completed,
      failed,
      queued,
      tokens.total_tokens,
      `$${tokens.total_cost.toFixed(2)}`,
      `"${keyOutputs}"`,
      `"${blockerText}"`,
      `"${rulesText}"`,
    ].join(','))
  }

  // Write to CSV (append or create)
  let content = ''
  try {
    const file = Bun.file(CSV_PATH)
    if (await file.exists() && file.size > 0) {
      content = await file.text()
    }
  } catch {
    // New file
  }

  if (!content) {
    content = HEADER + '\n'
  }

  content += rows.join('\n') + '\n'
  Bun.write(CSV_PATH, content)

  console.log(`[SUMMARY] Daily summary generated — Day ${day}, ${rows.length} agents, saved to ${CSV_PATH}`)
}

/**
 * Push daily summary to Notion (if configured).
 */
export async function pushSummaryToNotion(simDay?: number): Promise<void> {
  try {
    const { syncDailySummaryToNotion } = await import('../notion/sync')
    const db = getDb()
    const day = simDay ?? getSimDay()

    const phase = db.query(`
      SELECT phase_number FROM experiment_phases WHERE status = 'active' LIMIT 1
    `).get() as { phase_number: number } | null

    const agents = db.query(`
      SELECT a.id, a.personality_name, a.team,
        (SELECT COUNT(*) FROM actions WHERE agent_id = a.id AND phase = ? AND status = 'completed') as completed,
        (SELECT COUNT(*) FROM actions WHERE agent_id = a.id AND phase = ? AND status IN ('failed', 'verification_failed')) as failed
      FROM agents a ORDER BY a.team
    `).all(phase?.phase_number ?? 0, phase?.phase_number ?? 0) as any[]

    const summary = agents
      .filter((a: any) => a.completed > 0 || a.failed > 0)
      .map((a: any) => `${a.personality_name} (${a.team}): ${a.completed} done, ${a.failed} failed`)
      .join('\n')

    await syncDailySummaryToNotion(day, summary)
    console.log(`[SUMMARY] Pushed Day ${day} summary to Notion`)
  } catch (e) {
    console.log(`[SUMMARY] Notion push skipped: ${e}`)
  }
}
