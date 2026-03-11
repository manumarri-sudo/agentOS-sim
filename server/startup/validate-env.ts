import { existsSync } from 'node:fs'

interface EnvCheck {
  key: string
  test: (v: string) => boolean
  error: string
}

const REQUIRED_ENV: EnvCheck[] = [
  {
    key: 'DB_PATH',
    test: (v: string) => v.length > 0,
    error: 'Database path must be set',
  },
]

const OPTIONAL_ENV = [
  'ANTHROPIC_API_KEY',
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
]

export function validateEnv(): void {
  const errors: string[] = []

  for (const { key, test, error } of REQUIRED_ENV) {
    const val = process.env[key]
    if (!val || !test(val)) {
      errors.push(`${key}: ${error}`)
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
