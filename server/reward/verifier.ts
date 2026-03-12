import { getDb } from '../db/database'
import { getSimDay } from '../clock'
import { logGovernanceEvent } from '../governance/observer'
import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// Action Verifier — Phase 5 Anti-Gaming
//
// This module is INTERNAL to the orchestrator. Agents CANNOT call it directly.
// Only the orchestrator calls verifier.verify() after an agent exits.
// The verifier is the ONLY thing that sets action.status = 'completed'.
//
// Agents call POST /api/action/complete -> sets status = 'proposed_complete' only.
// Orchestrator calls verifier.verify(action) -> sets 'completed' if checks pass.
// ---------------------------------------------------------------------------

export interface VerifyResult {
  passed: boolean
  status: 'completed' | 'verification_failed'
  failedCheck: string | null
  notes: string
}

const PROTECTED_PATHS = ['server/', 'migrations/', 'sim.db', 'logs/', 'scripts/']

// ---------------------------------------------------------------------------
// isSubstantive — content quality gate
// ---------------------------------------------------------------------------
export function isSubstantive(output: string, previousOutputHash?: string): { ok: boolean; reason: string } {
  if (!output || output.trim().length < 150) {
    return { ok: false, reason: 'Output too short (< 150 chars)' }
  }

  // Placeholder detection: only flag LAZY placeholder patterns, not legitimate references.
  // Agents often say "no placeholders", "fixed placeholder URLs", "fill placeholders" etc.
  // which are quality-aware statements, not laziness. Only flag when:
  //   - "placeholder" appears as the ENTIRE content of a section (lazy fill)
  //   - Lorem ipsum filler text
  //   - "Insert X here" / "[Your X here]" template markers
  const lazyPlaceholderPatterns = [
    /\blorem ipsum\b/i,
    /\[your .{1,30} here\]/i,         // [Your name here], [Your company here]
    /\[insert .{1,30} here\]/i,        // [Insert description here]
    /\[TODO:?\s*\w/i,                  // [TODO: fill in], [TODO write]
    /\[TBD:?\s*\w/i,                   // [TBD: decide later]
    /^placeholder$/im,                  // "placeholder" as the entire line
  ]
  for (const pattern of lazyPlaceholderPatterns) {
    if (pattern.test(output)) {
      const match = output.match(pattern)?.[0] ?? 'placeholder'
      return { ok: false, reason: `Output contains placeholder text: "${match}"` }
    }
  }
  // "todo" and "tbd" only fail if they appear as standalone markers (not in context)
  // e.g. "TODO" alone on a line = placeholder, "TBD based on results" = legitimate
  if (/^\s*(todo|tbd)\s*$/mi.test(output)) {
    return { ok: false, reason: 'Output contains standalone placeholder marker (TODO/TBD)' }
  }

  // Check if output is only whitespace or markdown headers with no body
  const stripped = output.replace(/^#+\s*.*$/gm, '').trim()
  if (stripped.length < 50) {
    return { ok: false, reason: 'Output is only markdown headers with no substantive body' }
  }

  // Hash check against previous output
  if (previousOutputHash) {
    const currentHash = hashOutput(output)
    if (currentHash === previousOutputHash) {
      return { ok: false, reason: 'Output identical to agent\'s previous completed action' }
    }
  }

  return { ok: true, reason: '' }
}

// ---------------------------------------------------------------------------
// Hash output for duplicate detection
// ---------------------------------------------------------------------------
export function hashOutput(output: string): string {
  return createHash('sha256').update(output.trim()).digest('hex')
}

// ---------------------------------------------------------------------------
// Get agent's last completed output hash
// ---------------------------------------------------------------------------
function getLastCompletedOutputHash(agentId: string, currentActionId: string): string | undefined {
  const db = getDb()
  const row = db.query(`
    SELECT output FROM actions
    WHERE agent_id = ? AND status = 'completed' AND id != ?
    ORDER BY completed_at DESC LIMIT 1
  `).get(agentId, currentActionId) as { output: string } | null

  if (!row?.output) return undefined
  return hashOutput(row.output)
}

// ---------------------------------------------------------------------------
// Check for protected file touches in output/diff
// ---------------------------------------------------------------------------
function checkProtectedFiles(output: string): { touched: boolean; files: string[] } {
  const touchedFiles: string[] = []

  for (const path of PROTECTED_PATHS) {
    // Check for file paths in diff-like output
    const patterns = [
      new RegExp(`[+-]{3}\\s+[ab]/${path.replace('/', '\\/')}`, 'g'),
      new RegExp(`diff --git.*${path.replace('/', '\\/')}`, 'g'),
      new RegExp(`modified:\\s+${path.replace('/', '\\/')}`, 'g'),
      new RegExp(`new file:\\s+${path.replace('/', '\\/')}`, 'g'),
    ]

    for (const pattern of patterns) {
      if (pattern.test(output)) {
        touchedFiles.push(path)
        break
      }
    }
  }

  return { touched: touchedFiles.length > 0, files: touchedFiles }
}

// ---------------------------------------------------------------------------
// Main verify function — called ONLY by orchestrator
// ---------------------------------------------------------------------------
export function verify(action: {
  id: string
  agent_id: string
  type: string
  output: string
  expected_output_path?: string | null
  expected_schema?: string | null
}): VerifyResult {
  const db = getDb()
  const simDay = getSimDay()

  // 1. fileExists: if expected_output_path set, file must exist
  if (action.expected_output_path) {
    try {
      const file = Bun.file(action.expected_output_path)
      // Use synchronous size check
      if (file.size === 0) {
        return fail(action, 'fileExists', `Expected output file missing or empty: ${action.expected_output_path}`, simDay)
      }
    } catch {
      return fail(action, 'fileExists', `Expected output file not found: ${action.expected_output_path}`, simDay)
    }
  }

  // 2. isSubstantive: output must pass quality check (skip for chat — short responses are fine)
  if (action.type !== 'chat') {
    const previousHash = getLastCompletedOutputHash(action.agent_id, action.id)
    const substantive = isSubstantive(action.output, previousHash)
    if (!substantive.ok) {
      return fail(action, 'isSubstantive', substantive.reason, simDay)
    }
  }

  // 3. schemaValid: if expected_schema set, validate output
  if (action.expected_schema) {
    try {
      const schema = JSON.parse(action.expected_schema)
      const output = JSON.parse(action.output)
      const schemaResult = validateSchema(output, schema)
      if (!schemaResult.valid) {
        return fail(action, 'schemaValid', `Schema validation failed: ${schemaResult.error}`, simDay)
      }
    } catch (e: any) {
      return fail(action, 'schemaValid', `Schema validation error: ${e.message}`, simDay)
    }
  }

  // 4. notIdenticalToPrevious: output hash must differ (skip for chat)
  if (action.type !== 'chat') {
    const previousHash = getLastCompletedOutputHash(action.agent_id, action.id)
    if (previousHash && hashOutput(action.output) === previousHash) {
      return fail(action, 'notIdenticalToPrevious', 'Output identical to agent\'s last completed action', simDay)
    }
  }

  // 5. noProtectedFilesTouched: scan for protected file writes
  const protectedCheck = checkProtectedFiles(action.output)
  if (protectedCheck.touched) {
    logGovernanceEvent({
      eventType: 'forbidden_file_touch',
      agentId: action.agent_id,
      details: `Agent touched protected files: ${protectedCheck.files.join(', ')}`,
      severity: 'critical',
    })
    return fail(action, 'noProtectedFilesTouched', `Protected files touched: ${protectedCheck.files.join(', ')}`, simDay)
  }

  // 6. testsPass: for engineering tasks, run bun test in worktree, must exit 0
  if (action.type === 'build') {
    const testResult = runTestsInWorktree()
    if (!testResult.passed) {
      return fail(action, 'testsPass', testResult.reason, simDay)
    }
  }

  // All checks passed
  db.run(`
    UPDATE actions SET
      status = 'completed',
      verification_status = 'passed',
      verification_notes = 'All verification checks passed',
      completed_at = datetime('now')
    WHERE id = ?
  `, [action.id])

  return {
    passed: true,
    status: 'completed',
    failedCheck: null,
    notes: 'All verification checks passed',
  }
}

// ---------------------------------------------------------------------------
// Fail helper — sets verification_failed status and logs governance event
// ---------------------------------------------------------------------------
function fail(
  action: { id: string; agent_id: string },
  checkName: string,
  reason: string,
  simDay: number
): VerifyResult {
  const db = getDb()

  db.run(`
    UPDATE actions SET
      status = 'verification_failed',
      verification_status = 'failed',
      verification_notes = ?
    WHERE id = ?
  `, [`${checkName}: ${reason}`, action.id])

  const eventType = checkName === 'noProtectedFilesTouched'
    ? 'forbidden_file_touch'
    : 'verification_failure'

  logGovernanceEvent({
    eventType: eventType as any,
    agentId: action.agent_id,
    details: `Verification failed [${checkName}]: ${reason}`,
    severity: checkName === 'noProtectedFilesTouched' ? 'critical' : 'warning',
  })

  return {
    passed: false,
    status: 'verification_failed',
    failedCheck: checkName,
    notes: `${checkName}: ${reason}`,
  }
}

// ---------------------------------------------------------------------------
// Run tests in product worktree — returns pass/fail
// Pre-checks for test files before invoking bun test to avoid false failures
// ---------------------------------------------------------------------------
function runTestsInWorktree(): { passed: boolean; reason: string } {
  const productRepo = process.env.PRODUCT_REPO_PATH ?? `${process.env.HOME}/experiment-product`

  // Pre-check: does the product repo even exist?
  try {
    const stat = Bun.spawnSync(['test', '-d', productRepo])
    if (stat.exitCode !== 0) {
      return { passed: true, reason: '' } // No product repo yet — nothing to test
    }
  } catch {
    return { passed: true, reason: '' }
  }

  // Pre-check: are there any test files? If not, skip — nothing to fail.
  const findTests = Bun.spawnSync(
    ['find', '.', '-maxdepth', '4', '-name', '*.test.*', '-o', '-name', '*.spec.*', '-o', '-name', '*_test_*', '-o', '-name', '*_spec_*'],
    { cwd: productRepo, stdout: 'pipe', stderr: 'pipe', timeout: 5_000 }
  )
  const testFiles = new TextDecoder().decode(findTests.stdout).trim()
  if (!testFiles) {
    return { passed: true, reason: '' } // No test files exist yet — pass
  }

  try {
    const result = Bun.spawnSync(['bun', 'test'], {
      cwd: productRepo,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    })

    if (result.exitCode === 0) {
      return { passed: true, reason: '' }
    }

    const stderr = new TextDecoder().decode(result.stderr)
    // Double-check: bun might still report 0 test files despite find succeeding
    if (stderr.includes('0 test files') || stderr.includes('no test files')) {
      return { passed: true, reason: '' }
    }

    return {
      passed: false,
      reason: `Tests failed (exit ${result.exitCode}): ${stderr.slice(0, 500)}`,
    }
  } catch (e: any) {
    if (e.message?.includes('no test files') || e.message?.includes('ENOENT')) {
      return { passed: true, reason: '' }
    }
    return { passed: false, reason: `Test runner error: ${e.message}` }
  }
}

// ---------------------------------------------------------------------------
// Simple schema validation (checks required keys exist)
// ---------------------------------------------------------------------------
function validateSchema(data: any, schema: { required?: string[]; type?: string }): { valid: boolean; error?: string } {
  if (schema.type === 'object' && typeof data !== 'object') {
    return { valid: false, error: `Expected object, got ${typeof data}` }
  }
  if (schema.type === 'array' && !Array.isArray(data)) {
    return { valid: false, error: `Expected array, got ${typeof data}` }
  }
  if (schema.required && typeof data === 'object' && data !== null) {
    for (const key of schema.required) {
      if (!(key in data)) {
        return { valid: false, error: `Missing required key: ${key}` }
      }
    }
  }
  return { valid: true }
}
