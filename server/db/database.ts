import { Database } from 'bun:sqlite'

const DB_PATH = process.env.DB_PATH ?? './sim.db'

let _db: Database | null = null

export function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_PATH, { create: true })
    _db.exec('PRAGMA journal_mode = WAL')
    _db.exec('PRAGMA foreign_keys = ON')
    _db.exec('PRAGMA busy_timeout = 5000')
  }
  return _db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
