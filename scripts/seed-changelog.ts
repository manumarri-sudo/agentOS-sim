#!/usr/bin/env bun
import Database from 'bun:sqlite'

const db = new Database('./sim.db')
const simDay = (db.query('SELECT sim_day FROM sim_clock WHERE id = 1').get() as any)?.sim_day ?? 2
const phase = 2

const entries: [string, string, string, string][] = [
  ['system_change', 'Fixed JSON parser for CLI output format', 'parseCliJsonResponse was looking for content blocks but Claude CLI returns result string. ROOT CAUSE of all 97 task failures.', 'All agent tasks now produce usable output'],
  ['system_change', 'Moved dedup from in-memory Set to SQLite', 'In-memory triggeredInteractions Set reset on every server restart. Now persisted in interaction_keys table.', 'Eliminates duplicate meta-work after server restarts'],
  ['system_change', 'Throttled meta-work generation', 'Priya notifications skipped for meta-work, reviews only for research/build, capped at 2 pending per agent, debates threshold raised.', 'Reduces token usage by ~60%'],
  ['system_change', 'Added Morgan (PM agent #19)', 'New Project Manager handles sprint management, task reviews, performance reports. Priya refocused on strategy. Reza on decisions.', 'Operational work no longer on exec agents'],
  ['system_change', 'Sprint system implemented', 'Sprints last ~45 min with performance snapshots, report generation, stale task cleanup at boundaries.', 'Structured cadence replaces ad-hoc flow'],
  ['system_change', 'Performance tracking + roster system', 'Per-agent scorecards (A-F) at sprint end. Warnings for D/F, promotions for A grades.', 'Agents have measurable accountability'],
  ['agent_decision', 'Reza: Product Format Decision', 'Notion template format for Chaser (Freelance Invoice Tracker). Price: $39. MVP ships in 72 hours.', 'Product direction decided, team unblocked'],
  ['system_change', 'Human task queue added', 'Agents use [HUMAN_TASK] to request human intervention. Categories: action, decision, access, review, unblock.', 'Agents can request help instead of failing silently'],
  ['system_change', 'Experiment changelog', 'System changes and decisions logged for weekly substack. /api/changelog/summary generates markdown.', 'Full audit trail for experiment updates'],
  ['system_change', 'Capability pre-check in agent prompts', 'Agents assess capability before starting. Must use signals instead of placeholder output.', 'Fewer wasted runs'],
  ['system_change', 'Blocker Notion sync', 'Blockers synced to NOTION_BLOCKERS_DB. Agents see open tickets in context.', 'Blockers visible everywhere'],
  ['error_resolved', 'Cleared 12 blocked agents', 'Unblocked 12 agents, cancelled 2 duplicate tasks, requeued 16 verification_failed, cleaned 536 messages.', 'System unblocked'],
  ['system_change', 'Fixed CLAUDECODE env inheritance', 'Dev server inherited CLAUDECODE=1. Child processes now delete this env var.', 'Agent processes no longer fail from nested session detection'],
]

for (const [eventType, title, details, impact] of entries) {
  const id = `clog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  db.run(
    `INSERT INTO experiment_changelog (id, sim_day, phase, event_type, title, details, impact) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, simDay, phase, eventType, title, details, impact]
  )
}

console.log(`Logged ${entries.length} changelog entries for Day ${simDay}`)
