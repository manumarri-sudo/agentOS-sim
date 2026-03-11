// ---------------------------------------------------------------------------
// Notion Sync — auto-push task completions to Notion
//
// Activity log rows go to the Agent Activity Log database.
// Substantial outputs (research/write/decide >1000 chars) get their own page.
// ---------------------------------------------------------------------------

const NOTION_API_KEY = process.env.NOTION_API_KEY ?? ''
const ACTIVITY_LOG_DB = process.env.NOTION_ACTIVITY_LOG_DB ?? 'da8ce41c-4b56-429d-afac-95e94bd04e58'
const AGENTOS_PAGE_ID = process.env.NOTION_AGENTOS_PAGE_ID ?? '320eb97f2a2381d9a2fdf4a51c553f3b'

// Folder structure for organized filing
const FOLDERS = {
  // Phase folders
  phases: {
    1: '320eb97f2a23810580cce4d562de561b', // Phase 1 — Research & Discovery
    2: '320eb97f2a238138ad84dd79b246b6da', // Phase 2 — Build & Validate
    3: '320eb97f2a23817bb500f70990ca5d60', // Phase 3 — Launch & Revenue
  } as Record<number, string>,
  // Phase 1 sub-folders
  p1: {
    market:    '320eb97f2a238101838ec59bc976e753', // Market Research
    customer:  '320eb97f2a238156a84ece5c232d0f6f', // Customer Research
    analysis:  '320eb97f2a2381cda76bf9172811c786', // Opportunity Analysis
    executive: '320eb97f2a2381beb5a9cebfd6a5b382', // Executive Briefs
  },
  // Top-level folders
  meetings: '320eb97f2a2381129435e17e68410025',
  ceoDecisions: '320eb97f2a2381feb532db5d5063dd3f',
  reviews: '320eb97f2a2381719bf9f4298fd4dbd2',
}

// Determine which folder a doc should go into
function resolveParentFolder(taskType: string, agentTeam: string, agentName: string, phase: number): string {
  if (taskType === 'meeting') return FOLDERS.meetings
  if (taskType === 'review') return FOLDERS.reviews
  if (taskType === 'decide') return FOLDERS.ceoDecisions

  // Phase-specific sub-folders (Phase 1 has detailed structure)
  if (phase === 1) {
    if (agentName === 'Nina' || agentTeam === 'strategy' && taskType === 'research' && agentName === 'Nina') {
      return FOLDERS.p1.customer
    }
    if (agentName === 'Marcus') return FOLDERS.p1.analysis
    if (agentName === 'Priya' || agentName === 'Reza' || agentTeam === 'exec') return FOLDERS.p1.executive
    if (agentName === 'Zara') return FOLDERS.p1.market
    return FOLDERS.p1.market // default for Phase 1
  }

  // Other phases — go into the phase folder (sub-folders created as needed)
  return FOLDERS.phases[phase] ?? AGENTOS_PAGE_ID
}

// Rate-limited queue
const queue: Array<() => Promise<void>> = []
let processing = false

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  while (queue.length > 0) {
    const task = queue.shift()
    if (task) {
      try { await task() } catch (e) { console.error('[NOTION] Queue task failed:', e) }
      await new Promise(r => setTimeout(r, 350))
    }
  }
  processing = false
}

function enqueue(task: () => Promise<void>): void {
  queue.push(task)
  processQueue()
}

async function notionFetch(endpoint: string, body: any): Promise<any> {
  const res = await fetch('https://api.notion.com/v1' + endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + NOTION_API_KEY,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error('Notion API ' + res.status + ': ' + text.slice(0, 300))
  }
  return res.json()
}

export function isNotionConfigured(): boolean {
  return !!NOTION_API_KEY
}

export function logTaskToNotion(
  agentName: string,
  agentTeam: string,
  taskType: string,
  taskDescription: string,
  output: string,
  phase: number,
  simDay: number
): void {
  if (!isNotionConfigured()) return

  enqueue(async () => {
    try {
      await notionFetch('/pages', {
        parent: { database_id: ACTIVITY_LOG_DB },
        properties: {
          'Agent': { title: [{ text: { content: agentName } }] },
          'Action': { rich_text: [{ text: { content: (taskType + ': ' + taskDescription).slice(0, 1900) } }] },
          'Phase': { select: { name: 'phase_' + phase } },
          'Sim Day': { number: simDay },
          'Status': { select: { name: 'success' } },
          'Output': { rich_text: [{ text: { content: output.slice(0, 1900) } }] },
          'CFS Delta': { number: taskType === 'review' ? 0 : 1 },
        },
      })
      console.log('[NOTION] Logged activity: ' + agentName + ' - ' + taskType)
    } catch (e: any) {
      console.error('[NOTION] Activity log failed:', e.message ?? e)
    }
  })

  // Create doc pages for substantial outputs (research, write, decide, meeting)
  if (output.length > 1000 && ['research', 'write', 'decide', 'meeting'].includes(taskType)) {
    enqueue(async () => {
      try {
        const now = new Date()
        const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

        const children: any[] = []

        // For meetings, add structured metadata header
        if (taskType === 'meeting') {
          // Extract attendees from description (format: "Attendees: Name1, Name2, Name3")
          const attendeesMatch = taskDescription.match(/Attendees:\s*([^\n]+)/)
          const attendees = attendeesMatch ? attendeesMatch[1].trim() : agentTeam + ' team'

          // Extract meeting type from description
          const isMeetingExec = taskDescription.includes('EXEC STANDUP')
          const meetingType = isMeetingExec ? 'Executive Standup' : agentTeam.charAt(0).toUpperCase() + agentTeam.slice(1) + ' Team Sync'

          children.push(
            {
              object: 'block', type: 'callout',
              callout: {
                icon: { type: 'emoji', emoji: '\uD83D\uDCC5' },
                rich_text: [{ type: 'text', text: { content: meetingType + '\nDate: ' + dateStr + '\nTime: ' + timeStr + '\nFacilitator: ' + agentName + '\nAttendees: ' + attendees + '\nPhase: ' + phase + ' | Sim Day: ' + simDay } }],
              },
            },
            { object: 'block', type: 'divider', divider: {} },
          )
        }

        // Split output into chunks
        const chunks: string[] = []
        for (let i = 0; i < output.length; i += 1900) {
          chunks.push(output.slice(i, i + 1900))
        }
        for (const chunk of chunks.slice(0, 95)) {
          children.push({
            object: 'block', type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: chunk } }] },
          })
        }

        // Title format differs for meetings vs other docs
        let title: string
        if (taskType === 'meeting') {
          const teamLabel = taskDescription.includes('EXEC STANDUP') ? 'Exec' : agentTeam.charAt(0).toUpperCase() + agentTeam.slice(1)
          title = '[P' + phase + ' Meeting] ' + teamLabel + ' Team Sync - ' + dateStr
        } else {
          title = '[P' + phase + '] ' + agentName + ' - ' + taskDescription.slice(0, 80)
        }

        const parentId = resolveParentFolder(taskType, agentTeam, agentName, phase)
        await notionFetch('/pages', {
          parent: { page_id: parentId },
          properties: {
            title: { title: [{ text: { content: title } }] },
          },
          children,
        })
        console.log('[NOTION] Created doc: ' + title)
      } catch (e: any) {
        console.error('[NOTION] Doc creation failed:', e.message ?? e)
      }
    })
  }
}
