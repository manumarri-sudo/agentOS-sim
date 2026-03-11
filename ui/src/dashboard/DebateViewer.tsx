import { fmtTime, fmtDate } from '../lib/utils'

interface DebateViewerProps {
  debates: any[]
}

const RESOLUTION_COLORS: Record<string, string> = {
  initiator_wins: '#98c379',
  responder_wins: '#61afef',
  compromise: '#e5c07b',
  escalated: '#e06c75',
}

export function DebateViewer({ debates }: DebateViewerProps) {
  return (
    <div className="p-3">
      <div className="text-[10px] text-muted tracking-[0.1em] mb-3">
        DEBATES <span className="text-muted">({debates.length})</span>
      </div>

      {debates.length === 0 && (
        <div className="text-muted text-[11px]">No debates recorded yet.</div>
      )}

      {debates.map((d: any) => (
        <div key={d.id} className="mb-3 border border-border p-2">
          {/* Topic */}
          <div className="text-[11px] text-text mb-1">{d.topic}</div>

          {/* Participants */}
          <div className="flex items-center gap-2 text-[10px] mb-2">
            <span className="text-accent">{d.initiator_name ?? d.initiator_id}</span>
            <span className="text-muted">vs</span>
            <span className="text-warn">{d.responder_name ?? d.responder_id}</span>
            <span className="text-muted ml-auto text-[9px]">{fmtDate(d.created_at)}</span>
          </div>

          {/* Positions */}
          {d.initiator_position && (
            <div className="text-[9px] mb-1">
              <span className="text-accent">{'\u25B8'}</span>
              <span className="text-muted ml-1 break-words">{d.initiator_position.slice(0, 100)}</span>
            </div>
          )}
          {d.responder_position && (
            <div className="text-[9px] mb-1">
              <span className="text-warn">{'\u25B8'}</span>
              <span className="text-muted ml-1 break-words">{d.responder_position.slice(0, 100)}</span>
            </div>
          )}

          {/* Resolution */}
          {d.resolution ? (
            <div className="text-[9px] mt-1">
              <span
                className="px-1 border"
                style={{
                  color: RESOLUTION_COLORS[d.resolution] ?? '#5c6370',
                  borderColor: RESOLUTION_COLORS[d.resolution] ?? '#5c6370',
                }}
              >
                {d.resolution.replace('_', ' ')}
              </span>
              {d.resolved_by_name && (
                <span className="text-muted ml-2">by {d.resolved_by_name}</span>
              )}
            </div>
          ) : (
            <div className="text-[9px] text-warn mt-1">
              {'\u25CF'} In progress
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
