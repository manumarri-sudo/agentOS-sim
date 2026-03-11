import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Environment Validation — doc 6 Issue 12
//
// REQUIRED: block startup if missing/invalid
// OPTIONAL: warn but don't block
// ---------------------------------------------------------------------------

interface EnvCheck {
  key: string
  test: (v: string) => boolean
  error: string
  skipIfClaudeCliAuth?: boolean
}

function isClaudeCliAuthenticated(): boolean {
  try {
    const result = spawnSync('claude', ['--version'], { timeout: 5000 })
    return result.status === 0
  } catch {
    return false
  }
}

const REQUIRED_ENV: EnvCheck[] = [
  {
    key: 'DB_PATH',
    test: (v: string) => v.length > 0,
    error: 'Database path must be set',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    test: (v: string) => v.length > 10,
    error: 'Anthropic API key required for agent spawning (or use `claude login` for Claude Max)',
    skipIfClaudeCliAuth: true,
  },
  {
    key: 'SIM_HUMAN_TOKEN',
    test: (v: string) => v.length >= 8,
    error: 'Human auth token must be at least 8 characters',
  },
]

const OPTIONAL_ENV = [
  'GDRIVE_SERVICE_ACCOUNT_PATH',
  'GDRIVE_ROOT_FOLDER_ID',
  'NOTION_API_KEY',
  'NOTION_DATABASE_ID',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'BUFFER_ACCESS_TOKEN',
  'RESEND_API_KEY',
  'GUMROAD_API_KEY',
  'LEMON_SQUEEZY_API_KEY',
  'PLAUSIBLE_SITE_ID',
  'PLAUSIBLE_API_KEY',
  'NOTION_DATABASE_ID',
]

export function validateEnv(): void {
  const errors: string[] = []

  // In mock/test mode, skip strict validation of external service keys
  const mockMode = process.env.MOCK_AGENTS === 'true'
  const cliAuth = isClaudeCliAuthenticated()

  for (const { key, test, error, skipIfClaudeCliAuth } of REQUIRED_ENV) {
    const val = process.env[key]
    if (!val) {
      if (skipIfClaudeCliAuth && cliAuth) {
        console.log(`✓ ${key} not set — using Claude CLI auth instead`)
      } else if (mockMode && key !== 'DB_PATH') {
        console.warn(`⚠️  ${key} not set (mock mode — skipping strict check)`)
      } else {
        errors.push(`${key}: ${error}`)
      }
    } else if (!test(val)) {
      if (skipIfClaudeCliAuth && cliAuth) {
        console.log(`✓ ${key} not valid — using Claude CLI auth instead`)
      } else if (mockMode && key !== 'DB_PATH') {
        console.warn(`⚠️  ${key}: ${error} (mock mode — continuing anyway)`)
      } else {
        errors.push(`${key}: ${error}`)
      }
    }
  }

  if (errors.length > 0) {
    console.error('❌ Startup failed — missing or invalid env vars:')
    errors.forEach(e => console.error(`  - ${e}`))
    process.exit(1)
  }

  for (const key of OPTIONAL_ENV) {
    if (!process.env[key]) {
      console.warn(`⚠️  ${key} not set — related features disabled`)
    }
  }

  console.log('✓ Environment validated')
}
