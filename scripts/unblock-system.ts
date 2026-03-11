#!/usr/bin/env bun
/**
 * unblock-system.ts -- One-time cleanup to clear jammed state
 *
 * 1. Unblock all 16 blocked agents
 * 2. Cancel duplicate queued tasks (keep newest per agent+type+phase)
 * 3. Requeue verification_failed tasks
 * 4. Archive old read messages
 * 5. Log everything to activity_log
 */

import Database from 'bun:sqlite'

const db = new Database('./sim.db')

console.log('=== SYSTEM UNBLOCK SCRIPT ===\n')

// 1. Clear all blocked agents
const blocked = db.query(`
  SELECT ba.id, ba.agent_id, ba.reason, ag.personality_name
  FROM blocked_agents ba
  JOIN agents ag ON ag.id = ba.agent_id
  WHERE ba.resolved_at IS NULL
`).all() as any[]

console.log(`[1] Blocked agents: ${blocked.length}`)
for (const b of blocked) {
  db.run(`UPDATE blocked_agents SET resolved_by = 'system', resolved_at = datetime('now') WHERE id = ?`, [b.id])
  db.run(`UPDATE agents SET status = 'idle' WHERE id = ? AND status = 'blocked'`, [b.agent_id])
  console.log(`  Unblocked: ${b.personality_name} -- ${b.reason.slice(0, 80)}`)
}

// 2. Cancel duplicate queued tasks -- keep newest per agent+type+phase
const dupeGroups = db.query(`
  SELECT agent_id, type, phase, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
  FROM actions
  WHERE status = 'queued'
  GROUP BY agent_id, type, phase
  HAVING cnt > 1
  ORDER BY cnt DESC
`).all() as any[]

let cancelledCount = 0
console.log(`\n[2] Duplicate task groups: ${dupeGroups.length}`)
for (const group of dupeGroups) {
  const ids = group.ids.split(',')
  // Keep the last one (newest), cancel the rest
  const toCancel = ids.slice(0, -1)
  for (const id of toCancel) {
    db.run(`UPDATE actions SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?`, [id])
    cancelledCount++
  }
  const agentName = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(group.agent_id) as any)?.personality_name
  console.log(`  ${agentName}: cancelled ${toCancel.length} duplicate ${group.type} tasks (phase ${group.phase})`)
}
console.log(`  Total cancelled: ${cancelledCount}`)

// 3. Requeue verification_failed tasks
const vfTasks = db.query(`
  SELECT id, agent_id, description FROM actions WHERE status = 'verification_failed'
`).all() as any[]

console.log(`\n[3] Verification-failed tasks: ${vfTasks.length}`)
for (const t of vfTasks) {
  db.run(`UPDATE actions SET status = 'queued', started_at = NULL, completed_at = NULL WHERE id = ?`, [t.id])
  const agentName = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(t.agent_id) as any)?.personality_name
  console.log(`  Requeued: ${agentName} -- ${t.description.slice(0, 60)}`)
}

// 4. Clean up old messages -- mark old sent as read, delete stale
const readOld = db.run(`
  UPDATE messages SET status = 'read'
  WHERE status = 'sent' AND created_at < datetime('now', '-4 hours')
`)
const deleted = db.run(`
  DELETE FROM messages
  WHERE status IN ('read', 'actioned', 'ignored') AND created_at < datetime('now', '-8 hours')
`)
console.log(`\n[4] Marked ${readOld.changes} old sent msgs as read, deleted ${deleted.changes} stale messages`)

// 5. Log cleanup to activity_log
const simDay = (db.query(`SELECT sim_day FROM sim_clock WHERE id = 1`).get() as any)?.sim_day ?? 1
const phase = (db.query(`SELECT phase_number FROM experiment_phases WHERE status = 'active' LIMIT 1`).get() as any)?.phase_number ?? 2

db.run(`
  INSERT INTO activity_log (sim_day, phase, agent_id, event_type, summary)
  VALUES (?, ?, 'system', 'system_cleanup', ?)
`, [simDay, phase, `System unblock: ${blocked.length} agents unblocked, ${cancelledCount} duplicate tasks cancelled, ${vfTasks.length} tasks requeued`])

// Summary
const finalStats = {
  agents: db.query(`SELECT status, COUNT(*) as n FROM agents GROUP BY status`).all(),
  tasks: db.query(`SELECT status, COUNT(*) as n FROM actions GROUP BY status`).all(),
  messages: db.query(`SELECT status, COUNT(*) as n FROM messages GROUP BY status`).all(),
}

console.log('\n=== POST-CLEANUP STATE ===')
console.log('Agents:', JSON.stringify(finalStats.agents))
console.log('Tasks:', JSON.stringify(finalStats.tasks))
console.log('Messages:', JSON.stringify(finalStats.messages))
console.log('\nDone.')
