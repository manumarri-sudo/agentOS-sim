import { useAPI } from '../hooks/useAPI'
import { fmtDate, fmtDollars } from '../lib/utils'

export function ReportViewer() {
  const { data: reports } = useAPI<any[]>('/api/reports', 15000, [])

  const TRIGGER_COLORS: Record<string, string> = {
    phase_complete: '#98c379',
    revenue_event: '#e5c07b',
    blocker_escalation: '#e06c75',
    final: '#61afef',
  }

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <div className="text-[10px] text-muted tracking-[0.1em] mb-4">EXPERIMENT REPORTS</div>

      {(reports ?? []).length === 0 && (
        <div className="text-muted text-[11px] text-center py-8">
          No reports generated yet. Reports are triggered by phase completions,
          revenue events, blocker escalations, and experiment end.
        </div>
      )}

      {(reports ?? []).map((r: any) => (
        <div key={r.id} className="border border-border p-4 mb-4">
          {/* Header */}
          <div className="flex items-center gap-3 mb-3">
            <span
              className="px-2 py-0.5 border text-[9px] tracking-[0.05em]"
              style={{
                color: TRIGGER_COLORS[r.trigger_type] ?? '#5c6370',
                borderColor: TRIGGER_COLORS[r.trigger_type] ?? '#5c6370',
              }}
            >
              {r.trigger_type?.replace('_', ' ').toUpperCase()}
            </span>
            <span className="text-muted text-[10px]">Phase {r.phase}</span>
            <span className="text-muted text-[10px]">by {r.author_agent}</span>
            <span className="text-muted text-[9px] ml-auto">{fmtDate(r.created_at)}</span>
          </div>

          {/* Summary */}
          <div className="text-[11px] text-text mb-3 whitespace-pre-wrap leading-relaxed">
            {r.summary}
          </div>

          {/* Metrics row */}
          <div className="grid grid-cols-3 gap-3 text-[10px] border-t border-border pt-3">
            {r.budget_spent != null && (
              <div>
                <div className="text-muted text-[9px]">Budget Spent</div>
                <div className="text-warn">{fmtDollars(r.budget_spent)}</div>
              </div>
            )}
            {r.budget_remaining != null && (
              <div>
                <div className="text-muted text-[9px]">Budget Remaining</div>
                <div className="text-success">{fmtDollars(r.budget_remaining)}</div>
              </div>
            )}
            {r.revenue_to_date != null && (
              <div>
                <div className="text-muted text-[9px]">Revenue to Date</div>
                <div className="text-success">{fmtDollars(r.revenue_to_date)}</div>
              </div>
            )}
          </div>

          {/* Team reports */}
          {r.team_reports && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-[9px] text-muted tracking-[0.05em] mb-1">TEAM REPORTS</div>
              <div className="text-[10px] text-muted whitespace-pre-wrap">{r.team_reports}</div>
            </div>
          )}

          {/* Blockers */}
          {r.blockers && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-[9px] text-danger tracking-[0.05em] mb-1">BLOCKERS</div>
              <div className="text-[10px] text-muted whitespace-pre-wrap">{r.blockers}</div>
            </div>
          )}

          {/* Decisions */}
          {r.decisions && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-[9px] text-accent tracking-[0.05em] mb-1">KEY DECISIONS</div>
              <div className="text-[10px] text-muted whitespace-pre-wrap">{r.decisions}</div>
            </div>
          )}

          {/* Next priority */}
          {r.next_priority && (
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-[9px] text-accent tracking-[0.05em] mb-1">NEXT PRIORITY</div>
              <div className="text-[10px] text-text">{r.next_priority}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
