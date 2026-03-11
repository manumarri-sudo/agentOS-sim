import { useAPI } from '../hooks/useAPI'

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string; label: string }> = {
  completed: { bg: 'rgba(152,195,121,0.15)', border: '#98c379', text: '#98c379', label: 'DONE' },
  running:   { bg: 'rgba(97,175,239,0.10)', border: '#61afef', text: '#61afef', label: 'RUNNING' },
  queued:    { bg: 'transparent', border: '#3e4451', text: '#5c6370', label: 'QUEUED' },
  proposed_complete: { bg: 'rgba(229,192,123,0.10)', border: '#e5c07b', text: '#e5c07b', label: 'VERIFYING' },
  failed:    { bg: 'rgba(224,108,117,0.10)', border: '#e06c75', text: '#e06c75', label: 'FAILED' },
  review:    { bg: 'rgba(198,120,221,0.10)', border: '#c678dd', text: '#c678dd', label: 'REVIEW' },
}

export function AgentTaskTracker() {
  const { data: tasks } = useAPI<any[]>('/api/tasks/all', 3000, [])
  const { data: agents } = useAPI<any[]>('/api/agents', 5000, [])

  // Group tasks by agent
  const agentTasks: Record<string, { agent: any; tasks: any[] }> = {}
  for (const a of (agents ?? [])) {
    agentTasks[a.id] = { agent: a, tasks: [] }
  }
  for (const t of (tasks ?? [])) {
    if (agentTasks[t.agent_id]) {
      agentTasks[t.agent_id].tasks.push(t)
    }
  }

  // Only show agents with tasks
  const agentsWithTasks = Object.values(agentTasks)
    .filter(({ tasks }) => tasks.length > 0)
    .sort((a, b) => {
      // Sort by: has running task first, then by completed count desc
      const aRunning = a.tasks.some(t => t.status === 'running') ? 1 : 0
      const bRunning = b.tasks.some(t => t.status === 'running') ? 1 : 0
      if (aRunning !== bRunning) return bRunning - aRunning
      const aDone = a.tasks.filter(t => t.status === 'completed').length
      const bDone = b.tasks.filter(t => t.status === 'completed').length
      return bDone - aDone
    })

  return (
    <div className="p-4">
      <div className="text-[11px] text-muted tracking-[0.1em] mb-4">
        TASK PROGRESS BY AGENT
      </div>

      {agentsWithTasks.map(({ agent, tasks: agentTaskList }) => {
        const total = agentTaskList.length
        const done = agentTaskList.filter(t => t.status === 'completed').length
        const pct = total > 0 ? Math.round((done / total) * 100) : 0

        return (
          <div key={agent.id} className="mb-5">
            {/* Agent header with progress bar */}
            <div className="flex items-center gap-3 mb-2">
              <span className="text-[12px] text-text font-medium w-20">{agent.personality_name}</span>
              <span className="text-[9px] text-muted w-24 truncate">{agent.role}</span>

              {/* Progress bar */}
              <div className="flex-1 h-2 bg-border/50 rounded-sm overflow-hidden">
                <div
                  className="h-full transition-all duration-500 rounded-sm"
                  style={{
                    width: `${pct}%`,
                    background: pct === 100 ? '#98c379' : '#61afef',
                  }}
                />
              </div>

              <span className="text-[10px] w-16 text-right" style={{
                color: pct === 100 ? '#98c379' : pct > 0 ? '#61afef' : '#5c6370'
              }}>
                {done}/{total} ({pct}%)
              </span>
            </div>

            {/* Task list */}
            <div className="ml-2 border-l border-border/40 pl-3">
              {agentTaskList.map((t: any) => {
                const s = t.type === 'review'
                  ? (STATUS_COLORS[t.status] ?? STATUS_COLORS.queued)
                  : (STATUS_COLORS[t.status] ?? STATUS_COLORS.queued)

                return (
                  <div
                    key={t.id}
                    className="flex items-start gap-2 py-1.5 border-b border-border/20 last:border-0"
                    style={{ background: s.bg }}
                  >
                    {/* Status indicator */}
                    <span
                      className="shrink-0 mt-0.5 w-2 h-2 rounded-full"
                      style={{
                        background: s.border,
                        boxShadow: t.status === 'running' ? `0 0 6px ${s.border}` : 'none',
                      }}
                    />

                    {/* Task info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[8px] px-1 py-0.5 border tracking-wider shrink-0"
                          style={{ color: s.text, borderColor: s.border }}>
                          {t.type === 'review' ? 'REVIEW' : s.label}
                        </span>
                        <span className="text-[9px] text-muted uppercase">{t.type}</span>
                      </div>
                      <div className="text-[10px] text-text/70 mt-0.5 leading-relaxed">
                        {t.description.length > 120 ? t.description.slice(0, 120) + '...' : t.description}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {agentsWithTasks.length === 0 && (
        <div className="text-muted text-[11px]">No tasks assigned yet.</div>
      )}
    </div>
  )
}
