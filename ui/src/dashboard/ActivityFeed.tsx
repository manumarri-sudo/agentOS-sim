import { fmtTime, TEAM_COLORS } from '../lib/utils'

interface ActivityFeedProps {
  events: any[]
}

const EVENT_ICONS: Record<string, string> = {
  RUN_STARTED: '\u25B6',
  RUN_FINISHED: '\u2713',
  TASK_FAILED: '\u2717',
  STATE_DELTA: '\u25C6',
  TEXT_MESSAGE_CONTENT: '\u2709',
  EXPERIMENT_STOPPED: '\u23F9',
  ORCHESTRATOR_ERROR: '\u26A0',
  connected: '\u2022',
}

const EVENT_COLORS: Record<string, string> = {
  RUN_STARTED: '#61afef',
  RUN_FINISHED: '#98c379',
  TASK_FAILED: '#e06c75',
  STATE_DELTA: '#5c6370',
  TEXT_MESSAGE_CONTENT: '#c5c8c6',
  EXPERIMENT_STOPPED: '#e06c75',
  ORCHESTRATOR_ERROR: '#e5c07b',
}

export function ActivityFeed({ events }: ActivityFeedProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-2 border-b border-border text-[10px] text-muted tracking-[0.1em] flex justify-between">
        <span>ACTIVITY FEED</span>
        <span>{events.length}</span>
      </div>

      <div className="flex-1 overflow-auto">
        {events.length === 0 && (
          <div className="p-4 text-muted text-[11px]">
            Waiting for events... Start the orchestrator to begin.
          </div>
        )}

        {events.map((ev, i) => {
          const type = ev.type ?? 'unknown'
          const color = EVENT_COLORS[type] ?? '#5c6370'
          const icon = EVENT_ICONS[type] ?? '\u2022'

          return (
            <div
              key={i}
              className="px-3 py-1.5 flex items-start gap-2 border-b border-bg text-[11px] hover:bg-border/20"
            >
              <span className="text-[9px] text-muted shrink-0 w-14 pt-0.5">
                {fmtTime(ev.timestamp)}
              </span>
              <span style={{ color }} className="shrink-0 w-3 text-center">
                {icon}
              </span>
              <div className="min-w-0 flex-1">
                <span style={{ color }} className="font-medium">
                  {type}
                </span>
                {ev.agentName && (
                  <span className="ml-2 text-muted">
                    {ev.agentName}
                  </span>
                )}
                {ev.taskDescription && (
                  <div className="text-muted text-[10px] truncate mt-0.5">
                    {ev.taskDescription}
                  </div>
                )}
                {ev.reason && (
                  <div className="text-warn text-[10px] mt-0.5">{ev.reason}</div>
                )}
                {ev.error && (
                  <div className="text-danger text-[10px] mt-0.5 truncate">{ev.error}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
