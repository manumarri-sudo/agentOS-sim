import { useState, useEffect } from 'react'
import { fmtDollars, costColor } from '../lib/utils'
import { apiFetch } from '../lib/api'

interface HeaderProps {
  connected: boolean
  simDay: number
  phase: any
  orchestratorRunning: boolean
  budget: any
}

export function Header({ connected, simDay, phase, orchestratorRunning, budget }: HeaderProps) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const remaining = budget?.remaining ?? 0
  const total = budget?.totalBudget ?? 200
  const pct = total > 0 ? ((total - remaining) / total) * 100 : 0

  const startOrchestrator = async () => {
    await apiFetch('/api/orchestrator/start', { method: 'POST' })
  }
  const stopOrchestrator = async () => {
    await apiFetch('/api/orchestrator/stop', { method: 'POST' })
  }

  return (
    <div className="bg-panel border-b border-border px-4 h-12 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-accent text-[13px] font-semibold tracking-[0.12em]">AGENTOS</span>
        <span className="text-muted text-[10px] tracking-[0.08em]">MISSION CONTROL</span>
      </div>

      <div className="flex items-center gap-4 text-[11px]">
        {/* Sim day */}
        <span className="text-muted">
          Day <span className="text-text">{simDay}</span>
        </span>

        {/* Phase */}
        {phase && (
          <span className="text-muted">
            Phase <span className="text-accent">{phase.phase_number}</span>
            <span className="text-muted ml-1">{phase.name}</span>
          </span>
        )}

        {/* Budget bar */}
        <div className="flex items-center gap-2">
          <span style={{ color: costColor(pct) }}>{fmtDollars(remaining)}</span>
          <div className="w-16 h-1 bg-border">
            <div
              className="h-full transition-all"
              style={{ width: `${100 - pct}%`, background: costColor(pct) }}
            />
          </div>
        </div>

        {/* Orchestrator control */}
        <button
          onClick={orchestratorRunning ? stopOrchestrator : startOrchestrator}
          className={`px-2 py-0.5 border text-[10px] tracking-wider transition-colors
            ${orchestratorRunning
              ? 'border-danger text-danger hover:bg-danger/10'
              : 'border-success text-success hover:bg-success/10'
            }`}
        >
          {orchestratorRunning ? 'STOP' : 'START'}
        </button>

        {/* Connection status */}
        <span className={`flex items-center gap-1 ${connected ? 'text-success' : 'text-danger'}`}>
          <span className="text-[8px]">{connected ? '\u25CF' : '\u25CB'}</span>
          {connected ? 'LIVE' : 'RECONNECTING'}
        </span>

        <span className="text-muted">{now.toLocaleTimeString()}</span>
      </div>
    </div>
  )
}
