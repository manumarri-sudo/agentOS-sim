import { useState, useEffect, useRef } from 'react'
import { fmtDollars, costColor } from '../lib/utils'

interface BudgetTrackerProps {
  budget: any
}

export function BudgetTracker({ budget }: BudgetTrackerProps) {
  const [revenueFlash, setRevenueFlash] = useState(false)
  const prevRevenue = useRef<number>(0)

  // Animate on revenue event
  useEffect(() => {
    if (!budget) return
    const rev = budget.totalRevenue ?? 0
    if (rev > prevRevenue.current && prevRevenue.current > 0) {
      setRevenueFlash(true)
      const t = setTimeout(() => setRevenueFlash(false), 2000)
      return () => clearTimeout(t)
    }
    prevRevenue.current = rev
  }, [budget?.totalRevenue])

  if (!budget) {
    return (
      <div className="panel m-0 border-0 border-b border-border p-3">
        <div className="text-[10px] text-muted tracking-[0.1em] mb-2">BUDGET</div>
        <div className="text-muted text-[11px]">Loading...</div>
      </div>
    )
  }

  const spentPct = budget.totalBudget > 0
    ? (budget.totalSpent / budget.totalBudget) * 100
    : 0

  return (
    <div className="border-b border-border p-3">
      <div className="text-[10px] text-muted tracking-[0.1em] mb-3">BUDGET TRACKER</div>

      {/* Total budget bar */}
      <div className="flex justify-between text-[11px] mb-1">
        <span className="text-text">Total</span>
        <span style={{ color: costColor(spentPct) }}>
          {fmtDollars(budget.totalSpent)} / {fmtDollars(budget.totalBudget)}
        </span>
      </div>
      <div className="h-1 bg-border mb-3">
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${spentPct}%`, background: costColor(spentPct) }}
        />
      </div>

      {/* Remaining */}
      <div className="flex justify-between text-[10px] mb-3">
        <span className="text-muted">Remaining</span>
        <span className="text-success">{fmtDollars(budget.remaining)}</span>
      </div>

      {/* Revenue — with flash animation on new revenue */}
      <div
        className={`flex justify-between text-[10px] mb-3 px-1 py-0.5 -mx-1 transition-all duration-500
          ${revenueFlash ? 'glow-success bg-success/10' : ''}`}
      >
        <span className="text-muted">Revenue</span>
        <span
          className={`font-semibold transition-all duration-500 ${
            revenueFlash ? 'text-[13px]' : 'text-[10px]'
          }`}
          style={{ color: '#98c379' }}
        >
          {fmtDollars(budget.totalRevenue ?? 0)}
        </span>
      </div>

      {/* Net position */}
      {(budget.totalRevenue ?? 0) > 0 && (
        <div className="flex justify-between text-[10px] mb-3">
          <span className="text-muted">Net (Revenue - Spent)</span>
          <span style={{ color: (budget.totalRevenue - budget.totalSpent) >= 0 ? '#98c379' : '#e06c75' }}>
            {fmtDollars(budget.totalRevenue - budget.totalSpent)}
          </span>
        </div>
      )}

      {/* Phase breakdown */}
      {budget.phaseBreakdown && budget.phaseBreakdown.length > 0 && (
        <>
          <div className="text-[9px] text-muted tracking-[0.05em] mb-2 mt-2">PER PHASE</div>
          {budget.phaseBreakdown.map((p: any) => {
            const phasePct = p.ceiling > 0 ? (p.spent / p.ceiling) * 100 : 0
            return (
              <div key={p.phase} className="mb-2">
                <div className="flex justify-between text-[10px]">
                  <span className="text-muted">Phase {p.phase}</span>
                  <span style={{ color: costColor(phasePct) }}>
                    {fmtDollars(p.spent)} / {fmtDollars(p.ceiling)}
                  </span>
                </div>
                <div className="h-0.5 bg-border mt-1">
                  <div
                    className="h-full transition-all duration-300"
                    style={{
                      width: `${Math.min(100, phasePct)}%`,
                      background: costColor(phasePct),
                    }}
                  />
                </div>
                {p.overCeiling && (
                  <div className="text-[9px] text-danger mt-0.5">Over ceiling</div>
                )}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
