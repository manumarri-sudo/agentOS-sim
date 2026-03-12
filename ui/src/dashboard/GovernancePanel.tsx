import { useAPI } from '../hooks/useAPI'
import { fmtRelative } from '../lib/utils'

const EVENT_TYPE_LABELS: Record<string, { label: string; color: string; icon: string }> = {
  verification_failure: { label: 'Verification Failed', color: '#e5c07b', icon: '\u2717' },
  quality_escalation: { label: 'Quality Escalation', color: '#e06c75', icon: '\u26A0' },
  permission_decay: { label: 'Permission Issue', color: '#c678dd', icon: '\u26D4' },
  reward_manipulation_attempt: { label: 'Reward Manipulation', color: '#e06c75', icon: '\u2622' },
  unauthorized_access: { label: 'Unauthorized Access', color: '#5c6370', icon: '\u2716' },
  forbidden_file_touch: { label: 'Protected File Touch', color: '#e06c75', icon: '\u26A0' },
  budget_boundary_probe: { label: 'Budget Probe', color: '#e5c07b', icon: '$' },
  trust_ladder_advancement: { label: 'Trust Upgrade', color: '#98c379', icon: '\u2191' },
  deadline_beat: { label: 'Deadline Beat', color: '#98c379', icon: '\u2713' },
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#e06c75',
  warning: '#e5c07b',
  info: '#5c6370',
}

export function GovernancePanel() {
  const { data: events } = useAPI<any[]>('/api/governance/events?limit=200', 15000, [])

  if (!events || events.length === 0) {
    return (
      <div className="p-6">
        <div className="text-muted text-[11px]">No governance events recorded yet.</div>
      </div>
    )
  }

  // Summary counts by type
  const typeCounts: Record<string, number> = {}
  const severityCounts: Record<string, number> = { critical: 0, warning: 0, info: 0 }
  const agentCounts: Record<string, { name: string; count: number; types: Record<string, number> }> = {}

  for (const ev of events) {
    typeCounts[ev.event_type] = (typeCounts[ev.event_type] ?? 0) + 1
    severityCounts[ev.severity ?? 'info'] = (severityCounts[ev.severity ?? 'info'] ?? 0) + 1
    if (ev.agent_id) {
      if (!agentCounts[ev.agent_id]) agentCounts[ev.agent_id] = { name: ev.agent_name ?? ev.agent_id, count: 0, types: {} }
      agentCounts[ev.agent_id].count++
      agentCounts[ev.agent_id].types[ev.event_type] = (agentCounts[ev.agent_id].types[ev.event_type] ?? 0) + 1
    }
  }

  const sortedAgents = Object.entries(agentCounts).sort((a, b) => b[1].count - a[1].count)

  return (
    <div className="h-full flex flex-col">
      {/* Summary bar */}
      <div className="p-4 border-b border-border">
        <div className="text-[10px] text-muted tracking-[0.1em] mb-3">GOVERNANCE SUMMARY</div>
        <div className="flex gap-6 flex-wrap">
          <div className="text-center">
            <div className="text-[20px] font-semibold" style={{ color: '#e06c75' }}>{severityCounts.critical}</div>
            <div className="text-[9px] text-muted uppercase tracking-wider">Critical</div>
          </div>
          <div className="text-center">
            <div className="text-[20px] font-semibold" style={{ color: '#e5c07b' }}>{severityCounts.warning}</div>
            <div className="text-[9px] text-muted uppercase tracking-wider">Warning</div>
          </div>
          <div className="text-center">
            <div className="text-[20px] font-semibold" style={{ color: '#5c6370' }}>{severityCounts.info}</div>
            <div className="text-[9px] text-muted uppercase tracking-wider">Info</div>
          </div>
          <div className="border-l border-border pl-6 flex gap-4 flex-wrap">
            {Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => {
              const meta = EVENT_TYPE_LABELS[type] ?? { label: type, color: '#5c6370', icon: '?' }
              return (
                <div key={type} className="text-center">
                  <div className="text-[14px] font-medium" style={{ color: meta.color }}>{count}</div>
                  <div className="text-[9px] text-muted">{meta.label}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* KEY / LEGEND */}
      <div className="px-4 py-3 border-b border-border bg-panel/50">
        <div className="text-[9px] text-muted tracking-[0.1em] mb-2">KEY</div>
        <div className="flex gap-x-6 gap-y-1.5 flex-wrap">
          {/* Severity levels */}
          <div className="flex items-center gap-4">
            <span className="text-[9px] text-muted uppercase tracking-wider mr-1">Severity:</span>
            {Object.entries(SEVERITY_COLORS).map(([level, color]) => (
              <span key={level} className="flex items-center gap-1 text-[9px]">
                <span className="inline-block w-2 h-2 rounded-sm" style={{ background: color }} />
                <span style={{ color }}>{level}</span>
              </span>
            ))}
          </div>
          {/* Event types */}
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-[9px] text-muted uppercase tracking-wider mr-1">Events:</span>
            {Object.entries(EVENT_TYPE_LABELS).map(([type, meta]) => (
              <span key={type} className="flex items-center gap-1 text-[9px]">
                <span style={{ color: meta.color }}>{meta.icon}</span>
                <span style={{ color: meta.color }}>{meta.label}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Event timeline */}
        <div className="flex-1 overflow-auto">
          <div className="p-4">
            <div className="text-[10px] text-muted tracking-[0.1em] mb-3">EVENT TIMELINE</div>
            {events.map((ev: any) => {
              const meta = EVENT_TYPE_LABELS[ev.event_type] ?? { label: ev.event_type, color: '#5c6370', icon: '?' }
              const sevColor = SEVERITY_COLORS[ev.severity ?? 'info'] ?? '#5c6370'
              return (
                <div key={ev.id} className="mb-2 border-l-2 px-3 py-2" style={{ borderLeftColor: sevColor, background: `${sevColor}08` }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px]" style={{ color: meta.color }}>{meta.icon}</span>
                    <span className="text-[11px] font-medium" style={{ color: meta.color }}>{meta.label}</span>
                    {ev.agent_name && (
                      <span className="text-[10px] text-text/70">{ev.agent_name}</span>
                    )}
                    <span className="ml-auto text-[9px] text-muted">{fmtRelative(ev.created_at)}</span>
                    <span className="text-[8px] px-1.5 py-0.5 rounded" style={{
                      color: sevColor,
                      border: `1px solid ${sevColor}40`,
                    }}>{ev.severity ?? 'info'}</span>
                  </div>
                  <div className="text-[10px] text-text/60 leading-relaxed">{ev.details}</div>
                  {ev.route && (
                    <div className="text-[9px] text-muted mt-1 font-mono">{ev.route}</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Agent breakdown sidebar */}
        <div className="w-[260px] border-l border-border overflow-auto">
          <div className="p-4">
            <div className="text-[10px] text-muted tracking-[0.1em] mb-3">BY AGENT</div>
            {sortedAgents.length === 0 ? (
              <div className="text-muted text-[10px]">No agent-specific events.</div>
            ) : (
              sortedAgents.map(([agentId, info]) => (
                <div key={agentId} className="mb-3 pb-2 border-b border-border/50">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] font-medium">{info.name}</span>
                    <span className="text-[10px] text-muted">{info.count} events</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(info.types).sort((a, b) => b[1] - a[1]).map(([type, count]) => {
                      const meta = EVENT_TYPE_LABELS[type] ?? { label: type, color: '#5c6370', icon: '?' }
                      return (
                        <span key={type} className="text-[9px] px-1.5 py-0.5 rounded" style={{
                          color: meta.color,
                          border: `1px solid ${meta.color}30`,
                          background: `${meta.color}10`,
                        }}>
                          {count} {meta.label.split(' ')[0].toLowerCase()}
                        </span>
                      )
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
