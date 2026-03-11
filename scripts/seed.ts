import { getDb, closeDb } from '../server/db/database'
import { AGENTS, BUDGET_OWNERS, PHASE_QUORUM_CONFIG, EXPERIMENT_PHASES } from '../server/agents/registry'

function seed() {
  const db = getDb()
  console.log('Seeding AgentOS simulation...')

  // Agents (idempotent: INSERT OR IGNORE)
  let agentCount = 0
  const insertAgent = db.prepare(`
    INSERT OR IGNORE INTO agents
      (id, personality_name, team, role, personality_summary, urgency, urgency_reason,
       domain_knowledge_version, status, collaboration_score, capability_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0.0, 0)
  `)

  for (const agent of AGENTS) {
    const result = insertAgent.run(
      agent.id, agent.personality_name, agent.team, agent.role,
      agent.personality_summary, agent.urgency, agent.urgency_reason,
      agent.domain_knowledge_version,
    )
    if (result.changes > 0) agentCount++
  }
  console.log(`✓ ${agentCount} agents seeded (${AGENTS.length - agentCount} already existed)`)

  // Capability tiers (all start at tier 0)
  let tierCount = 0
  const insertTier = db.prepare(`
    INSERT OR IGNORE INTO capability_tiers
      (agent_id, tier, token_multiplier, queue_priority, updated_at)
    VALUES (?, 0, 1.0, 5, datetime('now'))
  `)
  for (const agent of AGENTS) {
    const result = insertTier.run(agent.id)
    if (result.changes > 0) tierCount++
  }
  console.log(`✓ ${tierCount} capability tiers seeded`)

  // Phases
  const insertPhase = db.prepare(`
    INSERT OR IGNORE INTO experiment_phases (phase_number, name, status)
    VALUES (?, ?, ?)
  `)
  for (const phase of EXPERIMENT_PHASES) {
    insertPhase.run(phase.phase_number, phase.name, phase.status)
  }
  console.log(`✓ ${EXPERIMENT_PHASES.length} experiment phases seeded`)

  // Phase quorum config
  const insertQuorum = db.prepare(`
    INSERT OR REPLACE INTO phase_quorum_config (phase, required_teams) VALUES (?, ?)
  `)
  for (const q of PHASE_QUORUM_CONFIG) {
    insertQuorum.run(q.phase, JSON.stringify(q.required_teams))
  }
  console.log(`✓ Phase quorum config seeded`)

  // Phase quorum tracking (seed rows for all phases × all teams)
  const teams = ['exec', 'strategy', 'tech', 'ops', 'marketing']
  const insertPhaseQuorum = db.prepare(`
    INSERT OR IGNORE INTO phase_quorum (phase, team, contributed)
    VALUES (?, ?, 0)
  `)
  for (const phase of EXPERIMENT_PHASES) {
    if (phase.phase_number === 0) continue // skip scaffold
    for (const team of teams) {
      insertPhaseQuorum.run(phase.phase_number, team)
    }
  }
  console.log(`✓ Phase quorum tracking seeded (${5 * 5} rows)`)

  // Budget category ownership
  const insertBudgetOwner = db.prepare(`
    INSERT OR REPLACE INTO budget_category_owners (category, owner_agent_id) VALUES (?, ?)
  `)
  for (const [category, ownerId] of Object.entries(BUDGET_OWNERS)) {
    insertBudgetOwner.run(category, ownerId)
  }
  console.log(`✓ Budget category ownership seeded`)

  // Sim clock
  const existingClock = db.query(`SELECT id FROM sim_clock WHERE id = 1`).get()
  if (!existingClock) {
    db.run(`INSERT INTO sim_clock (id, sim_day, last_advanced_at, advanced_by, real_start)
            VALUES (1, 0, datetime('now'), 'seed', datetime('now'))`)
    console.log('✓ Sim clock seeded')
  }

  // Initial budget entry
  const existingBudget = db.query(`SELECT id FROM budget_entries WHERE notes = 'experiment_start'`).get()
  if (!existingBudget) {
    db.run(`INSERT INTO budget_entries (id, amount, category, agent_id, notes, phase)
            VALUES (?, ?, 'reserve', 'reza', 'experiment_start', 0)`,
      [crypto.randomUUID(), Number(process.env.TOTAL_EXPERIMENT_BUDGET_USD ?? 200)])
    console.log('✓ Starting budget entry created ($200)')
  }

  console.log('\n✅ Seed complete. Run `bun run dev` to start.')
  closeDb()
}

seed()
