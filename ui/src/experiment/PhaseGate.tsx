import { useState, useEffect } from 'react'
import { useAPI } from '../hooks/useAPI'
import { apiFetch } from '../lib/api'

interface PhaseGateProps {
  phases: any[]
  activePhase: number
}

const PHASE_STATUS_COLORS: Record<string, string> = {
  complete: '#98c379',
  active: '#61afef',
  pending: '#5c6370',
  killed: '#e06c75',
}

export function PhaseGate({ phases, activePhase }: PhaseGateProps) {
  const { data: quorum } = useAPI<any>(
    activePhase > 0 ? `/api/reward/quorum/${activePhase}` : '',
    5000
  )
  const { data: crossApprovals } = useAPI<any[]>('/api/reward/cross-approvals', 8000, [])

  const handleAdvance = async () => {
    if (!confirm(`Advance from Phase ${activePhase}? This requires human approval.`)) return
    const res = await apiFetch('/api/phase/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPhase: activePhase, approvedBy: 'human' }),
    })
    const data = await res.json() as { advanced: boolean; reason?: string }
    if (!data.advanced) {
      alert(`Cannot advance: ${data.reason}`)
    }
  }

  return (
    <div className="border-b border-border p-3">
      <div className="text-[10px] text-muted tracking-[0.1em] mb-3">PHASE GATE</div>

      {/* Phase timeline */}
      <div className="flex items-center gap-1 mb-4">
        {phases.map((p: any) => {
          const color = PHASE_STATUS_COLORS[p.status] ?? '#5c6370'
          const isActive = p.status === 'active'
          return (
            <div
              key={p.phase_number}
              className={`flex-1 text-center py-1.5 border text-[10px] transition-all
                ${isActive ? 'glow-accent' : ''}`}
              style={{ borderColor: color, color }}
            >
              <div className="font-medium">P{p.phase_number}</div>
              <div className="text-[8px] mt-0.5">{p.name}</div>
            </div>
          )
        })}
      </div>

      {/* Quorum display */}
      {quorum && activePhase > 0 && (
        <div className="border border-border p-2 mb-3">
          <div className="text-[9px] text-muted tracking-[0.05em] mb-2">
            PHASE {activePhase} QUORUM
          </div>

          {/* Required teams */}
          <div className="flex flex-wrap gap-1 mb-2">
            {quorum.requiredTeams?.map((team: string) => {
              const contributed = quorum.contributedTeams?.includes(team)
              return (
                <span
                  key={team}
                  className="px-1.5 py-0.5 border text-[9px]"
                  style={{
                    color: contributed ? '#98c379' : '#5c6370',
                    borderColor: contributed ? '#98c379' : '#5c6370',
                    background: contributed ? 'rgba(152,195,121,0.1)' : 'transparent',
                  }}
                >
                  {contributed ? '\u2713' : '\u25CB'} {team}
                </span>
              )
            })}
          </div>

          {/* Missing teams */}
          {quorum.missingTeams?.length > 0 && (
            <div className="text-[9px] text-warn mb-2">
              Missing: {quorum.missingTeams.join(', ')}
            </div>
          )}

          {/* Approval status */}
          <div className="flex gap-3 text-[9px] mb-2">
            <span className={quorum.ceoApproved ? 'text-success' : 'text-muted'}>
              {quorum.ceoApproved ? '\u2713' : '\u25CB'} CEO
            </span>
            <span className={quorum.humanApproved ? 'text-success' : 'text-muted'}>
              {quorum.humanApproved ? '\u2713' : '\u25CB'} Human
            </span>
          </div>

          {/* Gate status */}
          <div className="flex items-center gap-2">
            <span
              className={`text-[10px] px-2 py-0.5 border ${
                quorum.met
                  ? 'text-success border-success bg-success/10'
                  : 'text-muted border-border'
              }`}
            >
              {quorum.met ? 'QUORUM MET' : 'GATE LOCKED'}
            </span>

            <button
              onClick={handleAdvance}
              className="text-[10px] px-2 py-0.5 border border-accent text-accent hover:bg-accent/10 transition-colors"
            >
              ADVANCE PHASE
            </button>

            <span className="text-[8px] text-muted ml-1">
              Auto-advances when tasks complete
            </span>
          </div>
        </div>
      )}

      {/* Pending cross-approvals */}
      {crossApprovals && crossApprovals.length > 0 && (
        <div className="mt-3">
          <div className="text-[9px] text-muted tracking-[0.05em] mb-1">
            PENDING CROSS-APPROVALS ({crossApprovals.length})
          </div>
          {crossApprovals.map((ca: any) => (
            <div key={ca.entryId} className="border border-border p-2 mb-1 text-[10px]">
              <div className="flex items-center gap-2">
                <span className="text-warn">{'\u25CF'}</span>
                <span className="text-text">{ca.requestingAgentName}</span>
                <span className="text-muted">{ca.category}</span>
                <span className="text-warn ml-auto">${ca.amount?.toFixed(2)}</span>
              </div>
              {ca.description && (
                <div className="text-muted text-[9px] mt-1 truncate">{ca.description}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Phase details */}
      {phases.filter((p: any) => p.status === 'complete').length > 0 && (
        <div className="mt-3">
          <div className="text-[9px] text-muted tracking-[0.05em] mb-1">COMPLETED PHASES</div>
          {phases
            .filter((p: any) => p.status === 'complete')
            .map((p: any) => (
              <div key={p.phase_number} className="flex items-center gap-2 text-[10px] py-0.5">
                <span className="text-success">{'\u2713'}</span>
                <span className="text-text">Phase {p.phase_number}: {p.name}</span>
                {p.beat_deadline && (
                  <span className="text-success text-[8px] ml-auto">
                    Beat by {p.early_by_minutes}m
                  </span>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
