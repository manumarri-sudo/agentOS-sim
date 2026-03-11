import { TEAM_COLORS, STATUS_COLORS } from '../lib/utils'

interface TeamGridProps {
  agents: any[]
  cfs: any[]
  velocity: any[]
  activeProcesses: any[]
}

const TIER_LABELS: Record<number, string> = {
  0: 'Probation',
  1: 'Standard',
  2: 'Trusted',
  3: 'Senior',
}

const TIER_COLORS: Record<number, string> = {
  0: '#e06c75',
  1: '#5c6370',
  2: '#e5c07b',
  3: '#98c379',
}

export function TeamGrid({ agents, cfs, velocity, activeProcesses }: TeamGridProps) {
  const cfsMap: Record<string, any> = {}
  for (const c of cfs) cfsMap[c.agentId] = c

  const activeTaskMap: Record<string, any> = {}
  for (const p of activeProcesses) activeTaskMap[p.agentId] = p

  // Group by team
  const teams: Record<string, any[]> = {}
  for (const a of agents) {
    if (!teams[a.team]) teams[a.team] = []
    teams[a.team]!.push(a)
  }

  const teamOrder = ['exec', 'strategy', 'tech', 'ops', 'marketing']
  const teamLabels: Record<string, string> = {
    exec: 'Executive',
    strategy: 'Strategy',
    tech: 'Engineering',
    ops: 'Operations',
    marketing: 'Marketing',
  }

  return (
    <div className="p-4">
      <div className="text-[11px] text-muted tracking-[0.1em] mb-3">
        AGENTS <span className="text-text ml-1">{agents.length} total</span>
        <span className="text-accent ml-2">
          {agents.filter(a => a.status === 'working').length} working
        </span>
      </div>

      {teamOrder.map((team) => {
        const teamAgents = teams[team] ?? []
        if (teamAgents.length === 0) return null

        return (
          <div key={team} className="mb-4">
            {/* Team header */}
            <div className="flex items-center gap-2 mb-2">
              <span
                className="text-[10px] font-semibold tracking-[0.08em]"
                style={{ color: TEAM_COLORS[team] }}
              >
                {teamLabels[team] ?? team}
              </span>
              <div className="flex-1 h-px" style={{ background: TEAM_COLORS[team], opacity: 0.2 }} />
            </div>

            {/* Agent cards */}
            {teamAgents.map((agent: any) => {
              const agentCfs = cfsMap[agent.id]
              const tier = agentCfs?.tier ?? agent.capability_tier ?? 0
              const cfsScore = agentCfs?.cfs ?? agent.collaboration_score ?? 0
              const activeTask = activeTaskMap[agent.id]
              const isWorking = agent.status === 'working'

              return (
                <div
                  key={agent.id}
                  className={`mb-1.5 border border-border/40 px-3 py-2 transition-colors
                    ${isWorking ? 'border-l-2 border-l-accent bg-accent/5' : ''}`}
                >
                  {/* Name row */}
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="text-[8px]"
                      style={{ color: STATUS_COLORS[agent.status] ?? '#5c6370' }}
                    >
                      {'\u25CF'}
                    </span>
                    <span className="text-[12px] text-text font-medium">{agent.personality_name}</span>
                    <span className="text-[10px] text-muted">{agent.role}</span>

                    <div className="ml-auto flex items-center gap-3 text-[9px]">
                      {/* Priority */}
                      <span className="text-muted">
                        Priority{' '}
                        <span className={
                          agent.urgency >= 9 ? 'text-danger' :
                          agent.urgency >= 7 ? 'text-warn' : 'text-success'
                        }>
                          {agent.urgency}/10
                        </span>
                      </span>

                      {/* Trust tier */}
                      <span style={{ color: TIER_COLORS[tier] }}>
                        {TIER_LABELS[tier]}
                      </span>

                      {/* Collaboration score */}
                      <span className="text-muted">
                        Collab <span className="text-text">{cfsScore.toFixed(1)}</span>
                      </span>
                    </div>
                  </div>

                  {/* Current task */}
                  {isWorking && activeTask?.taskDescription && (
                    <div className="text-[10px] text-accent/80 mt-1 leading-relaxed">
                      <span className="text-[8px] text-muted uppercase mr-1">{activeTask.taskType}</span>
                      {activeTask.taskDescription}
                    </div>
                  )}

                  {/* Status for non-working */}
                  {!isWorking && agent.status !== 'idle' && (
                    <div className="text-[10px] mt-1" style={{ color: STATUS_COLORS[agent.status] }}>
                      {agent.status === 'suspended' ? 'Suspended' :
                       agent.status === 'rate_limited' ? 'Rate limited' :
                       agent.status === 'blocked' ? 'Blocked' :
                       agent.status}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
