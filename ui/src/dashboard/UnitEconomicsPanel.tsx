import { useState, useEffect, useRef } from 'react'
import { useAPI } from '../hooks/useAPI'
import { fmtDollars, costColor } from '../lib/utils'

// ---------------------------------------------------------------------------
// UnitEconomicsPanel -- War Room Financial Dashboard
//
// Replaces the static BudgetTracker with live unit economics:
// - Burn Rate ($/day of API-equivalent token cost)
// - Runway (days until budget exhaustion at current burn rate)
// - CAC (Customer Acquisition Cost from marketing spend / purchases)
// - Conversion Funnel (views -> clicks -> checkouts -> purchases)
// - Revenue with flash animation
// - Per-phase budget breakdown preserved
// ---------------------------------------------------------------------------

interface FunnelEntry {
  event_type: string
  source_channel: string
  count: number
  total_revenue: number
}

interface ChannelMetric {
  channel: string
  total_spend: number
  total_clicks: number
  total_conversions: number
  total_revenue: number
}

export function UnitEconomicsPanel() {
  const { data: budget } = useAPI<any>('/api/budget', 15000)
  const { data: tokenCosts } = useAPI<any>('/api/usage/token-costs', 15000)
  const { data: clock } = useAPI<any>('/api/clock', 15000)
  const { data: funnel } = useAPI<FunnelEntry[]>('/api/funnel/summary', 15000, [])
  const { data: channels } = useAPI<ChannelMetric[]>('/api/marketing/channels', 15000, [])

  const [revenueFlash, setRevenueFlash] = useState(false)
  const prevRevenue = useRef<number>(0)

  // Flash on revenue change
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
      <div className="border-b border-border p-3">
        <div className="text-[10px] text-muted tracking-[0.1em] mb-2">UNIT ECONOMICS</div>
        <div className="text-muted text-[11px]">Loading...</div>
      </div>
    )
  }

  // Compute unit economics
  const simDay = clock?.sim_day ?? 0
  const totalTokenCost = tokenCosts?.totals?.total_cost ?? 0
  const burnRate = simDay > 0 ? totalTokenCost / simDay : 0
  const remaining = budget.remaining ?? (budget.totalBudget - budget.totalSpent)
  const runway = burnRate > 0 ? remaining / burnRate : Infinity

  // Marketing metrics
  const totalMarketingSpend = (channels ?? []).reduce((s: number, c: ChannelMetric) => s + c.total_spend, 0)
  const funnelEntries = funnel ?? []
  const funnelCounts: Record<string, number> = {}
  for (const entry of funnelEntries) {
    funnelCounts[entry.event_type] = (funnelCounts[entry.event_type] ?? 0) + entry.count
  }

  const views = funnelCounts['view'] ?? 0
  const clicks = funnelCounts['click'] ?? 0
  const checkouts = funnelCounts['checkout'] ?? 0
  const purchases = funnelCounts['purchase'] ?? 0
  const totalRevenue = budget.totalRevenue ?? 0
  const cac = purchases > 0 ? totalMarketingSpend / purchases : null

  // Burn rate color coding
  const burnColor = burnRate < 5 ? '#98c379' : burnRate < 15 ? '#e5c07b' : '#e06c75'

  // Runway color coding
  const runwayColor = runway === Infinity ? '#5c6370' :
    runway > 30 ? '#98c379' : runway > 10 ? '#e5c07b' : '#e06c75'

  const spentPct = budget.totalBudget > 0
    ? (budget.totalSpent / budget.totalBudget) * 100
    : 0

  return (
    <div className="border-b border-border p-3">
      <div className="text-[10px] text-muted tracking-[0.1em] mb-3">UNIT ECONOMICS</div>

      {/* Burn Rate */}
      <div className="flex justify-between text-[10px] mb-2">
        <span className="text-muted">Burn Rate</span>
        <span style={{ color: burnColor }} className="font-semibold">
          {fmtDollars(burnRate)}/day
        </span>
      </div>

      {/* Runway */}
      <div className="flex justify-between text-[10px] mb-2">
        <span className="text-muted">Runway</span>
        <span style={{ color: runwayColor }} className="font-semibold">
          {runway === Infinity ? '--' : `${Math.floor(runway)} days`}
        </span>
      </div>

      {/* CAC */}
      <div className="flex justify-between text-[10px] mb-2">
        <span className="text-muted">CAC</span>
        <span style={{ color: cac === null ? '#5c6370' : cac > 50 ? '#e06c75' : '#98c379' }} className="font-semibold">
          {cac === null ? 'N/A -- no conversions yet' : fmtDollars(cac)}
        </span>
      </div>

      {/* Revenue -- with flash animation */}
      <div
        className={`flex justify-between text-[10px] mb-2 px-1 py-0.5 -mx-1 transition-all duration-500
          ${revenueFlash ? 'glow-success bg-success/10' : ''}`}
      >
        <span className="text-muted">Revenue</span>
        <span
          className={`font-semibold transition-all duration-500 ${
            revenueFlash ? 'text-[13px]' : 'text-[10px]'
          }`}
          style={{ color: '#98c379' }}
        >
          {fmtDollars(totalRevenue)}
        </span>
      </div>

      {/* Net position */}
      {totalRevenue > 0 && (
        <div className="flex justify-between text-[10px] mb-2">
          <span className="text-muted">Net (Rev - Cost)</span>
          <span style={{ color: (totalRevenue - totalTokenCost) >= 0 ? '#98c379' : '#e06c75' }}>
            {fmtDollars(totalRevenue - totalTokenCost)}
          </span>
        </div>
      )}

      {/* Conversion Funnel */}
      {(views > 0 || clicks > 0 || checkouts > 0 || purchases > 0) && (
        <div className="mt-3 mb-2">
          <div className="text-[9px] text-muted tracking-[0.05em] mb-2">CONVERSION FUNNEL</div>
          {[
            { label: 'Views', count: views, color: '#61afef' },
            { label: 'Clicks', count: clicks, color: '#c678dd' },
            { label: 'Checkouts', count: checkouts, color: '#e5c07b' },
            { label: 'Purchases', count: purchases, color: '#98c379' },
          ].map((step, i, arr) => {
            const maxCount = Math.max(views, 1)
            const pct = (step.count / maxCount) * 100
            const prev = i > 0 ? arr[i - 1].count : 0
            const dropoff = prev > 0 ? Math.round((1 - step.count / prev) * 100) : null
            return (
              <div key={step.label} className="mb-1">
                <div className="flex justify-between text-[10px]">
                  <span className="text-muted">{step.label}</span>
                  <span style={{ color: step.color }}>
                    {step.count}
                    {dropoff !== null && dropoff > 0 && (
                      <span className="text-[8px] text-muted ml-1">(-{dropoff}%)</span>
                    )}
                  </span>
                </div>
                <div className="h-0.5 bg-border mt-0.5">
                  <div
                    className="h-full transition-all duration-300"
                    style={{ width: `${pct}%`, background: step.color }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Budget progress bar */}
      <div className="mt-3">
        <div className="text-[9px] text-muted tracking-[0.05em] mb-2">BUDGET</div>
        <div className="flex justify-between text-[10px] mb-1">
          <span className="text-muted">Spent (Budget Ledger)</span>
          <span style={{ color: costColor(spentPct) }}>
            {fmtDollars(budget.totalSpent)} / {fmtDollars(budget.totalBudget)}
          </span>
        </div>
        <div className="h-1 bg-border mb-1">
          <div
            className="h-full transition-all duration-500"
            style={{ width: `${spentPct}%`, background: costColor(spentPct) }}
          />
        </div>
        <div className="flex justify-between text-[10px] mb-1">
          <span className="text-muted">Token Cost (API-equiv)</span>
          <span style={{ color: '#e5c07b' }}>{fmtDollars(totalTokenCost)}</span>
        </div>
        <div className="flex justify-between text-[10px]">
          <span className="text-muted">Remaining</span>
          <span className="text-success">{fmtDollars(remaining)}</span>
        </div>
      </div>

      {/* Phase breakdown */}
      {budget.phaseBreakdown && budget.phaseBreakdown.length > 0 && (
        <div className="mt-3">
          <div className="text-[9px] text-muted tracking-[0.05em] mb-2">PER PHASE</div>
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
        </div>
      )}
    </div>
  )
}
