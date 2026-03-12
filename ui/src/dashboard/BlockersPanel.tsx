import { useAPI } from '../hooks/useAPI'

// ---------------------------------------------------------------------------
// BlockersPanel -- War Room Alert Strip
//
// Sits at the top of the right sidebar. Flashes red when:
// - Agents are blocked (deadlocks, unmet quorums)
// - Governance anomalies detected (phantom citations, etc.)
// Renders null when everything is clear.
// ---------------------------------------------------------------------------

interface Blocker {
  id: string
  agent_id: string
  personality_name?: string
  reason: string
  created_at: string
}

interface Anomaly {
  id: string
  anomaly_type: string
  agent_id: string
  agent_name?: string
  details: string
  severity: string
  resolved: number
}

const ANOMALY_LABELS: Record<string, string> = {
  phantom_citation: 'Phantom Citation',
  false_approval: 'False Approval',
  circular_reasoning: 'Circular Reasoning',
  budget_delusion: 'Budget Delusion',
}

export function BlockersPanel() {
  const { data: blockers } = useAPI<Blocker[]>('/api/reward/blockers', 5000, [])
  const { data: anomalies } = useAPI<Anomaly[]>('/api/governance/anomalies?limit=10', 10000, [])

  const activeBlockers = blockers ?? []
  const unresolvedAnomalies = (anomalies ?? []).filter(a => !a.resolved)

  if (activeBlockers.length === 0 && unresolvedAnomalies.length === 0) return null

  return (
    <div className="border-b border-red-500/30 p-3" style={{
      background: activeBlockers.length > 0 ? 'rgba(224, 108, 117, 0.05)' : undefined,
      animation: activeBlockers.length > 0 ? 'pulse 2s ease-in-out infinite' : undefined,
    }}>
      <div className="text-[10px] tracking-[0.1em] mb-2" style={{ color: '#e06c75' }}>
        BLOCKERS & ALERTS ({activeBlockers.length + unresolvedAnomalies.length})
      </div>

      {activeBlockers.map(b => (
        <div key={b.id} className="text-[10px] mb-1.5 pl-2" style={{
          borderLeft: '2px solid #e06c75',
          color: 'rgba(224, 108, 117, 0.9)',
        }}>
          <span className="font-semibold">{b.personality_name ?? b.agent_id}</span>
          {': '}
          <span style={{ color: 'rgba(224, 108, 117, 0.7)' }}>{b.reason}</span>
        </div>
      ))}

      {unresolvedAnomalies.map(a => (
        <div key={a.id} className="text-[10px] mb-1.5 pl-2" style={{
          borderLeft: '2px solid #e5c07b',
          color: 'rgba(229, 192, 123, 0.9)',
        }}>
          <span className="font-semibold">{ANOMALY_LABELS[a.anomaly_type] ?? a.anomaly_type}</span>
          {' -- '}
          <span style={{ color: 'rgba(229, 192, 123, 0.7)' }}>
            {a.agent_name ?? a.agent_id}: {a.details?.slice(0, 100)}
          </span>
        </div>
      ))}
    </div>
  )
}
