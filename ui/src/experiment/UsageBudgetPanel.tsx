import { useAPI } from '../hooks/useAPI'
import { costColor } from '../lib/utils'

const THROTTLE_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: 'Normal', color: '#98c379' },
  1: { label: 'Mild (4 agents)', color: '#e5c07b' },
  2: { label: 'Moderate (3 agents)', color: '#d19a66' },
  3: { label: 'Aggressive (2 agents)', color: '#e06c75' },
  4: { label: 'Paused', color: '#e06c75' },
}

export function UsageBudgetPanel() {
  const { data: usage } = useAPI<any>('/api/usage/summary', 10000)

  if (!usage) {
    return (
      <div className="border-b border-border p-3">
        <div className="text-[10px] text-muted tracking-[0.1em] mb-2">USAGE BUDGET</div>
        <div className="text-muted text-[11px]">
          Usage tracking not yet initialized. Start the orchestrator.
        </div>
      </div>
    )
  }

  const sonnetPct = usage.sonnetBudget > 0
    ? (usage.sonnetUsed / usage.sonnetBudget) * 100
    : 0
  const opusPct = usage.opusBudget > 0
    ? (usage.opusUsed / usage.opusBudget) * 100
    : 0

  const throttle = THROTTLE_LABELS[usage.throttleLevel ?? 0] ?? THROTTLE_LABELS[0]!

  return (
    <div className="border-b border-border p-3">
      <div className="text-[10px] text-muted tracking-[0.1em] mb-3">
        USAGE BUDGET
        {usage.weekNumber && (
          <span className="text-text ml-2">Week {usage.weekNumber} of 5</span>
        )}
      </div>

      {/* Sonnet bar */}
      <div className="mb-3">
        <div className="flex justify-between text-[10px] mb-1">
          <span className="text-muted">Sonnet</span>
          <span style={{ color: costColor(sonnetPct) }}>
            {usage.sonnetUsed?.toFixed(1)} / {usage.sonnetBudget}h ({sonnetPct.toFixed(0)}%)
          </span>
        </div>
        <div className="h-1.5 bg-border">
          <div
            className="h-full transition-all"
            style={{ width: `${Math.min(100, sonnetPct)}%`, background: costColor(sonnetPct) }}
          />
        </div>
      </div>

      {/* Opus bar */}
      <div className="mb-3">
        <div className="flex justify-between text-[10px] mb-1">
          <span className="text-muted">Opus</span>
          <span style={{ color: costColor(opusPct) }}>
            {usage.opusUsed?.toFixed(1)} / {usage.opusBudget}h ({opusPct.toFixed(0)}%)
          </span>
        </div>
        <div className="h-1.5 bg-border">
          <div
            className="h-full transition-all"
            style={{ width: `${Math.min(100, opusPct)}%`, background: costColor(opusPct) }}
          />
        </div>
      </div>

      {/* Throttle indicator */}
      <div className="flex items-center gap-2 mb-2 text-[10px]">
        <span className="text-muted">Throttle:</span>
        <span
          className="px-1.5 py-0.5 border text-[9px]"
          style={{ color: throttle.color, borderColor: throttle.color }}
        >
          {throttle.label}
        </span>
      </div>

      {/* Headroom */}
      <div className="text-[9px] text-muted">
        Your headroom: {usage.sonnetReserved ?? 40}h Sonnet + {usage.opusReserved ?? 8}h Opus reserved
      </div>

      {/* Reset timer */}
      {usage.resetsIn && (
        <div className="text-[9px] text-muted mt-1">
          Resets in: <span className="text-text">{usage.resetsIn}</span>
        </div>
      )}
    </div>
  )
}
