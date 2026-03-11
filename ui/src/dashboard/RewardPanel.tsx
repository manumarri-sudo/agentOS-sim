import { TIER_COLORS, TIER_NAMES, TEAM_COLORS } from '../lib/utils'

interface RewardPanelProps {
  cfs: any[]
  attribution: any[]
  blockers: any[]
}

export function RewardPanel({ cfs, attribution, blockers }: RewardPanelProps) {
  // Sort CFS descending
  const sortedCfs = [...cfs].sort((a, b) => (b.cfs ?? 0) - (a.cfs ?? 0))

  return (
    <div className="border-b border-border p-3">
      <div className="text-[10px] text-muted tracking-[0.1em] mb-3">REWARD SYSTEM</div>

      {/* CFS leaderboard */}
      <div className="text-[9px] text-muted tracking-[0.05em] mb-1">CFS RANKINGS</div>
      <div className="mb-3">
        {sortedCfs.slice(0, 8).map((agent: any, i: number) => (
          <div
            key={agent.agentId}
            className="flex items-center gap-2 py-0.5 text-[10px]"
          >
            <span className="text-muted w-3 text-right">{i + 1}</span>
            <span className="text-text flex-1 truncate">{agent.personalityName}</span>
            <span
              className="px-1 border text-[8px]"
              style={{
                color: TIER_COLORS[agent.tier ?? 0],
                borderColor: TIER_COLORS[agent.tier ?? 0],
              }}
            >
              {TIER_NAMES[agent.tier ?? 0]}
            </span>
            <span className="text-text w-8 text-right">{(agent.cfs ?? 0).toFixed(1)}</span>
          </div>
        ))}
      </div>

      {/* Revenue attribution */}
      {attribution.length > 0 && (
        <>
          <div className="text-[9px] text-muted tracking-[0.05em] mb-1 mt-3">REVENUE ATTRIBUTION</div>
          {attribution.slice(0, 5).map((a: any) => (
            <div key={a.agentId} className="flex items-center gap-2 py-0.5 text-[10px]">
              <span className="text-text flex-1 truncate">{a.personalityName}</span>
              <span className="text-success">{((a.totalShare ?? 0) * 100).toFixed(0)}%</span>
              {a.totalRevenue > 0 && (
                <span className="text-muted">${a.totalRevenue.toFixed(2)}</span>
              )}
            </div>
          ))}
        </>
      )}

      {/* Active blockers */}
      {blockers.length > 0 && (
        <>
          <div className="text-[9px] text-muted tracking-[0.05em] mb-1 mt-3">
            ACTIVE BLOCKERS <span className="text-danger">({blockers.length})</span>
          </div>
          {blockers.map((b: any) => (
            <div key={b.id} className="py-1 text-[10px] border-b border-bg">
              <div className="flex items-center gap-2">
                <span className="text-danger text-[8px]">{'\u26A0'}</span>
                <span className="text-text">{b.agentName}</span>
                <span className="text-muted ml-auto">{b.durationMinutes}m</span>
              </div>
              <div className="text-muted text-[9px] truncate ml-4">{b.reason}</div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
