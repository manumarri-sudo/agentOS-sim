import { readdirSync, statSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Log Rotation — rotates logs >10MB to compressed archive
//
// Called periodically by the orchestrator or as a standalone script.
// ---------------------------------------------------------------------------

const LOG_DIR = process.env.LOG_DIR ?? './logs'
const ARCHIVE_DIR = join(LOG_DIR, 'archive')
const MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10MB

export function rotateLogs(): void {
  if (!existsSync(LOG_DIR)) return

  if (!existsSync(ARCHIVE_DIR)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true })
  }

  const files = readdirSync(LOG_DIR).filter(f => f.endsWith('.log'))

  for (const file of files) {
    const filePath = join(LOG_DIR, file)
    try {
      const stat = statSync(filePath)
      if (stat.size > MAX_SIZE_BYTES) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const archiveName = `${file.replace('.log', '')}-${timestamp}.log.gz`
        const archivePath = join(ARCHIVE_DIR, archiveName)

        // Use gzip compression
        const result = Bun.spawnSync(['gzip', '-c', filePath], {
          stdout: 'pipe',
        })

        if (result.exitCode === 0) {
          Bun.write(archivePath, result.stdout)
          // Truncate original file
          Bun.write(filePath, '')
          console.log(`[LOG-ROTATE] Archived ${file} (${(stat.size / 1024 / 1024).toFixed(1)}MB) → ${archiveName}`)
        }
      }
    } catch (e: any) {
      console.error(`[LOG-ROTATE] Error rotating ${file}: ${e.message}`)
    }
  }
}

// Run if invoked directly
if (import.meta.main) {
  console.log('=== LOG ROTATION ===')
  rotateLogs()
  console.log('Done.')
}
