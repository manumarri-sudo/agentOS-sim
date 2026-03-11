import { getDb, closeDb } from '../server/db/database'
import { writeFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Replay Script — generates narrative timeline of the experiment
//
// bun run replay > ~/Desktop/experiment-story.md
// ---------------------------------------------------------------------------

function formatTimestamp(ts: string): string {
  return new Date(ts + 'Z').toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function generateReplay(): string {
  const db = getDb()
  const lines: string[] = []

  lines.push('# AgentOS Experiment — Narrative Timeline')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')

  // Get all phases
  const phases = db.query(`
    SELECT * FROM experiment_phases ORDER BY phase_number
  `).all() as any[]

  // Get sim clock info
  const clock = db.query(`SELECT * FROM sim_clock WHERE id = 1`).get() as any

  lines.push(`## Overview`)
  lines.push('')
  lines.push(`- **Sim Days Elapsed:** ${clock?.sim_day ?? 0}`)
  lines.push(`- **Start:** ${clock?.real_start ? formatTimestamp(clock.real_start) : 'N/A'}`)
  lines.push(`- **Phases Completed:** ${phases.filter((p: any) => p.status === 'complete').length}/${phases.length}`)
  lines.push('')

  // Get all events chronologically
  const actions = db.query(`
    SELECT a.*, ag.personality_name, ag.team, ag.role
    FROM actions a
    JOIN agents ag ON a.agent_id = ag.id
    WHERE a.status IN ('completed', 'verification_failed', 'failed')
    ORDER BY a.completed_at ASC
  `).all() as any[]

  const messages = db.query(`
    SELECT m.*, fa.personality_name as from_name, ta.personality_name as to_name
    FROM messages m
    LEFT JOIN agents fa ON m.from_agent_id = fa.id
    LEFT JOIN agents ta ON m.to_agent_id = ta.id
    WHERE m.priority IN ('high', 'urgent')
    ORDER BY m.created_at ASC
  `).all() as any[]

  const decisions = db.query(`
    SELECT d.*, a.personality_name as agent_name
    FROM decisions d
    JOIN agents a ON d.made_by_agent = a.id
    ORDER BY d.created_at ASC
  `).all() as any[]

  const governanceEvents = db.query(`
    SELECT ge.*, a.personality_name as agent_name
    FROM governance_events ge
    LEFT JOIN agents a ON ge.agent_id = a.id
    ORDER BY ge.created_at ASC
  `).all() as any[]

  const revenueEvents = db.query(`
    SELECT be.*, ra.agent_id, ra.attribution_share,
           ag.personality_name as attr_agent_name
    FROM budget_entries be
    LEFT JOIN revenue_attribution ra ON be.id = ra.revenue_event_id
    LEFT JOIN agents ag ON ra.agent_id = ag.id
    WHERE be.amount > 0 AND be.notes != 'experiment_start'
    ORDER BY be.created_at ASC
  `).all() as any[]

  // Group by phase
  for (const phase of phases) {
    if (phase.phase_number === 0) continue

    lines.push(`---`)
    lines.push('')
    lines.push(`## Day ${phase.phase_number} (Sim Day ${phase.phase_number}) — Phase ${phase.phase_number}: ${phase.name}`)
    lines.push('')

    if (phase.started_at) {
      lines.push(`*Started: ${formatTimestamp(phase.started_at)}*`)
    }
    if (phase.completed_at) {
      lines.push(`*Completed: ${formatTimestamp(phase.completed_at)}*`)
    }
    if (phase.beat_deadline) {
      lines.push(`*Beat deadline by ${phase.early_by_minutes} minutes*`)
    }
    lines.push('')

    // Actions in this phase
    const phaseActions = actions.filter((a: any) => a.phase === phase.phase_number)
    if (phaseActions.length > 0) {
      lines.push(`### Actions (${phaseActions.length})`)
      lines.push('')
      for (const action of phaseActions) {
        const status = action.status === 'completed' ? '' :
                       action.status === 'verification_failed' ? ' [VERIFICATION FAILED]' : ' [FAILED]'
        const ts = action.completed_at ? formatTimestamp(action.completed_at) : ''
        lines.push(`- **${action.personality_name}** (${action.team}): ${action.description?.slice(0, 120)}${status}`)
        if (ts) lines.push(`  *${ts}*`)
      }
      lines.push('')
    }

    // Decisions in this phase
    const phaseDecisions = decisions.filter((d: any) => d.phase === phase.phase_number)
    if (phaseDecisions.length > 0) {
      lines.push(`### Decisions`)
      lines.push('')
      for (const d of phaseDecisions) {
        lines.push(`- **${d.agent_name}**: ${d.title} — *${d.status}*`)
        if (d.body) {
          const preview = d.body.slice(0, 200)
          lines.push(`  > ${preview}${d.body.length > 200 ? '...' : ''}`)
        }
      }
      lines.push('')
    }

    // Revenue in this phase
    const phaseRevenue = revenueEvents.filter((r: any) => r.phase === phase.phase_number)
    if (phaseRevenue.length > 0) {
      lines.push(`### **Revenue Events**`)
      lines.push('')
      for (const rev of phaseRevenue) {
        lines.push(`- **$${rev.amount}** — ${rev.notes}`)
        if (rev.attr_agent_name) {
          lines.push(`  Attribution: ${rev.attr_agent_name} (${Math.round((rev.attribution_share ?? 0) * 100)}%)`)
        }
      }
      lines.push('')
    }
  }

  // Governance section
  if (governanceEvents.length > 0) {
    lines.push(`---`)
    lines.push('')
    lines.push(`## Governance Events`)
    lines.push('')
    for (const ge of governanceEvents) {
      const icon = ge.severity === 'critical' ? '[CRITICAL]' :
                   ge.severity === 'warning' ? '[WARNING]' : '[INFO]'
      lines.push(`- ${icon} **${ge.event_type}**${ge.agent_name ? ` (${ge.agent_name})` : ''}: ${ge.details}`)
      lines.push(`  *${formatTimestamp(ge.created_at)} — Sim Day ${ge.sim_day}*`)
    }
    lines.push('')
  }

  // Spot check summary
  const spotChecks = db.query(`
    SELECT check_type, COUNT(*) as count,
           GROUP_CONCAT(DISTINCT agent_id) as agents
    FROM spot_check_failures
    GROUP BY check_type
  `).all() as any[]

  if (spotChecks.length > 0) {
    lines.push(`## Spot Check Failures`)
    lines.push('')
    for (const sc of spotChecks) {
      lines.push(`- **${sc.check_type}**: ${sc.count} failures (agents: ${sc.agents})`)
    }
    lines.push('')
  }

  // Attribution summary
  const attrSummary = db.query(`
    SELECT ra.agent_id, a.personality_name,
           SUM(ra.attribution_share * be.amount) as total_revenue,
           AVG(ra.attribution_share) as avg_share
    FROM revenue_attribution ra
    JOIN agents a ON ra.agent_id = a.id
    JOIN budget_entries be ON ra.revenue_event_id = be.id
    WHERE be.amount > 0
    GROUP BY ra.agent_id
    ORDER BY total_revenue DESC
  `).all() as any[]

  if (attrSummary.length > 0) {
    lines.push(`## Revenue Attribution Summary`)
    lines.push('')
    lines.push(`| Agent | Total Revenue | Avg Share |`)
    lines.push(`|-------|--------------|-----------|`)
    for (const a of attrSummary) {
      lines.push(`| ${a.personality_name} | $${a.total_revenue?.toFixed(2) ?? '0.00'} | ${Math.round((a.avg_share ?? 0) * 100)}% |`)
    }
    lines.push('')
  }

  lines.push(`---`)
  lines.push(`*Generated by AgentOS Replay Engine*`)

  closeDb()
  return lines.join('\n')
}

// Run
if (import.meta.main) {
  const output = generateReplay()

  // If stdout is a TTY, also write to file
  const outputPath = `${process.env.HOME}/Desktop/experiment-story.md`
  try {
    writeFileSync(outputPath, output)
    console.error(`Written to ${outputPath}`)
  } catch {
    // Fall through to stdout
  }

  console.log(output)
}
