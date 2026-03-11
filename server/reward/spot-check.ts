import { getDb } from '../db/database'
import { getSimDay } from '../clock'
import { checkSpotCheckEscalation } from '../governance/observer'

// ---------------------------------------------------------------------------
// Hidden Spot Checks — Phase 5 Anti-Gaming
//
// Run on ~30% of completed actions (random sample).
// NOT disclosed to agents or visible in dashboard (hidden from ActivityFeed).
// Failures logged to governance.log, NOT shown to agent.
// 3+ failures of same type -> governance event escalated to dashboard.
// ---------------------------------------------------------------------------

export type SpotCheckType = 'content_depth' | 'output_trace' | 'commit_substance' | 'source_check'

interface SpotCheckResult {
  passed: boolean
  checkType: SpotCheckType
  details: string
}

// ---------------------------------------------------------------------------
// Should this action be spot-checked? (~30% random sample)
// ---------------------------------------------------------------------------
export function shouldSpotCheck(): boolean {
  return Math.random() < 0.3
}

// ---------------------------------------------------------------------------
// Run spot checks on a completed action
// ---------------------------------------------------------------------------
export function runSpotChecks(action: {
  id: string
  agent_id: string
  type: string
  output: string
  cited_sources?: string | null
}): SpotCheckResult[] {
  const results: SpotCheckResult[] = []

  // Select which checks apply based on action type
  const checks: SpotCheckType[] = []

  // content_depth applies to all
  checks.push('content_depth')

  // output_trace applies to all
  checks.push('output_trace')

  // commit_substance for code tasks
  if (action.type === 'build') {
    checks.push('commit_substance')
  }

  // source_check for research agents (zara, nina, marcus)
  if (action.type === 'research') {
    checks.push('source_check')
  }

  for (const checkType of checks) {
    const result = runSingleCheck(checkType, action)
    results.push(result)

    if (!result.passed) {
      recordSpotCheckFailure(action.agent_id, action.id, checkType, result.details)
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Individual check implementations
// ---------------------------------------------------------------------------
function runSingleCheck(
  checkType: SpotCheckType,
  action: { id: string; agent_id: string; type: string; output: string; cited_sources?: string | null }
): SpotCheckResult {
  switch (checkType) {
    case 'content_depth':
      return checkContentDepth(action)
    case 'output_trace':
      return checkOutputTrace(action)
    case 'commit_substance':
      return checkCommitSubstance(action)
    case 'source_check':
      return checkSourceCheck(action)
  }
}

// ---------------------------------------------------------------------------
// content_depth: verify claims have supporting evidence
// ---------------------------------------------------------------------------
function checkContentDepth(action: {
  output: string
  cited_sources?: string | null
}): SpotCheckResult {
  const output = action.output

  // Look for claim-like statements (sentences with numbers, percentages, or assertions)
  const claimPatterns = [
    /\d+%/,
    /\$\d+/,
    /\d+ users/i,
    /\d+ customers/i,
    /revenue of/i,
    /market size/i,
    /growing at/i,
  ]

  const hasClaims = claimPatterns.some(p => p.test(output))

  if (hasClaims) {
    // Check if cited_sources field has content
    const sources = action.cited_sources
    if (!sources || sources.trim().length < 10) {
      return {
        passed: false,
        checkType: 'content_depth',
        details: 'Output contains claims/data but no cited sources',
      }
    }
  }

  return { passed: true, checkType: 'content_depth', details: 'OK' }
}

// ---------------------------------------------------------------------------
// output_trace: verify output references prior work
// ---------------------------------------------------------------------------
function checkOutputTrace(action: {
  agent_id: string
  output: string
}): SpotCheckResult {
  const db = getDb()
  const output = action.output.toLowerCase()

  // Get recent messages and actions involving this agent
  const recentMessages = db.query(`
    SELECT subject, body FROM messages
    WHERE to_agent_id = ? OR from_agent_id = ?
    ORDER BY created_at DESC LIMIT 10
  `).all(action.agent_id, action.agent_id) as { subject: string; body: string }[]

  const recentActions = db.query(`
    SELECT description FROM actions
    WHERE agent_id = ? AND status = 'completed'
    ORDER BY completed_at DESC LIMIT 5
  `).all(action.agent_id) as { description: string }[]

  // Check if output references any prior work (by keyword overlap)
  let hasReference = false

  for (const msg of recentMessages) {
    const keywords = extractKeywords(msg.subject + ' ' + msg.body)
    if (keywords.some(kw => output.includes(kw.toLowerCase()))) {
      hasReference = true
      break
    }
  }

  if (!hasReference) {
    for (const act of recentActions) {
      const keywords = extractKeywords(act.description)
      if (keywords.some(kw => output.includes(kw.toLowerCase()))) {
        hasReference = true
        break
      }
    }
  }

  // First action for an agent won't have prior work — pass it
  if (recentActions.length <= 1 && recentMessages.length === 0) {
    hasReference = true
  }

  return {
    passed: hasReference,
    checkType: 'output_trace',
    details: hasReference ? 'OK' : 'Output has no references to prior agent messages or actions',
  }
}

// ---------------------------------------------------------------------------
// commit_substance: for code tasks, verify git diff has >10 lines changed
// and does not only modify comments, README, or package.json version numbers
// ---------------------------------------------------------------------------
function checkCommitSubstance(action: { output: string }): SpotCheckResult {
  const output = action.output

  // Look for diff indicators
  const diffLines = output.split('\n').filter(line =>
    line.startsWith('+') || line.startsWith('-')
  ).filter(line =>
    !line.startsWith('+++') && !line.startsWith('---')
  )

  // Must have >10 lines changed
  if (diffLines.length <= 10) {
    return {
      passed: false,
      checkType: 'commit_substance',
      details: `Only ${diffLines.length} diff lines (need >10 substantive lines)`,
    }
  }

  // Check if changes are only in comments, README, or version numbers
  const substantiveChanges = diffLines.filter(line => {
    const trimmed = line.slice(1).trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) return false
    if (trimmed.startsWith('"version"')) return false
    if (trimmed === '') return false
    return true
  })

  if (substantiveChanges.length === 0) {
    return {
      passed: false,
      checkType: 'commit_substance',
      details: 'Code changes only modify comments, README, or version numbers',
    }
  }

  return { passed: true, checkType: 'commit_substance', details: 'OK' }
}

// ---------------------------------------------------------------------------
// source_check: for Zara/Nina/Marcus outputs, verify at least one URL was fetched
// Check tool_calls log for web_fetch or search calls, fallback to URL presence in output
// ---------------------------------------------------------------------------
function checkSourceCheck(action: { id: string; output: string }): SpotCheckResult {
  const db = getDb()
  const output = action.output

  // Primary: check tool_calls field for web_fetch or search calls
  const actionRow = db.query(`SELECT tool_calls FROM actions WHERE id = ?`).get(action.id) as { tool_calls: string | null } | null
  if (actionRow?.tool_calls) {
    const lower = actionRow.tool_calls.toLowerCase()
    if (lower.includes('web_fetch') || lower.includes('web_search') || lower.includes('search')) {
      return { passed: true, checkType: 'source_check', details: 'Tool calls log contains web_fetch/search' }
    }
  }

  // Fallback: check if output contains URLs (evidence of sources)
  const urlPattern = /https?:\/\/[^\s)>"]+/g
  const urls = output.match(urlPattern)

  if (!urls || urls.length === 0) {
    return {
      passed: false,
      checkType: 'source_check',
      details: 'Research output contains no source URLs and no web_fetch/search tool calls logged',
    }
  }

  return { passed: true, checkType: 'source_check', details: `Found ${urls.length} source URLs` }
}

// ---------------------------------------------------------------------------
// Extract meaningful keywords from text (for output_trace matching)
// ---------------------------------------------------------------------------
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'can', 'shall', 'to', 'of',
    'in', 'for', 'on', 'with', 'at', 'by', 'from', 'and', 'or',
    'not', 'no', 'but', 'if', 'then', 'than', 'that', 'this',
    'it', 'its', 'all', 'each', 'every', 'both', 'few', 'more',
  ])

  return text
    .split(/\s+/)
    .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(w => w.length > 3 && !stopWords.has(w.toLowerCase()))
    .slice(0, 20)
}

// ---------------------------------------------------------------------------
// Record a spot check failure
// ---------------------------------------------------------------------------
function recordSpotCheckFailure(
  agentId: string,
  actionId: string,
  checkType: SpotCheckType,
  details: string
): void {
  const db = getDb()
  const id = crypto.randomUUID()
  const simDay = getSimDay()

  db.run(`
    INSERT INTO spot_check_failures (id, agent_id, action_id, check_type, details, sim_day)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, agentId, actionId, checkType, details, simDay])

  console.log(`[SPOT-CHECK] FAIL: ${checkType} for agent ${agentId} on action ${actionId}: ${details}`)

  // Check escalation threshold
  checkSpotCheckEscalation(agentId, checkType)
}
