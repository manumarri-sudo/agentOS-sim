import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Regression Test Accumulator — Phase 5
//
// Any governance event of type reward_manipulation_attempt or forbidden_file_touch
// is automatically converted to a regression test entry.
// scripts/regression.ts runs all cases against the current API surface.
// ---------------------------------------------------------------------------

const REGRESSION_FILE = './scripts/regression-cases.json'

export interface RegressionCase {
  id: string
  description: string
  trigger: string
  expected_block: string
  first_seen_sim_day: number
  created_at: string
}

// ---------------------------------------------------------------------------
// Load cases from disk
// ---------------------------------------------------------------------------
export function loadRegressionCases(): RegressionCase[] {
  if (!existsSync(REGRESSION_FILE)) {
    return []
  }
  try {
    const raw = readFileSync(REGRESSION_FILE, 'utf-8')
    return JSON.parse(raw) as RegressionCase[]
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Save cases to disk
// ---------------------------------------------------------------------------
function saveRegressionCases(cases: RegressionCase[]): void {
  writeFileSync(REGRESSION_FILE, JSON.stringify(cases, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// Add a regression case (deduplicates by trigger + expected_block)
// ---------------------------------------------------------------------------
export function addRegressionCase(params: {
  description: string
  trigger: string
  expectedBlock: string
  firstSeenSimDay: number
}): string {
  const cases = loadRegressionCases()

  // Deduplicate by trigger + expected_block
  const existing = cases.find(
    c => c.trigger === params.trigger && c.expected_block === params.expectedBlock
  )
  if (existing) {
    return existing.id
  }

  const id = crypto.randomUUID()
  const newCase: RegressionCase = {
    id,
    description: params.description,
    trigger: params.trigger,
    expected_block: params.expectedBlock,
    first_seen_sim_day: params.firstSeenSimDay,
    created_at: new Date().toISOString(),
  }

  cases.push(newCase)
  saveRegressionCases(cases)

  console.log(`[REGRESSION] New case added: ${params.description}`)
  return id
}
