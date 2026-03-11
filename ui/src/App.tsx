import { useState } from 'react'
import { useAPI, useSSE } from './hooks/useAPI'
import { getToken, setToken } from './lib/api'
import { fmtRelative, fmtTime, fmtDuration } from './lib/utils'
import { Header } from './components/Header'
import { TeamGrid } from './dashboard/TeamGrid'
import { TaskList } from './dashboard/TaskList'
import { ActivityFeed } from './dashboard/ActivityFeed'
import { MessageBus } from './dashboard/MessageBus'
import { BudgetTracker } from './dashboard/BudgetTracker'
import { RewardPanel } from './dashboard/RewardPanel'
import { DebateViewer } from './dashboard/DebateViewer'
import { PhaseGate } from './experiment/PhaseGate'
import { MarketingQueue } from './experiment/MarketingQueue'
import { OpportunityBoard } from './experiment/OpportunityBoard'
import { UsageBudgetPanel } from './experiment/UsageBudgetPanel'
import { TokenCostPanel } from './experiment/TokenCostPanel'
import { DirectiveBox } from './components/DirectiveBox'
import { ReportViewer } from './reports/ReportViewer'
import { AgentTaskTracker } from './dashboard/AgentTaskTracker'
import { CEOChat } from './dashboard/CEOChat'

type Tab = 'overview' | 'tasks' | 'agents' | 'experiment' | 'reports'

function LoginGate({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="h-screen flex items-center justify-center bg-bg">
      <div className="border border-border p-6 w-80">
        <div className="text-accent text-[13px] font-semibold tracking-[0.12em] mb-1">AGENTOS</div>
        <div className="text-muted text-[10px] tracking-[0.08em] mb-6">MISSION CONTROL</div>
        <input
          type="password"
          placeholder="Dashboard token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && value && onLogin(value)}
          className="w-full bg-bg border border-border px-3 py-2 text-text text-[12px] focus:border-accent outline-none mb-3"
          autoFocus
        />
        <button
          onClick={() => value && onLogin(value)}
          className="w-full border border-accent text-accent text-[11px] tracking-wider py-1.5 hover:bg-accent/10 transition-colors"
        >
          ENTER
        </button>
      </div>
    </div>
  )
}

export function App() {
  const [authenticated, setAuthenticated] = useState(!!getToken())
  const [tab, setTab] = useState<Tab>('overview')

  if (!authenticated) {
    return (
      <LoginGate
        onLogin={(token) => {
          setToken(token)
          setAuthenticated(true)
        }}
      />
    )
  }

  // Core data
  // Polling intervals tuned to reduce server load
  const { data: agents } = useAPI<any[]>('/api/agents', 10000, [])
  const { data: phases } = useAPI<any[]>('/api/phases', 15000, [])
  const { data: budget } = useAPI<any>('/api/budget', 15000)
  const { data: clock } = useAPI<any>('/api/clock', 15000)
  const { data: orchestrator } = useAPI<any>('/api/orchestrator/status', 10000)
  const { data: messages } = useAPI<any[]>('/api/messages?limit=200', 15000, [])
  const { data: cfs } = useAPI<any[]>('/api/reward/cfs', 30000, [])
  const { data: velocity } = useAPI<any[]>('/api/reward/velocity', 30000, [])
  const { data: blockers } = useAPI<any[]>('/api/reward/blockers', 30000, [])
  const { data: attribution } = useAPI<any[]>('/api/reward/attribution', 30000, [])
  const { data: debates } = useAPI<any[]>('/api/debates', 30000, [])
  const { data: activeProcesses } = useAPI<any[]>('/api/agents/active', 8000, [])
  const { data: allTasks } = useAPI<any[]>('/api/tasks/all', 8000, [])
  const { data: activityLog } = useAPI<any[]>('/api/activity?limit=200', 10000, [])

  const { connected, events: sseEvents } = useSSE('/stream')

  const activePhase = phases?.find((p: any) => p.status === 'active')
  const phaseNumber = activePhase?.phase_number ?? 0

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'agents', label: 'Agents' },
    { id: 'experiment', label: 'Experiment' },
    { id: 'reports', label: 'Reports' },
  ]

  return (
    <div className="h-screen flex flex-col">
      <Header
        connected={connected}
        simDay={clock?.sim_day ?? 0}
        phase={activePhase}
        orchestratorRunning={orchestrator?.running ?? false}
        budget={budget}
      />

      {/* Tab bar */}
      <div className="flex border-b border-border bg-panel px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-[11px] tracking-wider uppercase transition-colors
              ${tab === t.id ? 'text-accent border-b border-accent' : 'text-muted hover:text-text'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">

        {/* OVERVIEW — the main view */}
        {tab === 'overview' && (
          <div className="h-full grid grid-cols-[1fr_380px] gap-0">
            {/* Left: scrollable feed of what's happening */}
            <div className="overflow-auto">
              {/* Phase status bar */}
              <div className="border-b border-border p-4">
                <div className="flex items-center gap-4">
                  {phases?.map((p: any) => {
                    const isActive = p.status === 'active'
                    const isDone = p.status === 'complete'
                    return (
                      <div
                        key={p.phase_number}
                        className={`flex items-center gap-1.5 text-[11px]
                          ${isActive ? 'text-accent' : isDone ? 'text-success' : 'text-muted'}`}
                      >
                        <span className="text-[10px]">
                          {isDone ? '\u2713' : isActive ? '\u25B6' : '\u25CB'}
                        </span>
                        <span className={isActive ? 'font-medium' : ''}>
                          Phase {p.phase_number}: {p.name}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Currently working agents */}
              {(() => {
                const workingAgents = (agents ?? []).filter((a: any) => a.status === 'working')
                const runningTasks = (allTasks ?? []).filter((t: any) => t.status === 'running')
                // Match working agents to their running tasks
                const agentTasks = workingAgents.map((a: any) => {
                  const task = runningTasks.find((t: any) => t.agent_id === a.id)
                  // Also check activeProcesses for enriched task info
                  const proc = (activeProcesses ?? []).find((p: any) => p.agentId === a.id)
                  return { agent: a, task, proc }
                })

                return (
                  <div className="border-b border-border p-4">
                    <div className="text-[11px] text-muted tracking-[0.1em] mb-3">
                      CURRENTLY WORKING
                      <span className="text-accent ml-2">
                        {workingAgents.length} agents active
                      </span>
                    </div>
                    {workingAgents.length === 0 ? (
                      <div className="text-muted text-[11px]">No agents running right now.</div>
                    ) : (
                      agentTasks.map(({ agent, task, proc }) => (
                        <div key={agent.id} className="border-l-2 border-l-accent bg-accent/5 px-3 py-2 mb-2">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[12px] text-text font-medium">{agent.personality_name}</span>
                            <span className="text-[10px] text-muted">{agent.role}</span>
                            <span className="text-[9px] text-muted uppercase ml-auto">
                              {task?.type ?? proc?.taskType ?? ''}
                            </span>
                          </div>
                          <div className="text-[11px] text-accent/80 leading-relaxed">
                            {(task?.description ?? proc?.taskDescription ?? 'Working...').split('\n')[0].slice(0, 120)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )
              })()}

              {/* Completed work — high-level bullets grouped by agent */}
              <div className="border-b border-border p-4">
                <div className="text-[11px] text-muted tracking-[0.1em] mb-3">
                  COMPLETED WORK
                  <span className="text-success ml-2">
                    {(allTasks ?? []).filter((t: any) => t.status === 'completed').length} tasks
                  </span>
                </div>
                {(() => {
                  const done = (allTasks ?? []).filter((t: any) => t.status === 'completed')
                  if (done.length === 0) return <div className="text-muted text-[11px]">No completed tasks yet.</div>

                  // Group by agent
                  const byAgent: Record<string, any[]> = {}
                  for (const t of done) {
                    const name = t.agent_name ?? 'Unknown'
                    if (!byAgent[name]) byAgent[name] = []
                    byAgent[name].push(t)
                  }

                  return Object.entries(byAgent).map(([name, tasks]) => (
                    <div key={name} className="mb-2">
                      <div className="text-[11px] text-text font-medium mb-1">
                        <span className="text-success text-[9px] mr-1">{'\u2713'}</span>
                        {name}
                        <span className="text-muted font-normal ml-1">({tasks.length})</span>
                      </div>
                      {tasks.map((t: any) => {
                        // Extract just the first sentence/line of description
                        const shortDesc = t.description.split('\n')[0].slice(0, 100)
                        return (
                          <div key={t.id} className="text-[10px] text-text/60 pl-4 mb-0.5 leading-relaxed">
                            <span className="text-muted mr-1">{'\u2022'}</span>
                            <span className="text-[9px] text-muted uppercase mr-1">{t.type}</span>
                            {shortDesc}{shortDesc.length >= 100 ? '...' : ''}
                          </div>
                        )
                      })}
                    </div>
                  ))
                })()}
              </div>

              {/* Agent Activity — filtered to meaningful events only */}
              <div className="border-b border-border p-4">
                {(() => {
                  // Filter out noise: used_work and notified are internal plumbing
                  const meaningful = (activityLog ?? []).filter((ev: any) =>
                    !['used_work', 'notified'].includes(ev.event_type)
                  )
                  return (
                    <>
                      <div className="text-[11px] text-muted tracking-[0.1em] mb-3">
                        ACTIVITY
                        <span className="text-text ml-2">{meaningful.length} events</span>
                      </div>
                      {meaningful.length === 0 ? (
                        <div className="text-muted text-[11px]">No activity yet.</div>
                      ) : (
                        meaningful.map((ev: any) => (
                          <div key={ev.id} className="flex items-start gap-2 mb-1.5 text-[11px]">
                            <span className="text-[9px] text-muted shrink-0 w-8 pt-0.5">
                              D{ev.sim_day}
                            </span>
                            <span className="text-[9px] shrink-0 pt-0.5" style={{
                              color: ev.event_type === 'task_completed' ? '#98c379' :
                                     ev.event_type === 'handoff' ? '#e5c07b' :
                                     ev.event_type === 'review_requested' ? '#c678dd' :
                                     ev.event_type === 'review_assigned' ? '#c678dd' :
                                     ev.event_type === 'meeting_scheduled' ? '#e5c07b' :
                                     ev.event_type === 'human_directive' ? '#61afef' :
                                     '#c5c8c6'
                            }}>
                              {ev.event_type === 'task_completed' ? '\u2713' :
                               ev.event_type === 'handoff' ? '\u2192' :
                               ev.event_type === 'review_requested' ? '\u2605' :
                               ev.event_type === 'review_assigned' ? '\u2605' :
                               ev.event_type === 'meeting_scheduled' ? '\u2606' :
                               ev.event_type === 'human_directive' ? '\u25B6' :
                               '\u2022'}
                            </span>
                            <span className="text-text/80">{ev.summary}</span>
                          </div>
                        ))
                      )}
                    </>
                  )
                })()}
              </div>

              {/* Queued tasks */}
              <div className="p-4">
                <div className="text-[11px] text-muted tracking-[0.1em] mb-3">
                  UP NEXT
                </div>
                {(() => {
                  const queued = (allTasks ?? []).filter((t: any) => t.status === 'queued')
                  if (queued.length === 0) return <div className="text-muted text-[11px]">No tasks in queue.</div>
                  return queued.map((t: any) => (
                    <div key={t.id} className="border-l-2 border-l-border px-3 py-1.5 mb-1.5 text-[11px]">
                      <span className="text-text">{t.agent_name}</span>
                      <span className="text-muted ml-1">—</span>
                      <span className="text-[9px] text-muted uppercase ml-1 mr-1">{t.type}</span>
                      <span className="text-muted">{t.description.split('\n')[0].slice(0, 80)}{t.description.length > 80 ? '...' : ''}</span>
                    </div>
                  ))
                })()}
              </div>
            </div>

            {/* Right sidebar */}
            <div className="border-l border-border flex flex-col min-h-0 overflow-auto">
              <DirectiveBox />
              <BudgetTracker budget={budget} />
              <div className="border-b border-border p-3">
                <div className="text-[10px] text-muted tracking-[0.1em] mb-2">MESSAGES</div>
                {(() => {
                  const msgs = messages ?? []
                  if (msgs.length === 0) return <div className="text-muted text-[10px]">No messages yet.</div>

                  // Deduplicate: collapse repeated "completed" notifications into counts
                  // Group by from+subject pattern, keep unique subjects
                  const seen = new Set<string>()
                  const deduped: any[] = []
                  const completionCounts: Record<string, number> = {}

                  for (const m of msgs) {
                    const subj = m.subject ?? ''
                    // Collapse "X completed: ..." notifications
                    if (subj.includes('completed:')) {
                      const from = m.from_agent_name ?? m.from_agent_id
                      completionCounts[from] = (completionCounts[from] ?? 0) + 1
                      continue
                    }
                    // Collapse duplicate subjects
                    const key = `${m.from_agent_id}-${subj.slice(0, 40)}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    deduped.push(m)
                  }

                  // Add collapsed completion summaries
                  const completionSummaries = Object.entries(completionCounts).map(([name, count]) => ({
                    _synthetic: true,
                    from_name: name,
                    subject: `${count} task completion${count > 1 ? 's' : ''} reported`,
                    priority: 'normal',
                  }))

                  const display = [...completionSummaries, ...deduped].slice(0, 30)

                  return (
                    <div className="space-y-1">
                      {display.map((m: any, i: number) => {
                        const isUrgent = m.priority === 'urgent' || m.priority === 'high'
                        return (
                          <div key={i} className={`px-2 py-1.5 text-[10px] rounded-sm ${
                            isUrgent ? 'bg-accent/8 border-l-2 border-l-accent' : 'border-l-2 border-l-transparent'
                          }`}>
                            <div className="flex items-center gap-1.5">
                              <span className="text-text/90 font-medium">{m.from_name ?? m.from_agent_name ?? m.from_agent_id}</span>
                              {!m._synthetic && (
                                <>
                                  <span className="text-muted text-[8px]">{'\u2192'}</span>
                                  <span className="text-muted text-[9px]">{m.to_agent_name ?? m.to_agent_id ?? m.to_team}</span>
                                </>
                              )}
                              {isUrgent && <span className="ml-auto text-[8px] text-accent">!</span>}
                            </div>
                            {m.subject && (
                              <div className="text-text/50 mt-0.5 truncate">{m.subject}</div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>
              <RewardPanel
                cfs={cfs ?? []}
                attribution={attribution ?? []}
                blockers={blockers ?? []}
              />
              <div className="border-t border-border h-[350px]">
                <CEOChat />
              </div>
            </div>
          </div>
        )}

        {/* TASKS — full task detail view */}
        {tab === 'tasks' && (
          <div className="h-full overflow-auto">
            <AgentTaskTracker />
            <div className="border-t border-border">
              <TaskList />
            </div>
          </div>
        )}

        {/* AGENTS — team grid with all agent details */}
        {tab === 'agents' && (
          <div className="h-full grid grid-cols-[1fr_380px] gap-0">
            <div className="overflow-auto">
              <TeamGrid
                agents={agents ?? []}
                cfs={cfs ?? []}
                velocity={velocity ?? []}
                activeProcesses={activeProcesses ?? []}
              />
            </div>
            <div className="border-l border-border overflow-auto">
              <DebateViewer debates={debates ?? []} />
            </div>
          </div>
        )}

        {/* EXPERIMENT — phase gates, marketing, opportunities */}
        {tab === 'experiment' && (
          <div className="h-full grid grid-cols-[1fr_1fr] gap-0 overflow-hidden">
            <div className="border-r border-border flex flex-col min-h-0 overflow-auto">
              <PhaseGate phases={phases ?? []} activePhase={phaseNumber} />
              <OpportunityBoard />
              <UsageBudgetPanel />
              <MarketingQueue />
            </div>
            <div className="flex flex-col min-h-0 overflow-auto">
              <TokenCostPanel />
            </div>
          </div>
        )}

        {/* REPORTS */}
        {tab === 'reports' && (
          <div className="h-full overflow-auto">
            <ReportViewer />
          </div>
        )}
      </div>
    </div>
  )
}
