import { useState } from 'react'
import { useAPI } from '../hooks/useAPI'

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  if (usd >= 0.001) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(5)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function pct(value: number, max: number): number {
  return max > 0 ? Math.min(100, (value / max) * 100) : 0
}

const TEAM_COLORS: Record<string, string> = {
  exec: '#c678dd',
  strategy: '#61afef',
  tech: '#98c379',
  ops: '#e5c07b',
  marketing: '#e06c75',
}

const MODEL_COLORS: Record<string, string> = {
  haiku: '#e5c07b',
  sonnet: '#98c379',
  opus: '#c678dd',
}

type SortKey = 'cost' | 'tokens' | 'tasks' | 'name'

export function TokenCostPanel() {
  const { data } = useAPI<any>('/api/usage/token-costs', 15000)
  const [sortBy, setSortBy] = useState<SortKey>('cost')
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null)

  if (!data || !data.totals) {
    return (
      <div className="p-4">
        <div className="text-[10px] text-muted tracking-[0.1em] mb-2">TOKEN COSTS</div>
        <div className="text-muted text-[11px]">No token data yet.</div>
      </div>
    )
  }

  const { totals, byAgent, byTeam, byPhase, pricing } = data
  const agents = [...(byAgent ?? [])]

  // Sort agents
  agents.sort((a: any, b: any) => {
    if (sortBy === 'cost') return b.total_cost - a.total_cost
    if (sortBy === 'tokens') return b.total_tokens - a.total_tokens
    if (sortBy === 'tasks') return b.task_count - a.task_count
    return a.personality_name.localeCompare(b.personality_name)
  })

  const maxAgentCost = Math.max(...agents.map((a: any) => a.total_cost ?? 0), 0.001)
  const maxAgentTokens = Math.max(...agents.map((a: any) => a.total_tokens ?? 0), 1)
  const maxTeamCost = Math.max(...(byTeam ?? []).map((t: any) => t.total_cost ?? 0), 0.001)

  const inputPct = totals.total_tokens > 0 ? (totals.total_input_tokens / totals.total_tokens * 100) : 0
  const outputPct = 100 - inputPct

  return (
    <div className="p-4 space-y-5">
      {/* Header */}
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-[10px] text-muted tracking-[0.1em]">TOKEN COSTS</div>
          <div className="text-[9px] text-muted mt-0.5">API-equivalent pricing -- all {totals.estimated_count > 0 ? `${totals.estimated_count} estimated` : `${totals.actual_count} actual`}</div>
        </div>
        <div className="text-[24px] text-accent font-medium leading-none">{formatCost(totals.total_cost ?? 0)}</div>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-4 gap-3">
        <div className="border border-border p-2">
          <div className="text-[14px] text-text font-medium">{formatTokens(totals.total_tokens ?? 0)}</div>
          <div className="text-[8px] text-muted tracking-wider">TOTAL TOKENS</div>
        </div>
        <div className="border border-border p-2">
          <div className="text-[14px] text-text font-medium">{totals.total_tasks ?? 0}</div>
          <div className="text-[8px] text-muted tracking-wider">TASKS</div>
        </div>
        <div className="border border-border p-2">
          <div className="text-[14px] text-text font-medium">{formatTokens(totals.total_input_tokens ?? 0)}</div>
          <div className="text-[8px] text-muted tracking-wider">INPUT</div>
        </div>
        <div className="border border-border p-2">
          <div className="text-[14px] text-text font-medium">{formatTokens(totals.total_output_tokens ?? 0)}</div>
          <div className="text-[8px] text-muted tracking-wider">OUTPUT</div>
        </div>
      </div>

      {/* Input/Output ratio bar */}
      <div>
        <div className="flex h-2 w-full overflow-hidden">
          <div className="h-full bg-blue-500/60 transition-all" style={{ width: `${inputPct}%` }} />
          <div className="h-full bg-orange-500/60 transition-all" style={{ width: `${outputPct}%` }} />
        </div>
        <div className="flex justify-between text-[9px] mt-1">
          <span className="text-blue-400">Input {formatCost(totals.total_cost_input ?? 0)} ({inputPct.toFixed(0)}%)</span>
          <span className="text-orange-400">Output {formatCost(totals.total_cost_output ?? 0)} ({outputPct.toFixed(0)}%)</span>
        </div>
      </div>

      {/* Team breakdown */}
      {byTeam && byTeam.length > 0 && (
        <div>
          <div className="text-[9px] text-muted tracking-[0.08em] mb-2">COST BY TEAM</div>
          <div className="space-y-1.5">
            {byTeam.map((t: any) => (
              <div key={t.team}>
                <div className="flex items-center justify-between mb-0.5">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[10px] font-medium uppercase w-20"
                      style={{ color: TEAM_COLORS[t.team] ?? '#c5c8c6' }}
                    >
                      {t.team}
                    </span>
                    <span className="text-[9px] text-muted">{t.task_count} tasks</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[9px] text-muted">{formatTokens(t.total_tokens ?? 0)}</span>
                    <span className="text-[11px] text-text font-medium w-16 text-right">{formatCost(t.total_cost ?? 0)}</span>
                  </div>
                </div>
                <div className="h-1.5 bg-border/50 w-full">
                  <div
                    className="h-full transition-all"
                    style={{
                      width: `${pct(t.total_cost, maxTeamCost)}%`,
                      background: TEAM_COLORS[t.team] ?? '#c5c8c6',
                      opacity: 0.7,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phase breakdown */}
      {byPhase && byPhase.length > 0 && (
        <div>
          <div className="text-[9px] text-muted tracking-[0.08em] mb-2">COST BY PHASE</div>
          <div className="flex gap-3">
            {byPhase.map((p: any) => (
              <div key={p.phase} className="border border-border p-2 flex-1">
                <div className="text-[10px] text-muted mb-1">Phase {p.phase}</div>
                <div className="text-[14px] text-text font-medium">{formatCost(p.total_cost ?? 0)}</div>
                <div className="text-[9px] text-muted mt-0.5">
                  {formatTokens(p.total_tokens ?? 0)} tokens / {p.task_count} tasks
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent table */}
      {agents.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[9px] text-muted tracking-[0.08em]">ALL AGENTS ({agents.length})</div>
            <div className="flex gap-1">
              {(['cost', 'tokens', 'tasks', 'name'] as SortKey[]).map((key) => (
                <button
                  key={key}
                  onClick={() => setSortBy(key)}
                  className={`text-[8px] px-1.5 py-0.5 border transition-colors ${
                    sortBy === key
                      ? 'border-accent text-accent'
                      : 'border-border text-muted hover:text-text'
                  }`}
                >
                  {key.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Table header */}
          <div className="grid grid-cols-[1fr_50px_60px_80px_60px_60px_70px] gap-1 text-[8px] text-muted tracking-wider mb-1 px-1">
            <span>AGENT</span>
            <span>MODEL</span>
            <span className="text-right">TASKS</span>
            <span className="text-right">TOKENS</span>
            <span className="text-right">INPUT $</span>
            <span className="text-right">OUTPUT $</span>
            <span className="text-right">TOTAL $</span>
          </div>

          {/* Agent rows */}
          <div className="space-y-0">
            {agents.map((a: any) => {
              const key = `${a.agent_id}-${a.model}`
              const isExpanded = expandedAgent === key
              return (
                <div key={key}>
                  <div
                    className="grid grid-cols-[1fr_50px_60px_80px_60px_60px_70px] gap-1 text-[10px] px-1 py-1 hover:bg-border/20 cursor-pointer transition-colors items-center"
                    onClick={() => setExpandedAgent(isExpanded ? null : key)}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ background: TEAM_COLORS[a.team] ?? '#c5c8c6' }}
                      />
                      <span className="text-text truncate">{a.personality_name}</span>
                      <span className="text-[8px] text-muted truncate hidden sm:inline">{a.role}</span>
                    </div>
                    <span
                      className="text-[8px] px-1 border text-center"
                      style={{
                        color: MODEL_COLORS[a.model] ?? '#c5c8c6',
                        borderColor: MODEL_COLORS[a.model] ?? '#373b41',
                      }}
                    >
                      {a.model}
                    </span>
                    <span className="text-text text-right">{a.task_count}</span>
                    <div className="text-right">
                      <span className="text-text">{formatTokens(a.total_tokens ?? 0)}</span>
                    </div>
                    <span className="text-blue-400 text-right">{formatCost(a.total_cost_input ?? 0)}</span>
                    <span className="text-orange-400 text-right">{formatCost(a.total_cost_output ?? 0)}</span>
                    <span className="text-text font-medium text-right">{formatCost(a.total_cost ?? 0)}</span>
                  </div>

                  {/* Cost bar under each row */}
                  <div className="px-1 pb-0.5">
                    <div className="h-0.5 bg-border/30">
                      <div
                        className="h-full transition-all"
                        style={{
                          width: `${pct(a.total_cost, maxAgentCost)}%`,
                          background: TEAM_COLORS[a.team] ?? '#c5c8c6',
                          opacity: 0.5,
                        }}
                      />
                    </div>
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="px-3 py-2 bg-border/10 border-l-2 ml-1 mb-1 text-[9px] space-y-1"
                      style={{ borderColor: TEAM_COLORS[a.team] ?? '#c5c8c6' }}
                    >
                      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                        <div>
                          <span className="text-muted">Team: </span>
                          <span className="text-text uppercase">{a.team}</span>
                        </div>
                        <div>
                          <span className="text-muted">Role: </span>
                          <span className="text-text">{a.role}</span>
                        </div>
                        <div>
                          <span className="text-muted">Input tokens: </span>
                          <span className="text-text">{(a.total_input_tokens ?? 0).toLocaleString()}</span>
                        </div>
                        <div>
                          <span className="text-muted">Output tokens: </span>
                          <span className="text-text">{(a.total_output_tokens ?? 0).toLocaleString()}</span>
                        </div>
                        <div>
                          <span className="text-muted">Avg tokens/task: </span>
                          <span className="text-text">
                            {a.task_count > 0 ? formatTokens(Math.round(a.total_tokens / a.task_count)) : '--'}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted">Avg cost/task: </span>
                          <span className="text-text">
                            {a.task_count > 0 ? formatCost(a.total_cost / a.task_count) : '--'}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted">Data source: </span>
                          <span className={a.actual_count > 0 ? 'text-success' : 'text-warning'}>
                            {a.actual_count > 0 ? `${a.actual_count} actual` : ''}{a.actual_count > 0 && a.estimated_count > 0 ? ', ' : ''}{a.estimated_count > 0 ? `${a.estimated_count} estimated` : ''}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted">% of total spend: </span>
                          <span className="text-text">
                            {totals.total_cost > 0 ? `${(a.total_cost / totals.total_cost * 100).toFixed(1)}%` : '--'}
                          </span>
                        </div>
                      </div>
                      {/* Token split bar */}
                      <div className="mt-1">
                        <div className="flex h-1.5 w-full overflow-hidden">
                          <div className="h-full bg-blue-500/50" style={{ width: `${pct(a.total_input_tokens, a.total_tokens)}%` }} />
                          <div className="h-full bg-orange-500/50" style={{ width: `${pct(a.total_output_tokens, a.total_tokens)}%` }} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Pricing reference */}
      {pricing && (
        <div className="border-t border-border pt-3">
          <div className="text-[8px] text-muted tracking-wider mb-1.5">MODEL PRICING (per MTok)</div>
          <div className="flex gap-4 text-[9px]">
            {Object.entries(pricing).map(([model, p]: [string, any]) => (
              <div key={model} className="flex items-center gap-1">
                <span style={{ color: MODEL_COLORS[model] ?? '#c5c8c6' }}>{model}</span>
                <span className="text-muted">in ${p.input} / out ${p.output}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Data quality note */}
      {totals.estimated_count > 0 && (
        <div className="text-[8px] text-muted border-t border-border pt-2">
          {totals.actual_count > 0 && <>{totals.actual_count} tasks with actual CLI token counts. </>}
          {totals.estimated_count} tasks estimated from text length (~4 chars/token).
          Future tasks will record actual counts via --output-format json.
        </div>
      )}
    </div>
  )
}
