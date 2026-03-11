// ---------------------------------------------------------------------------
// Google Drive Client — real implementation
//
// Service account auth, document creation, and sheet operations.
// Rate-limited queue to stay under Drive API quota (8 calls/sec).
// ---------------------------------------------------------------------------

import { google } from 'googleapis'
import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs'

const GDRIVE_ROOT = process.env.GDRIVE_ROOT_FOLDER_ID ?? ''
const SERVICE_ACCOUNT_PATH = process.env.GDRIVE_SERVICE_ACCOUNT_PATH ?? ''
// Pre-created sheet ID — user creates sheet in their Drive, shares with SA
const TASK_LOG_SHEET_ID = process.env.GDRIVE_TASK_LOG_SHEET_ID ?? ''

// Rate-limited write queue
const writeQueue: Array<() => Promise<void>> = []
let processing = false

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true

  while (writeQueue.length > 0) {
    const task = writeQueue.shift()
    if (task) {
      try {
        await task()
      } catch (e) {
        console.error('[GDRIVE] Queue task failed:', e)
      }
      await new Promise(r => setTimeout(r, 125))
    }
  }

  processing = false
}

function enqueue(task: () => Promise<void>): void {
  writeQueue.push(task)
  processQueue()
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
let _drive: ReturnType<typeof google.drive> | null = null
let _sheets: ReturnType<typeof google.sheets> | null = null
let _docs: ReturnType<typeof google.docs> | null = null

function getAuth() {
  if (!SERVICE_ACCOUNT_PATH || !existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error(`Service account file not found: ${SERVICE_ACCOUNT_PATH}`)
  }
  const creds = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'))
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/documents',
    ],
  })
}

function getDrive() {
  if (!_drive) _drive = google.drive({ version: 'v3', auth: getAuth() })
  return _drive
}

function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: 'v4', auth: getAuth() })
  return _sheets
}

// ---------------------------------------------------------------------------
// Folder operations
// ---------------------------------------------------------------------------
export async function createFolder(name: string, parentId?: string): Promise<string> {
  const drive = getDrive()
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId ?? GDRIVE_ROOT],
    },
    fields: 'id',
  })
  const folderId = res.data.id!
  console.log(`[GDRIVE] Created folder "${name}" → ${folderId}`)
  return folderId
}

// ---------------------------------------------------------------------------
// Document operations
// ---------------------------------------------------------------------------
export async function createDoc(name: string, content: string, folderId?: string): Promise<string> {
  const drive = getDrive()

  // Create as a plain text file (Google Docs API requires separate content insert)
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId ?? GDRIVE_ROOT],
    },
    fields: 'id',
  })

  const docId = res.data.id!

  // Insert content using Docs API
  const docs = google.docs({ version: 'v1', auth: getAuth() })
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [{
        insertText: {
          location: { index: 1 },
          text: content,
        },
      }],
    },
  })

  console.log(`[GDRIVE] Created doc "${name}" (${content.length} chars) → ${docId}`)
  return docId
}

// ---------------------------------------------------------------------------
// Sheet operations
// ---------------------------------------------------------------------------
export async function createSheet(name: string, folderId?: string): Promise<string> {
  const drive = getDrive()
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [folderId ?? GDRIVE_ROOT],
    },
    fields: 'id',
  })
  const sheetId = res.data.id!
  console.log(`[GDRIVE] Created sheet "${name}" → ${sheetId}`)
  return sheetId
}

export async function appendSheetRow(sheetId: string, values: string[]): Promise<void> {
  const sheets = getSheets()
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Sheet1!A:Z',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [values],
    },
  })
}

export async function setSheetHeaders(sheetId: string, headers: string[]): Promise<void> {
  const sheets = getSheets()
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: 'Sheet1!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [headers],
    },
  })
}

// ---------------------------------------------------------------------------
// High-level: upload task completion to Drive
//
// Strategy: User creates a Google Sheet manually and shares it with the SA.
// We write to that existing sheet (no file creation = no storage quota needed).
// Also logs to local CSV as a fallback so data is never lost.
// ---------------------------------------------------------------------------

export async function logTaskToDrive(
  agentName: string,
  agentTeam: string,
  taskType: string,
  taskDescription: string,
  output: string,
  phase: number,
  simDay: number
): Promise<void> {
  const row = [
    new Date().toISOString(),
    `Day ${simDay}`,
    `Phase ${phase}`,
    agentName,
    agentTeam,
    taskType,
    taskDescription,
    output.length > 500 ? output.slice(0, 500) + '...' : output,
    String(output.length),
    'completed',
  ]

  // Always log to local CSV as fallback
  logToLocalCSV(row)

  if (!isConfigured()) {
    console.warn('[GDRIVE] Not configured — logged to local CSV only')
    return
  }

  enqueue(async () => {
    try {
      const sheetId = await resolveTaskLogSheet()
      if (!sheetId) {
        console.warn('[GDRIVE] No task log sheet available — logged to local CSV only')
        return
      }

      await appendSheetRow(sheetId, row)
      console.log(`[GDRIVE] Logged task: ${agentName} — ${taskType}`)
    } catch (e: any) {
      console.error('[GDRIVE] Failed to log task (data saved in local CSV):', e.message ?? e)
    }
  })
}

// Resolve the sheet ID: prefer env var, then search for existing sheet
let _resolvedSheetId: string | null | undefined = undefined  // undefined = not yet checked

async function resolveTaskLogSheet(): Promise<string | null> {
  // If env var is set, use that directly (fastest, no API call)
  if (TASK_LOG_SHEET_ID) return TASK_LOG_SHEET_ID

  // Only search once
  if (_resolvedSheetId !== undefined) return _resolvedSheetId

  try {
    const drive = getDrive()
    const res = await drive.files.list({
      q: `name = 'AgentOS Task Log' and '${GDRIVE_ROOT}' in parents and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: 'files(id)',
    })

    if (res.data.files && res.data.files.length > 0) {
      _resolvedSheetId = res.data.files[0].id!
      console.log(`[GDRIVE] Found existing task log sheet: ${_resolvedSheetId}`)
      return _resolvedSheetId
    }
  } catch (e: any) {
    console.error('[GDRIVE] Failed to search for sheet:', e.message ?? e)
  }

  _resolvedSheetId = null
  return null
}

// Local CSV fallback — data is never lost
function logToLocalCSV(row: string[]): void {
  try {
    const csvPath = './logs/task-log.csv'
    const headerLine = 'Timestamp,Sim Day,Phase,Agent,Team,Type,Task Description,Output Preview,Output Length,Status\n'
    const csvLine = row.map(v => `"${(v ?? '').replace(/"/g, '""')}"`).join(',') + '\n'

    if (!existsSync(csvPath)) {
      writeFileSync(csvPath, headerLine + csvLine)
    } else {
      appendFileSync(csvPath, csvLine)
    }
  } catch (e) {
    console.error('[CSV] Failed to write local CSV:', e)
  }
}

// ---------------------------------------------------------------------------
// Backfill — sync all completed tasks from DB to Drive
// Called on server startup if sheet is configured
// ---------------------------------------------------------------------------
export async function backfillDriveFromDB(): Promise<void> {
  const sheetId = await resolveTaskLogSheet()
  if (!sheetId) {
    console.log('[GDRIVE] No sheet configured — skipping backfill')
    return
  }

  try {
    // Check if sheet is empty (needs headers + data)
    const sheets = getSheets()
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Sheet1!A1:A2',
    })

    const hasData = existing.data.values && existing.data.values.length > 1

    if (!hasData) {
      // Set headers first
      await setSheetHeaders(sheetId, [
        'Timestamp', 'Sim Day', 'Phase', 'Agent', 'Team', 'Type',
        'Task Description', 'Output Preview', 'Output Length', 'Status',
      ])
    }

    // Get completed tasks that may not be in the sheet yet
    // We use a simple approach: check row count vs completed task count
    const rowCount = existing.data.values?.length ?? 0
    const { getDb } = await import('../db/database')
    const db = getDb()
    const completed = db.query(`
      SELECT a.completed_at, a.phase, a.type, a.description, a.output,
             ag.personality_name, ag.team
      FROM actions a
      JOIN agents ag ON ag.id = a.agent_id
      WHERE a.status = 'completed'
      ORDER BY a.completed_at ASC
    `).all() as any[]

    // If sheet has fewer rows than completed tasks, backfill the missing ones
    const missingCount = completed.length - Math.max(0, rowCount - 1) // -1 for header
    if (missingCount > 0) {
      const toBackfill = completed.slice(completed.length - missingCount)
      for (const t of toBackfill) {
        const preview = (t.output || '').slice(0, 500)
        await appendSheetRow(sheetId, [
          t.completed_at || new Date().toISOString(),
          'Day 1',
          `Phase ${t.phase}`,
          t.personality_name,
          t.team,
          t.type,
          t.description,
          preview,
          String((t.output || '').length),
          'completed',
        ])
        await new Promise(r => setTimeout(r, 150)) // rate limit
      }
      console.log(`[GDRIVE] Backfilled ${missingCount} tasks to Drive`)
    } else {
      console.log('[GDRIVE] Sheet is up to date')
    }
  } catch (e: any) {
    console.error('[GDRIVE] Backfill failed:', e.message ?? e)
  }
}

// ---------------------------------------------------------------------------
// Config check
// ---------------------------------------------------------------------------
export function isConfigured(): boolean {
  // Configured if we have either a direct sheet ID or the folder+SA to search for one
  return (!!TASK_LOG_SHEET_ID || (!!GDRIVE_ROOT && !!SERVICE_ACCOUNT_PATH && existsSync(SERVICE_ACCOUNT_PATH)))
}
