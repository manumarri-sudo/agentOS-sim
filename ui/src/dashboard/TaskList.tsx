import { useState } from 'react'
import { useAPI } from '../hooks/useAPI'
import { fmtRelative, fmtDuration, fmtTime } from '../lib/utils'

const STATUS_STYLE: Record<string, { color: string; label: string; bg: string }> = {
  running:   { color: '#61afef', label: 'RUNNING',   bg: 'rgba(97,175,239,0.08)' },
  queued:    { color: '#5c6370', label: 'QUEUED',     bg: 'transparent' },
  completed: { color: '#98c379', label: 'DONE',       bg: 'rgba(152,195,121,0.06)' },
  proposed_complete: { color: '#e5c07b', label: 'VERIFYING', bg: 'rgba(229,192,123,0.06)' },
  failed:    { color: '#e06c75', label: 'FAILED',     bg: 'rgba(224,108,117,0.06)' },
  cancelled: { color: '#5c6370', label: 'CANCELLED',  bg: 'transparent' },
}

export function TaskList() {
  const { data: tasks } = useAPI<any[]>('/api/tasks/all', 3000, [])
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const running  = (tasks ?? []).filter(t => t.status === 'running')
  const queued   = (tasks ?? []).filter(t => t.status === 'queued')
  const completed = (tasks ?? []).filter(t => t.status === 'completed')
  const failed   = (tasks ?? []).filter(t => t.status === 'failed')

  return (
    <div className="p-4">
      <div className="flex items-center gap-3 mb-4">
        <div className="text-[11px] text-muted tracking-[0.1em]">TASK QUEUE</div>
        <div className="flex gap-3 text-[10px]">
          <span className="text-accent">{running.length} running</span>
          <span className="text-muted">{queued.length} queued</span>
          <span className="text-success">{completed.length} done</span>
          {failed.length > 0 && <span className="text-danger">{failed.length} failed</span>}
        </div>
      </div>

      {[...running, ...queued, ...completed, ...failed].map((task: any) => {
        const s = STATUS_STYLE[task.status] ?? STATUS_STYLE.queued
        const isExpanded = expandedId === task.id

        return (
          <div
            key={task.id}
            className="border border-border/50 mb-2 cursor-pointer hover:border-border transition-colors"
            style={{ background: s.bg, borderLeftColor: s.color, borderLeftWidth: 3 }}
            onClick={() => setExpandedId(isExpanded ? null : task.id)}
          >
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2">
              <span
                className="text-[8px] px-1.5 py-0.5 border tracking-wider shrink-0"
                style={{ color: s.color, borderColor: s.color }}
              >
                {s.label}
              </span>
              <span className="text-[10px] text-text font-medium">{task.agent_name}</span>
              <span className="text-[9px] text-muted uppercase">{task.type}</span>
              <span className="text-[8px] text-muted ml-auto flex items-center gap-2">
                {task.status === 'running' && task.started_at && (
                  <span className="text-accent">{fmtRelative(task.started_at)}</span>
                )}
                {task.status === 'completed' && task.completed_at && (
                  <>
                    <span className="text-success">{fmtTime(task.completed_at)}</span>
                    {task.started_at && (
                      <span className="text-muted">({fmtDuration(task.started_at, task.completed_at)})</span>
                    )}
                  </>
                )}
                {task.status === 'failed' && task.completed_at && (
                  <span className="text-danger">{fmtRelative(task.completed_at)}</span>
                )}
                Phase {task.phase}
              </span>
            </div>

            {/* Description - always visible */}
            <div className="px-3 pb-2 text-[11px] text-text/80 leading-relaxed">
              {task.description}
            </div>

            {/* Expanded: full output */}
            {isExpanded && task.status === 'completed' && task.result && (
              <div className="border-t border-border/30 px-3 py-2">
                <div className="text-[9px] text-success tracking-wider mb-1">AGENT OUTPUT</div>
                <div className="text-[10px] text-text/70 max-h-64 overflow-auto whitespace-pre-wrap font-mono leading-relaxed">
                  {task.result}
                </div>
              </div>
            )}

            {isExpanded && task.status === 'failed' && task.result && (
              <div className="border-t border-border/30 px-3 py-2">
                <div className="text-[9px] text-danger tracking-wider mb-1">ERROR</div>
                <div className="text-[10px] text-danger/70 max-h-32 overflow-auto whitespace-pre-wrap font-mono">
                  {task.result}
                </div>
              </div>
            )}
          </div>
        )
      })}

      {(tasks ?? []).length === 0 && (
        <div className="text-muted text-[11px]">No tasks yet. Start the orchestrator to begin.</div>
      )}
    </div>
  )
}
