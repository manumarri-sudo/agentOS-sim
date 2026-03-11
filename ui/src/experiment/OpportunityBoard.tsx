import { useAPI } from '../hooks/useAPI'

interface Opportunity {
  id: string
  name: string
  description: string
  willingness_to_pay: number    // 0-25
  build_feasibility: number     // 0-20
  ai_unfair_advantage: number   // 0-20
  distribution_clarity: number  // 0-20
  competition_gap: number       // 0-15
  total_score: number           // max 100
  status: string                // 'scored' | 'shortlisted' | 'selected' | 'archived'
  scored_by: string
  scored_by_name?: string
  source_url?: string
  evidence_count?: number
  created_at: string
}

const DIMS = [
  { key: 'willingness_to_pay', label: 'WTP', max: 25, color: '#98c379' },
  { key: 'build_feasibility', label: 'Build', max: 20, color: '#61afef' },
  { key: 'ai_unfair_advantage', label: 'AI Edge', max: 20, color: '#c678dd' },
  { key: 'distribution_clarity', label: 'Distro', max: 20, color: '#e5c07b' },
  { key: 'competition_gap', label: 'Comp Gap', max: 15, color: '#d19a66' },
] as const

const STATUS_COLORS: Record<string, string> = {
  selected: '#98c379',
  shortlisted: '#61afef',
  scored: '#e5c07b',
  archived: '#5c6370',
}

export function OpportunityBoard() {
  const { data: opportunities } = useAPI<Opportunity[]>('/api/opportunities', 10000, [])

  const sorted = [...(opportunities ?? [])].sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0))
  const topThree = sorted.slice(0, 3)
  const rest = sorted.slice(3)

  return (
    <div className="p-3">
      <div className="text-[10px] text-muted tracking-[0.1em] mb-3">
        OPPORTUNITY BOARD
        <span className="text-muted ml-2">({(opportunities ?? []).length} scored)</span>
      </div>

      {(opportunities ?? []).length === 0 && (
        <div className="text-muted text-[11px] text-center py-8">
          No opportunities scored yet. Opportunities appear during Phase 1 Research
          when Zara and Marcus score the OpportunityVault.
        </div>
      )}

      {/* Top 3 — expanded cards */}
      {topThree.map((opp, rank) => (
        <div
          key={opp.id}
          className={`border p-3 mb-2 ${rank === 0 ? 'border-success/50 glow-success' : 'border-border'}`}
        >
          {/* Header */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[13px] font-semibold" style={{ color: rank === 0 ? '#98c379' : '#c5c8c6' }}>
              #{rank + 1}
            </span>
            <span className="text-text text-[12px] font-medium flex-1">{opp.name}</span>
            <span
              className="px-1.5 py-0.5 border text-[9px]"
              style={{ color: STATUS_COLORS[opp.status] ?? '#5c6370', borderColor: STATUS_COLORS[opp.status] ?? '#5c6370' }}
            >
              {opp.status}
            </span>
            <span className="text-text text-[13px] font-semibold">{opp.total_score}/100</span>
          </div>

          {/* Description */}
          {opp.description && (
            <div className="text-[10px] text-muted mb-2">{opp.description}</div>
          )}

          {/* 5-dimension scoring bars */}
          <div className="grid gap-1">
            {DIMS.map((dim) => {
              const val = (opp as any)[dim.key] ?? 0
              const pct = dim.max > 0 ? (val / dim.max) * 100 : 0
              return (
                <div key={dim.key} className="flex items-center gap-2">
                  <span className="text-[9px] text-muted w-12 text-right">{dim.label}</span>
                  <div className="flex-1 h-1.5 bg-border">
                    <div
                      className="h-full transition-all"
                      style={{ width: `${pct}%`, background: dim.color }}
                    />
                  </div>
                  <span className="text-[9px] text-muted w-8">{val}/{dim.max}</span>
                </div>
              )
            })}
          </div>

          {/* Metadata */}
          <div className="flex gap-3 mt-2 text-[9px] text-muted">
            {opp.scored_by_name && <span>Scored by {opp.scored_by_name}</span>}
            {opp.evidence_count != null && <span>{opp.evidence_count} evidence signals</span>}
            {opp.source_url && <span className="text-accent truncate">{opp.source_url}</span>}
          </div>
        </div>
      ))}

      {/* Rest — compact list */}
      {rest.length > 0 && (
        <>
          <div className="text-[9px] text-muted tracking-[0.05em] mb-1 mt-3">
            ARCHIVED ({rest.length})
          </div>
          {rest.map((opp, i) => (
            <div
              key={opp.id}
              className="flex items-center gap-2 text-[10px] py-1 border-b border-bg"
            >
              <span className="text-muted w-4 text-right">#{i + 4}</span>
              <span className="text-text truncate flex-1">{opp.name}</span>
              <span className="text-muted">{opp.total_score}/100</span>

              {/* Mini WTP indicator (key reject criterion: WTP < 12/25) */}
              {opp.willingness_to_pay < 12 && (
                <span className="text-danger text-[8px] px-1 border border-danger">LOW WTP</span>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  )
}
