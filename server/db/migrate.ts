import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from './database'

const MIGRATIONS_DIR = join(import.meta.dir, '../../migrations')

export function runMigrations(): void {
  const db = getDb()

  // Ensure schema_migrations table exists (bootstrap)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()

  let applied = 0
  let skipped = 0

  for (const file of files) {
    const existing = db.query(`SELECT 1 FROM schema_migrations WHERE filename = ?`).get(file)
    if (existing) {
      skipped++
      continue
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    db.exec(sql)
    db.run(`INSERT INTO schema_migrations (filename, applied_at) VALUES (?, datetime('now'))`, [file])
    console.log(`  ✓ ${file}`)
    applied++
  }

  console.log(`Migrations complete: ${applied} applied, ${skipped} skipped`)
}

// Allow running directly: bun run server/db/migrate.ts
if (import.meta.main) {
  console.log('Running migrations...')
  runMigrations()
  console.log('Done.')
}
