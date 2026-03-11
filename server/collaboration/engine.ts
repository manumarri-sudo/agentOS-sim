import { getDb } from '../db/database'
import { enqueueTask } from '../tasks/queue'
import { sendMessage } from '../messages/bus'
import { logActivity } from '../activity'
import { getSimDay } from '../clock'

// ---------------------------------------------------------------------------
// Collaboration Engine — creates organic interactions between agents
//
// This generates:
// 1. Cross-team reviews (Dani challenges tech specs, Kai pushes back on scope)
// 2. Debates when agents have conflicting outputs
// 3. Ad-hoc 1:1 syncs between agents who depend on each other
// 4. Escalation chains when disagreements can't be resolved
// 5. "Check-in" pings where agents react to each other's work
// ---------------------------------------------------------------------------

// Natural tension pairs — agents whose roles create healthy friction
const TENSION_PAIRS: Array<{
  agents: [string, string]
  trigger: string       // what kind of work triggers the interaction
  dynamic: string       // description of the tension
}> = [
  {
    agents: ['dani', 'amir'],
    trigger: 'build|write',
    dynamic: 'Dani (CPO) challenges whether the spec actually solves the user problem. Amir defends scope cuts.',
  },
  {
    agents: ['reza', 'priya'],
    trigger: 'decide|review',
    dynamic: 'Reza wants to move fast. Priya pushes back if the foundation isn\'t there.',
  },
  {
    agents: ['kai', 'amir'],
    trigger: 'build',
    dynamic: 'Kai hates scope creep and late requirements. Amir mediates between product vision and engineering reality.',
  },
  {
    agents: ['marcus', 'nina'],
    trigger: 'research|write',
    dynamic: 'Marcus wants hard numbers and willingness-to-pay evidence. Nina brings qualitative customer voice.',
  },
  {
    agents: ['sol', 'vera'],
    trigger: 'write|research',
    dynamic: 'Sol thinks strategically about channels. Vera wants to ship and test immediately.',
  },
  {
    agents: ['dani', 'nina'],
    trigger: 'research|write',
    dynamic: 'Dani owns product vision. Nina owns customer voice. They sometimes disagree about what customers actually want vs what would be best for them.',
  },
  {
    agents: ['jordan', 'kai'],
    trigger: 'build',
    dynamic: 'Jordan worries about ops readiness and compliance. Kai wants to ship now and fix later.',
  },
  {
    agents: ['reza', 'dani'],
    trigger: 'decide|write',
    dynamic: 'Reza wants to launch before it\'s "ready." Dani pushes back if the product isn\'t good enough.',
  },
  {
    agents: ['alex', 'sol'],
    trigger: 'spend',
    dynamic: 'Alex controls budget tightly. Sol wants marketing spend to test channels.',
  },
]

// Track what we've already triggered to avoid spam
const triggeredInteractions = new Set<string>()

// ---------------------------------------------------------------------------
// Check for cross-review opportunities
// When agent A completes work, see if agent B has a natural stake in it
// ---------------------------------------------------------------------------
export function checkCrossReviews(
  completedAgent: { id: string; personality_name: string; team: string },
  task: { id: string; type: string; description: string; phase: number },
  output: string
): void {
  const db = getDb()

  for (const pair of TENSION_PAIRS) {
    const [a, b] = pair.agents

    // Does this completion involve one of the pair?
    let reviewer: string | null = null
    if (completedAgent.id === a) reviewer = b
    else if (completedAgent.id === b) reviewer = a
    else continue

    // Does the task type match the trigger?
    const triggerTypes = pair.trigger.split('|')
    if (!triggerTypes.includes(task.type)) continue

    // Dedupe — only one cross-review per pair per phase
    const key = `cross-${pair.agents.sort().join('-')}-p${task.phase}-${task.type}`
    if (triggeredInteractions.has(key)) continue

    // Check reviewer is idle and not already busy with reviews
    const reviewerInfo = db.query(
      `SELECT id, personality_name, status FROM agents WHERE id = ?`
    ).get(reviewer) as { id: string; personality_name: string; status: string } | null
    if (!reviewerInfo) continue

    // Don't pile on reviews — max 1 pending cross-review per agent
    const pendingReviews = db.query(`
      SELECT COUNT(*) as n FROM actions
      WHERE agent_id = ? AND type = 'review' AND status IN ('queued', 'running')
    `).get(reviewer) as { n: number }
    if (pendingReviews.n >= 1) continue

    const outputPreview = output.slice(0, 2500)

    enqueueTask({
      agentId: reviewer,
      type: 'review',
      description: `CROSS-TEAM REVIEW: ${completedAgent.personality_name}'s ${task.type} work\n\n` +
        `${pair.dynamic}\n\n` +
        `${completedAgent.personality_name} just completed: ${task.description.slice(0, 200)}\n\n` +
        `Their output:\n${outputPreview}\n\n` +
        `As ${reviewerInfo.personality_name}, give your honest reaction:\n` +
        `1. What do you agree with? What's strong?\n` +
        `2. What do you disagree with or think is wrong? Be specific and direct.\n` +
        `3. What's missing that you'd expect to see?\n` +
        `4. If you could change one thing about this, what would it be?\n` +
        `5. Do you want to propose a different approach? If so, what and why?\n\n` +
        `Be yourself. If you think this is great, say so. If you think it's wrong, say that too. ` +
        `Use [MSG to:${completedAgent.id} priority:high] to message them directly if you have a strong objection.`,
      phase: task.phase,
    })

    logActivity({
      agentId: reviewer,
      otherAgentId: completedAgent.id,
      phase: task.phase,
      eventType: 'cross_review_assigned',
      summary: `${reviewerInfo.personality_name} assigned to cross-review ${completedAgent.personality_name}'s ${task.type} work`,
    })

    triggeredInteractions.add(key)
    console.log(`[COLLAB] Cross-review: ${reviewerInfo.personality_name} will review ${completedAgent.personality_name}'s ${task.type}`)

    // Only trigger one cross-review per completion (don't spam)
    break
  }
}

// ---------------------------------------------------------------------------
// Generate debate tasks when two agents have produced conflicting work
// ---------------------------------------------------------------------------
export function checkForDebates(phase: number): void {
  const db = getDb()

  // Look for agents on the same topic with potentially different conclusions
  const completedWork = db.query(`
    SELECT a.id, a.agent_id, ag.personality_name, a.type, a.description,
           substr(a.output, 1, 1500) as preview
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.phase = ? AND a.status = 'completed' AND a.type IN ('research', 'write', 'decide')
    ORDER BY a.completed_at DESC
  `).all(phase) as any[]

  if (completedWork.length < 4) return // need enough work to find conflicts

  // Check for keyword overlap that might indicate competing perspectives
  const debateOpportunities = findDebateOpportunities(completedWork)

  for (const debate of debateOpportunities) {
    const key = `debate-${debate.agent1}-${debate.agent2}-p${phase}`
    if (triggeredInteractions.has(key)) continue

    // Create a facilitated debate task for Priya (CoS)
    enqueueTask({
      agentId: 'priya',
      type: 'meeting',
      description: `FACILITATED DISCUSSION: ${debate.agent1Name} vs ${debate.agent2Name}\n\n` +
        `These two agents have produced work that may contain conflicting views on: ${debate.topic}\n\n` +
        `${debate.agent1Name}'s position:\n${debate.preview1}\n\n` +
        `${debate.agent2Name}'s position:\n${debate.preview2}\n\n` +
        `As Chief of Staff, facilitate this disagreement:\n` +
        `1. STATE THE CONFLICT clearly — what exactly do they disagree about?\n` +
        `2. STEELMAN both sides — what's the strongest version of each argument?\n` +
        `3. YOUR ASSESSMENT — who do you think is more right and why?\n` +
        `4. RECOMMENDATION — what should we do? Side with one? Compromise? Test both?\n` +
        `5. MESSAGES — use [MSG to:${debate.agent1Id} priority:high] and [MSG to:${debate.agent2Id} priority:high] to tell each agent your ruling and what they should do next.\n\n` +
        `Don't be diplomatic. Be clear about who has the stronger argument.`,
      phase,
    })

    triggeredInteractions.add(key)
    console.log(`[COLLAB] Debate scheduled: ${debate.agent1Name} vs ${debate.agent2Name} on "${debate.topic}"`)
  }
}

interface DebateOpportunity {
  agent1Id: string
  agent2Id: string
  agent1Name: string
  agent2Name: string
  topic: string
  preview1: string
  preview2: string
}

function findDebateOpportunities(work: any[]): DebateOpportunity[] {
  const opportunities: DebateOpportunity[] = []

  // Simple heuristic: look for work pairs from different agents that share keywords
  for (let i = 0; i < work.length; i++) {
    for (let j = i + 1; j < work.length; j++) {
      if (work[i].agent_id === work[j].agent_id) continue

      const words1 = new Set(work[i].description.toLowerCase().split(/\s+/))
      const words2 = new Set(work[j].description.toLowerCase().split(/\s+/))

      // Find shared meaningful words (>4 chars to filter noise)
      const shared = [...words1].filter(w => w.length > 4 && words2.has(w))
      const overlap = shared.length / Math.min(words1.size, words2.size)

      if (overlap > 0.15 && shared.length >= 3) {
        // Check the tension pairs to see if these agents have natural friction
        const hasTension = TENSION_PAIRS.some(p =>
          (p.agents[0] === work[i].agent_id && p.agents[1] === work[j].agent_id) ||
          (p.agents[1] === work[i].agent_id && p.agents[0] === work[j].agent_id)
        )

        if (hasTension) {
          opportunities.push({
            agent1Id: work[i].agent_id,
            agent2Id: work[j].agent_id,
            agent1Name: work[i].personality_name,
            agent2Name: work[j].personality_name,
            topic: shared.slice(0, 5).join(', '),
            preview1: work[i].preview,
            preview2: work[j].preview,
          })
        }
      }
    }
  }

  // Return max 1 debate per check cycle
  return opportunities.slice(0, 1)
}

// ---------------------------------------------------------------------------
// 1:1 syncs — when one agent's work directly feeds another's
// ---------------------------------------------------------------------------
export function checkOneOnOneSyncs(phase: number): void {
  const db = getDb()

  // Dependency chains: when A finishes, B needs to react
  const DEPENDENCY_CHAINS: Array<{ producer: string; consumer: string; triggerType: string; syncPrompt: string }> = [
    {
      producer: 'marcus',
      consumer: 'dani',
      triggerType: 'write',
      syncPrompt: 'Marcus produced a PRD. As CPO, does this actually capture the user need? Push back on anything that feels like it was built for the builder, not the user.',
    },
    {
      producer: 'amir',
      consumer: 'kai',
      triggerType: 'write',
      syncPrompt: 'Amir wrote a tech spec. As the engineer who has to build this, what\'s realistic and what\'s fantasy? What would you simplify? What\'s missing from the implementation side?',
    },
    {
      producer: 'nina',
      consumer: 'cass',
      triggerType: 'research',
      syncPrompt: 'Nina completed customer research. As the content writer, what language and pain points jump out as copy gold? What headlines would you write from this research?',
    },
    {
      producer: 'zara',
      consumer: 'sol',
      triggerType: 'research',
      syncPrompt: 'Zara completed market research. As marketing lead, what distribution channels and positioning angles do you see? Where are the gaps in the competitive landscape you can exploit?',
    },
    {
      producer: 'sol',
      consumer: 'vera',
      triggerType: 'write',
      syncPrompt: 'Sol produced a GTM plan. As the growth hacker who executes, what can you actually ship this week? What\'s realistic and what needs to be cut?',
    },
    {
      producer: 'kai',
      consumer: 'theo',
      triggerType: 'build',
      syncPrompt: 'Kai built something. As QA, what are your first concerns? What edge cases do you see? What would you test first?',
    },
    {
      producer: 'kai',
      consumer: 'lee',
      triggerType: 'build',
      syncPrompt: 'Kai built the core. As the frontend engineer, what UI/UX work needs to happen? What\'s the user-facing experience going to look like? Push back if the backend doesn\'t support what users need.',
    },
  ]

  for (const chain of DEPENDENCY_CHAINS) {
    const key = `sync-${chain.producer}-${chain.consumer}-p${phase}`
    if (triggeredInteractions.has(key)) continue

    // Check if producer has completed the trigger type this phase
    const producerWork = db.query(`
      SELECT a.id, ag.personality_name, a.description, substr(a.output, 1, 2000) as preview
      FROM actions a
      JOIN agents ag ON ag.id = a.agent_id
      WHERE a.agent_id = ? AND a.phase = ? AND a.status = 'completed' AND a.type = ?
      ORDER BY a.completed_at DESC LIMIT 1
    `).get(chain.producer, phase, chain.triggerType) as any

    if (!producerWork) continue

    // Don't pile on — check consumer doesn't have too many queued tasks
    const consumerLoad = db.query(`
      SELECT COUNT(*) as n FROM actions
      WHERE agent_id = ? AND status IN ('queued', 'running')
    `).get(chain.consumer) as { n: number }
    if (consumerLoad.n >= 2) continue

    const consumerInfo = db.query(
      `SELECT personality_name FROM agents WHERE id = ?`
    ).get(chain.consumer) as { personality_name: string }

    enqueueTask({
      agentId: chain.consumer,
      type: 'review',
      description: `1:1 SYNC with ${producerWork.personality_name}\n\n` +
        `${chain.syncPrompt}\n\n` +
        `${producerWork.personality_name}'s work: ${producerWork.description.slice(0, 200)}\n\n` +
        `Their output:\n${producerWork.preview}\n\n` +
        `Respond as ${consumerInfo.personality_name}. Be direct. If you love it, say why. If you'd do it differently, say how. ` +
        `Use [MSG to:${chain.producer} priority:high] to send them your feedback directly. ` +
        `Use [NEXT_TASK for:${chain.consumer} type:build] if this gives you a clear next action.`,
      phase,
    })

    logActivity({
      agentId: chain.consumer,
      otherAgentId: chain.producer,
      phase,
      eventType: '1on1_sync',
      summary: `${consumerInfo.personality_name} reacting to ${producerWork.personality_name}'s ${chain.triggerType} work`,
    })

    triggeredInteractions.add(key)
    console.log(`[COLLAB] 1:1 sync: ${consumerInfo.personality_name} reacting to ${producerWork.personality_name}'s ${chain.triggerType}`)
  }
}

// ---------------------------------------------------------------------------
// Public entry point — called from orchestrator
// ---------------------------------------------------------------------------
export function runCollaborationChecks(phase: number): void {
  checkForDebates(phase)
  checkOneOnOneSyncs(phase)
}
