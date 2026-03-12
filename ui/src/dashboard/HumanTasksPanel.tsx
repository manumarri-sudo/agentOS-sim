import { useState } from 'react'
import { useAPI } from '../hooks/useAPI'
import { apiFetch } from '../lib/api'

const URGENCY_STYLE: Record<string, { color: string; bg: string }> = {
  critical: { color: '#e06c75', bg: 'rgba(224,108,117,0.12)' },
  high:     { color: '#e5c07b', bg: 'rgba(229,192,123,0.10)' },
  normal:   { color: '#61afef', bg: 'rgba(97,175,239,0.06)' },
  low:      { color: '#5c6370', bg: 'transparent' },
}

const CAT_ICON: Record<string, string> = {
  action: 'ACT',
  decision: 'DEC',
  access: 'KEY',
  review: 'REV',
  unblock: 'UNB',
}

export function HumanTasksPanel() {
  const { data: tasks, refetch } = useAPI<any[]>('/api/human-tasks', 5000, [])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [resolution, setResolution] = useState('')

  const pending = (tasks ?? []).filter((t: any) => t.status === 'pending')
  const completed = (tasks ?? []).filter((t: any) => t.status === 'completed')

  const handleComplete = async (taskId: string) => {
    if (!resolution.trim()) return
    await apiFetch(`/api/human-tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution }),
    })
    setResolution('')
    setExpandedId(null)
    refetch()
  }

  return (
    <div className="border-b border-border p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[11px] text-muted tracking-[0.1em]">YOUR TASKS</div>
        {pending.length > 0 ? (
          <span className="text-[9px] px-1.5 py-0.5 bg-danger/20 text-danger border border-danger/40 tracking-wider animate-pulse">
            {pending.length} NEED YOU
          </span>
        ) : (
          <span className="text-[9px] text-success tracking-wider">ALL CLEAR</span>
        )}
      </div>

      {pending.map((t: any) => {
        const u = URGENCY_STYLE[t.urgency] ?? URGENCY_STYLE.normal
        const isExpanded = expandedId === t.id

        return (
          <div
            key={t.id}
            className="mb-2 border border-border/50 cursor-pointer hover:border-border transition-colors"
            style={{ background: u.bg, borderLeftColor: u.color, borderLeftWidth: 3 }}
            onClick={() => setExpandedId(isExpanded ? null : t.id)}
          >
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <span
                className="text-[7px] px-1 py-0.5 border tracking-wider shrink-0 font-mono"
                style={{ color: u.color, borderColor: u.color }}
              >
                {CAT_ICON[t.category] ?? t.category?.toUpperCase()}
              </span>
              <span
                className="text-[7px] px-1 py-0.5 border tracking-wider shrink-0"
                style={{ color: u.color, borderColor: u.color }}
              >
                {t.urgency?.toUpperCase()}
              </span>
              <span className="text-[10px] text-text font-medium truncate">
                {t.requester_name}
              </span>
            </div>
            <div className="px-2 pb-1.5 text-[10px] text-text/80 leading-relaxed">
              {t.title.replace(/^"|"$/g, '')}
            </div>

            {isExpanded && (
              <div className="border-t border-border/30 px-2 py-2">
                <div className="text-[9px] text-muted max-h-32 overflow-auto whitespace-pre-wrap mb-2">
                  {t.description.slice(0, 500)}
                </div>
                <div className="flex gap-1">
                  <input
                    type="text"
                    placeholder="Resolution / what you did..."
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.key === 'Enter' && handleComplete(t.id)}
                    className="flex-1 bg-bg border border-border px-2 py-1 text-[10px] text-text focus:border-accent outline-none"
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); handleComplete(t.id) }}
                    className="px-2 py-1 border border-success text-success text-[9px] tracking-wider hover:bg-success/10"
                  >
                    DONE
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {completed.length > 0 && (
        <details className="mt-1">
          <summary className="text-[9px] text-success cursor-pointer hover:text-text">
            {completed.length} resolved
          </summary>
          <div className="mt-1 space-y-1">
            {completed.slice(0, 10).map((t: any) => (
              <div key={t.id} className="text-[9px] text-muted pl-2 border-l border-success/30">
                <span className="text-text/60">{t.requester_name}:</span> {t.title.replace(/^"|"$/g, '')}
                {t.resolution && (
                  <div className="text-success/70 italic">{t.resolution}</div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
