import { unlinkSync, existsSync } from 'node:fs'
import { runMigrations } from '../server/db/migrate'

const DB_PATH = process.env.DB_PATH ?? './sim.db'

console.log('⚠️  RESETTING AgentOS simulation database...')
console.log(`   Deleting: ${DB_PATH}`)

if (existsSync(DB_PATH)) {
  unlinkSync(DB_PATH)
  // Also remove WAL and SHM files if they exist
  if (existsSync(`${DB_PATH}-wal`)) unlinkSync(`${DB_PATH}-wal`)
  if (existsSync(`${DB_PATH}-shm`)) unlinkSync(`${DB_PATH}-shm`)
  console.log('   ✓ Database deleted')
} else {
  console.log('   (no database to delete)')
}

console.log('   Running migrations on fresh database...')
runMigrations()

console.log('\n✅ Reset complete. Run `bun run seed` to re-seed agents.')
