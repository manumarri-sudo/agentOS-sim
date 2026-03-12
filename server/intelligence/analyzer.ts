// ---------------------------------------------------------------------------
// Intelligence Layer — learns from DB data, gets smarter over time
//
// This module analyzes completed work, agent performance, and phase progress
// to generate better tasks, provide smarter context, and detect problems.
// ---------------------------------------------------------------------------

import { getDb } from '../db/database'
import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// Agent Performance Profile — built from historical data
// ---------------------------------------------------------------------------
export interface AgentProfile {
  agentId: string
  name: string
  team: string
  totalCompleted: number
  totalFailed: number
  avgOutputLength: number
  strongTypes: string[]       // task types with best success rate
  weakTypes: string[]         // task types with failures
  lastOutputHash: string | null
  topicsCovered: string[]     // extracted from descriptions
  recentVerificationIssues: string[]
}

export function getAgentProfile(agentId: string): AgentProfile {
  const db = getDb()

  const agent = db.query(`SELECT id, personality_name, team FROM agents WHERE id = ?`).get(agentId) as any
  if (!agent) throw new Error(`Agent not found: ${agentId}`)

  // Success/failure by type
  const typeStats = db.query(`
    SELECT type,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status IN ('failed', 'verification_failed') THEN 1 ELSE 0 END) as failed
    FROM actions WHERE agent_id = ?
    GROUP BY type
  `).all(agentId) as { type: string; completed: number; failed: number }[]

  const strongTypes = typeStats.filter(t => t.completed > 0 && t.failed === 0).map(t => t.type)
  const weakTypes = typeStats.filter(t => t.failed > 0).map(t => t.type)

  // Avg output length
  const outputStats = db.query(`
    SELECT AVG(LENGTH(output)) as avg_len
    FROM actions WHERE agent_id = ? AND status = 'completed' AND output IS NOT NULL
  `).get(agentId) as { avg_len: number | null }

  // Last output hash
  const lastOutput = db.query(`
    SELECT output FROM actions WHERE agent_id = ? AND status = 'completed'
    ORDER BY completed_at DESC LIMIT 1
  `).get(agentId) as { output: string } | null

  // Topics from descriptions
  const descriptions = db.query(`
    SELECT description FROM actions WHERE agent_id = ? AND status = 'completed'
  `).all(agentId) as { description: string }[]
  const topicsCovered = extractTopics(descriptions.map(d => d.description))

  // Recent verification issues
  const verIssues = db.query(`
    SELECT verification_notes FROM actions
    WHERE agent_id = ? AND verification_status = 'failed'
    ORDER BY completed_at DESC LIMIT 3
  `).all(agentId) as { verification_notes: string }[]

  const totals = db.query(`
    SELECT
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status IN ('failed', 'verification_failed') THEN 1 ELSE 0 END) as failed
    FROM actions WHERE agent_id = ?
  `).get(agentId) as { completed: number; failed: number }

  return {
    agentId,
    name: agent.personality_name,
    team: agent.team,
    totalCompleted: totals.completed ?? 0,
    totalFailed: totals.failed ?? 0,
    avgOutputLength: Math.round(outputStats.avg_len ?? 0),
    strongTypes,
    weakTypes,
    lastOutputHash: lastOutput ? createHash('sha256').update(lastOutput.output.trim()).digest('hex') : null,
    topicsCovered,
    recentVerificationIssues: verIssues.map(v => v.verification_notes),
  }
}

// ---------------------------------------------------------------------------
// Gap Analysis — what's missing in the current phase
// ---------------------------------------------------------------------------
export interface PhaseGap {
  area: string
  reason: string
  suggestedAgent: string
  suggestedType: string
  priority: 'high' | 'medium' | 'low'
}

export function analyzePhaseGaps(phase: number): PhaseGap[] {
  const db = getDb()
  const gaps: PhaseGap[] = []

  // Get all completed work in this phase
  const completed = db.query(`
    SELECT a.type, a.description, ag.team, ag.personality_name, ag.id as agent_id
    FROM actions a JOIN agents ag ON ag.id = a.agent_id
    WHERE a.phase = ? AND a.status = 'completed'
  `).all(phase) as any[]

  // Get all agents
  const agents = db.query(`SELECT id, personality_name, team, role FROM agents`).all() as any[]

  // Phase 1 gap detection
  if (phase === 1) {
    const hasMarketResearch = completed.some((c: any) => c.type === 'research' && c.team === 'strategy')
    const hasCustomerResearch = completed.some((c: any) => c.description.toLowerCase().includes('customer') || c.description.toLowerCase().includes('voice'))
    const hasScoring = completed.some((c: any) => c.description.toLowerCase().includes('scor'))
    const hasCompetitive = completed.some((c: any) => c.description.toLowerCase().includes('compet'))

    if (!hasMarketResearch) {
      gaps.push({ area: 'Market Research', reason: 'No market research completed', suggestedAgent: 'zara', suggestedType: 'research', priority: 'high' })
    }
    if (!hasCustomerResearch) {
      gaps.push({ area: 'Customer Research', reason: 'No customer/voice research completed', suggestedAgent: 'nina', suggestedType: 'research', priority: 'high' })
    }
    if (!hasScoring && completed.length >= 4) {
      gaps.push({ area: 'Opportunity Scoring', reason: 'Research done but not scored yet', suggestedAgent: 'marcus', suggestedType: 'research', priority: 'high' })
    }
    if (!hasCompetitive && completed.length >= 3) {
      gaps.push({ area: 'Competitive Analysis', reason: 'No competitive analysis found', suggestedAgent: 'zara', suggestedType: 'research', priority: 'medium' })
    }

    // Check if any team has zero contributions
    const teamsWithWork = new Set(completed.map((c: any) => c.team))
    for (const agent of agents) {
      if (agent.team === 'exec') continue // exec doesn't do Phase 1 research
      if (!teamsWithWork.has(agent.team) && ['strategy', 'tech'].includes(agent.team)) {
        gaps.push({
          area: `${agent.team} Team Contribution`,
          reason: `${agent.team} team has no Phase 1 work yet`,
          suggestedAgent: agent.id,
          suggestedType: 'research',
          priority: 'medium',
        })
      }
    }
  }

  // Phase 2 gap detection
  if (phase === 2) {
    const hasPRD = completed.some((c: any) => c.description.toLowerCase().includes('prd') || c.description.toLowerCase().includes('product requirements'))
    const hasTechSpec = completed.some((c: any) => c.description.toLowerCase().includes('tech') && c.description.toLowerCase().includes('spec'))
    const hasMVP = completed.some((c: any) => c.description.toLowerCase().includes('mvp') || c.description.toLowerCase().includes('prototype'))
    const hasLandingPage = completed.some((c: any) => c.description.toLowerCase().includes('landing') || c.description.toLowerCase().includes('page'))
    const hasPricing = completed.some((c: any) => c.description.toLowerCase().includes('pric'))

    if (!hasPRD) gaps.push({ area: 'PRD', reason: 'No product requirements document', suggestedAgent: 'marcus', suggestedType: 'write', priority: 'high' })
    if (!hasTechSpec) gaps.push({ area: 'Tech Spec', reason: 'No technical specification', suggestedAgent: 'amir', suggestedType: 'write', priority: 'high' })
    if (!hasMVP && completed.length >= 3) gaps.push({ area: 'MVP Build', reason: 'No MVP/prototype started', suggestedAgent: 'kai', suggestedType: 'build', priority: 'high' })
    if (!hasLandingPage) gaps.push({ area: 'Landing Page', reason: 'No landing page copy', suggestedAgent: 'sol', suggestedType: 'write', priority: 'medium' })
    if (!hasPricing) gaps.push({ area: 'Pricing Strategy', reason: 'No pricing analysis', suggestedAgent: 'marcus', suggestedType: 'research', priority: 'medium' })
  }

  // Phase 3 gap detection
  if (phase === 3) {
    const hasLaunchPlan = completed.some((c: any) => c.description.toLowerCase().includes('launch'))
    const hasDistribution = completed.some((c: any) => c.description.toLowerCase().includes('distribut') || c.description.toLowerCase().includes('channel'))
    const hasMetrics = completed.some((c: any) => c.description.toLowerCase().includes('metric') || c.description.toLowerCase().includes('kpi'))

    if (!hasLaunchPlan) gaps.push({ area: 'Launch Plan', reason: 'No launch plan created', suggestedAgent: 'sol', suggestedType: 'write', priority: 'high' })
    if (!hasDistribution) gaps.push({ area: 'Distribution', reason: 'No distribution strategy', suggestedAgent: 'sol', suggestedType: 'research', priority: 'high' })
    if (!hasMetrics) gaps.push({ area: 'Success Metrics', reason: 'No KPIs/metrics defined', suggestedAgent: 'jordan', suggestedType: 'write', priority: 'medium' })
  }

  return gaps
}

// ---------------------------------------------------------------------------
// Review Feedback Extraction — parse manager reviews into actionable items
// ---------------------------------------------------------------------------
export interface ReviewFeedback {
  fromAgent: string
  toAgent: string
  feedback: string
  actionable: string[]
}

export function extractReviewFeedback(agentId: string, phase: number): ReviewFeedback[] {
  const db = getDb()

  // Get review tasks that mention this agent
  const reviews = db.query(`
    SELECT a.output, ag.personality_name as reviewer_name, a.description
    FROM actions a JOIN agents ag ON ag.id = a.agent_id
    WHERE a.type = 'review' AND a.phase = ? AND a.status = 'completed'
      AND (a.output LIKE '%' || (SELECT personality_name FROM agents WHERE id = ?) || '%'
           OR a.description LIKE '%' || ? || '%')
    ORDER BY a.completed_at DESC
    LIMIT 5
  `).all(phase, agentId, agentId) as any[]

  const agentName = (db.query(`SELECT personality_name FROM agents WHERE id = ?`).get(agentId) as any)?.personality_name ?? agentId

  return reviews.map((r: any) => {
    const actionable = extractActionItems(r.output, agentName)
    return {
      fromAgent: r.reviewer_name,
      toAgent: agentName,
      feedback: r.output.slice(0, 500),
      actionable,
    }
  })
}

// ---------------------------------------------------------------------------
// Context Relevance Scoring — rank prior outputs by relevance to current task
// ---------------------------------------------------------------------------
export function scoreContextRelevance(
  taskDescription: string,
  agentId: string,
  phase: number
): Array<{ agentId: string; agentName: string; description: string; output: string; score: number }> {
  const db = getDb()

  const completed = db.query(`
    SELECT a.agent_id as agentId, a.description, substr(a.output, 1, 2000) as output, ag.personality_name as agentName
    FROM actions a JOIN agents ag ON ag.id = a.agent_id
    WHERE a.phase = ? AND a.status = 'completed' AND a.agent_id != ?
    ORDER BY a.completed_at DESC LIMIT 20
  `).all(phase, agentId) as any[]

  // Expand task keywords with concept synonyms for semantic matching
  const taskWords = extractKeywords(taskDescription, true)

  return completed.map((item: any) => {
    const descWords = extractKeywords(item.description, true)
    const outputWords = extractKeywords(item.output.slice(0, 500))
    const allWords = new Set([...descWords, ...outputWords])

    // Score = keyword overlap (now includes concept synonyms)
    let score = 0
    for (const word of taskWords) {
      if (allWords.has(word)) score += 1
    }
    // Normalize
    score = taskWords.length > 0 ? score / taskWords.length : 0

    return { ...item, score }
  })
  .filter(item => item.score > 0.1) // Only include somewhat relevant items
  .sort((a, b) => b.score - a.score)
  .slice(0, 5) // Top 5 most relevant
}

// ---------------------------------------------------------------------------
// Diminishing Returns Detection — stop assigning same type to same agent
// ---------------------------------------------------------------------------
export function isDiminishingReturns(agentId: string, taskType: string, phase: number): boolean {
  const db = getDb()

  // Get recent completed tasks of this type for this agent in this phase
  const recent = db.query(`
    SELECT output FROM actions
    WHERE agent_id = ? AND type = ? AND phase = ? AND status = 'completed'
    ORDER BY completed_at DESC LIMIT 3
  `).all(agentId, taskType, phase) as { output: string }[]

  if (recent.length < 2) return false

  // Check pairwise similarity using simple Jaccard on word sets
  const outputs = recent.map(r => new Set(extractKeywords(r.output.slice(0, 1000))))

  let highSimilarityCount = 0
  for (let i = 0; i < outputs.length - 1; i++) {
    const intersection = new Set([...outputs[i]].filter(w => outputs[i + 1].has(w)))
    const union = new Set([...outputs[i], ...outputs[i + 1]])
    const jaccard = union.size > 0 ? intersection.size / union.size : 0
    if (jaccard > 0.5) highSimilarityCount++
  }

  // If 2+ consecutive outputs are >50% similar, it's diminishing returns
  return highSimilarityCount >= 2
}

// ---------------------------------------------------------------------------
// Smart Task Generation — generate Phase 2/3 tasks from Phase 1 outputs
// ---------------------------------------------------------------------------
export function generatePhaseTasks(targetPhase: number): Array<{
  agentId: string
  type: string
  description: string
  phase: number
}> {
  const db = getDb()
  const previousPhase = targetPhase - 1

  // Get all completed work from the previous phase
  const priorWork = db.query(`
    SELECT a.output, a.description, a.type, ag.personality_name, ag.team
    FROM actions a JOIN agents ag ON ag.id = a.agent_id
    WHERE a.phase = ? AND a.status = 'completed'
    ORDER BY a.completed_at ASC
  `).all(previousPhase) as any[]

  // Extract key findings from prior work (may be empty for phases with hardcoded tasks like Phase 3)
  const allOutputText = priorWork.map((w: any) => w.output?.slice(0, 1000) ?? '').join('\n')

  // For Phase 2, we need prior work to build task descriptions -- skip if nothing completed yet
  if (priorWork.length === 0 && targetPhase === 2) return []

  // Check what gaps exist
  const gaps = analyzePhaseGaps(targetPhase)

  const tasks: Array<{ agentId: string; type: string; description: string; phase: number }> = []

  if (targetPhase === 2) {
    // Phase 2: Build & Validate — derived from Phase 1 research
    const topOpportunities = extractTopOpportunities(allOutputText)
    const customerInsights = extractCustomerInsights(allOutputText)

    // PRD from Marcus based on research findings
    tasks.push({
      agentId: 'marcus',
      type: 'write',
      description: `Write a Product Requirements Document (PRD) for the top opportunity identified in Phase 1 research. Base it on these findings:\n\n${topOpportunities}\n\nCustomer insights:\n${customerInsights}\n\nInclude: problem statement, target user, key features (prioritized), success metrics, MVP scope, and what's explicitly out of scope.`,
      phase: 2,
    })

    // Tech spec from Amir
    tasks.push({
      agentId: 'amir',
      type: 'write',
      description: `Write a Technical Specification for the MVP based on Phase 1 research. The product should address these opportunities:\n\n${topOpportunities}\n\nInclude: tech stack recommendation, architecture overview, data model, API endpoints, third-party integrations, deployment strategy, and estimated build effort (in days).`,
      phase: 2,
    })

    // Landing page copy from Sol
    tasks.push({
      agentId: 'sol',
      type: 'write',
      description: `Write landing page copy for the product identified in Phase 1. Use the customer's own language:\n\n${customerInsights}\n\nInclude: headline, subheadline, 3 key benefits, social proof strategy, pricing section copy, FAQ, and CTA. Optimize for conversion.`,
      phase: 2,
    })

    // Pricing research from Nina
    tasks.push({
      agentId: 'nina',
      type: 'research',
      description: `Research pricing strategy for the product. Analyze competitor pricing from Phase 1:\n\n${topOpportunities}\n\nDeliver: pricing tier recommendations, price anchoring strategy, free vs paid feature split, and willingness-to-pay analysis based on customer research.`,
      phase: 2,
    })

    // Competitive deep-dive from Zara
    tasks.push({
      agentId: 'zara',
      type: 'research',
      description: `Deep competitive analysis for the chosen opportunity. Based on Phase 1:\n\n${topOpportunities}\n\nFor each competitor: feature comparison, pricing, weaknesses, customer complaints, and our differentiation angle. Include indirect competitors.`,
      phase: 2,
    })

    // MVP build from Kai (once PRD + tech spec done)
    tasks.push({
      agentId: 'kai',
      type: 'build',
      description: `Build the MVP based on the PRD and tech spec from Phase 2. Start with the core feature that addresses the #1 pain point. Ship working code that a real user can try. Focus on functionality over polish.`,
      phase: 2,
    })

    // Distribution plan from Sol
    tasks.push({
      agentId: 'sol',
      type: 'write',
      description: `Create a go-to-market distribution plan. Based on where our target customers hang out (from Phase 1 customer research):\n\n${customerInsights}\n\nInclude: launch channels ranked by expected ROI, content strategy, community engagement plan, and first-week launch checklist.`,
      phase: 2,
    })

    // Ops planning from Jordan
    tasks.push({
      agentId: 'jordan',
      type: 'write',
      description: `Create an operations plan for launch. Include: customer support workflow, bug triage process, monitoring/alerting setup, payment processing, legal requirements (ToS, privacy), and risk mitigation.`,
      phase: 2,
    })

    // CEO review from Reza
    tasks.push({
      agentId: 'reza',
      type: 'decide',
      description: `Review Phase 2 deliverables and make a go/no-go decision for Phase 3 launch. Evaluate: Is the MVP ready? Is the market validated? Is the team aligned? What risks remain? Provide your decision with clear rationale.`,
      phase: 2,
    })
  }

  if (targetPhase === 3) {
    // Phase 3: Launch & Revenue — derived from Phase 2 build
    tasks.push({
      agentId: 'sol',
      type: 'write',
      description: 'Execute the launch plan. Write all launch day content: Product Hunt post, Twitter/X thread, Reddit posts, Hacker News Show HN, email to beta list. Each piece customized for the platform.',
      phase: 3,
    })

    tasks.push({
      agentId: 'kai',
      type: 'build',
      description: 'Deploy the MVP to production. Set up analytics tracking, error monitoring, and payment processing. Ensure the landing page links to the live product.',
      phase: 3,
    })

    tasks.push({
      agentId: 'jordan',
      type: 'write',
      description: 'Set up customer support and feedback collection. Create templates for common support requests, set up feedback forms, and define the bug report → fix → deploy workflow.',
      phase: 3,
    })

    tasks.push({
      agentId: 'nina',
      type: 'research',
      description: 'Monitor launch day metrics and customer feedback. Collect: sign-ups, conversions, bounce rate, customer comments, support requests. Produce a real-time launch report.',
      phase: 3,
    })

    tasks.push({
      agentId: 'marcus',
      type: 'write',
      description: 'Post-launch analysis: What worked, what didn\'t. Revenue vs projections. Customer acquisition cost. Recommendations for next 7 days.',
      phase: 3,
    })

    tasks.push({
      agentId: 'reza',
      type: 'decide',
      description: 'Final experiment report. Evaluate: Did we hit $1 in revenue? What did we learn? What would we do differently? Grade each team\'s performance.',
      phase: 3,
    })
  }

  // Filter out tasks that would duplicate existing tasks in ANY state
  // Previously only checked queued/running -- causing 13x duplication when failed tasks
  // got regenerated every 30 cycles
  const existing = db.query(`
    SELECT agent_id, type, substr(description, 1, 80) as desc_prefix, status FROM actions
    WHERE phase = ?
  `).all(targetPhase) as { agent_id: string; type: string; desc_prefix: string; status: string }[]

  return tasks.filter(t => {
    const descPrefix = t.description.slice(0, 80)
    // Skip if this agent already has ANY task of this type+description in this phase
    // (completed, failed, verification_failed, queued, running -- doesn't matter)
    const hasDuplicate = existing.some(e =>
      e.agent_id === t.agentId && e.type === t.type && e.desc_prefix === descPrefix
    )
    if (hasDuplicate) return false
    // Also skip if agent already has a completed task of this type (they did the work)
    const hasCompleted = existing.some(e =>
      e.agent_id === t.agentId && e.type === t.type && e.status === 'completed'
    )
    return !hasCompleted
  })
}

// ---------------------------------------------------------------------------
// Dynamic Task Generation -- evaluates completed work and plans next batch
//
// Called at sprint boundaries and sim day transitions. Reads actual outputs
// from completed tasks, identifies what's done vs what's needed, and generates
// context-aware follow-up tasks.
//
// This replaces the hardcoded "generate everything at phase start" approach.
// ---------------------------------------------------------------------------

interface TaskPlan {
  agentId: string
  type: string
  description: string
  phase: number
}

export function generateDynamicTasks(phase: number): TaskPlan[] {
  const db = getDb()
  const tasks: TaskPlan[] = []

  // 1. Get all completed work this phase with actual outputs
  const completed = db.query(`
    SELECT a.agent_id, ag.personality_name, ag.team, ag.role,
           a.type, a.description, substr(a.output, 1, 1500) as output_preview
    FROM actions a
    JOIN agents ag ON ag.id = a.agent_id
    WHERE a.phase = ? AND a.status = 'completed'
    ORDER BY a.completed_at DESC
  `).all(phase) as any[]

  // 2. Get all agents with their current task load
  const agentLoads = db.query(`
    SELECT agent_id, COUNT(*) as pending
    FROM actions
    WHERE phase = ? AND status IN ('queued', 'running')
    GROUP BY agent_id
  `).all(phase) as { agent_id: string; pending: number }[]
  const loadMap = new Map(agentLoads.map(a => [a.agent_id, a.pending]))

  // 3. Get decisions made (product choice, pricing, etc.)
  const decisions = db.query(`
    SELECT made_by_agent, title, body FROM decisions
    WHERE phase <= ? AND status IN ('approved', 'ratified')
    ORDER BY created_at DESC LIMIT 5
  `).all(phase) as any[]

  // 4. Build a summary of what's done
  const completedByAgent = new Map<string, string[]>()
  for (const c of completed) {
    const list = completedByAgent.get(c.agent_id) || []
    list.push(`${c.type}: ${c.description.slice(0, 100)}`)
    completedByAgent.set(c.agent_id, list)
  }

  // 5. Get idle agents (no queued/running tasks)
  const allAgents = db.query(`
    SELECT id, personality_name, team, role FROM agents WHERE status != 'suspended'
  `).all() as { id: string; personality_name: string; team: string; role: string }[]

  const idleAgents = allAgents.filter(a => (loadMap.get(a.id) ?? 0) === 0)

  // 6. Build product context from decisions + completed outputs
  const productContext = buildProductContext(decisions, completed)

  // 7. Generate tasks based on what's actually needed
  for (const agent of idleAgents) {
    const agentCompleted = completedByAgent.get(agent.id) || []

    // Skip if agent has done 3+ tasks this phase (diminishing returns)
    if (agentCompleted.length >= 3) continue

    const task = planTaskForAgent(agent, phase, productContext, agentCompleted, completed)
    if (task) tasks.push(task)
  }

  // Dedup filter (same as generatePhaseTasks)
  const existing = db.query(`
    SELECT agent_id, type, substr(description, 1, 80) as desc_prefix FROM actions
    WHERE phase = ?
  `).all(phase) as { agent_id: string; type: string; desc_prefix: string }[]

  return tasks.filter(t => {
    const prefix = t.description.slice(0, 80)
    return !existing.some(e => e.agent_id === t.agentId && e.desc_prefix === prefix)
  })
}

function buildProductContext(decisions: any[], completed: any[]): string {
  const parts: string[] = []

  // Extract product decisions
  for (const d of decisions) {
    parts.push(`DECISION by ${d.made_by_agent}: ${d.title}\n${(d.body ?? '').slice(0, 300)}`)
  }

  // Extract key deliverables from completed work
  const keyOutputs = completed
    .filter((c: any) => ['build', 'write', 'decide'].includes(c.type))
    .slice(0, 5)
  for (const c of keyOutputs) {
    // Look for Handoff section first (structured summary)
    const handoffIdx = c.output_preview?.indexOf('## Handoff') ?? -1
    const summary = handoffIdx !== -1
      ? c.output_preview.slice(handoffIdx, handoffIdx + 500)
      : c.output_preview?.slice(0, 300) ?? ''
    parts.push(`${c.personality_name} (${c.type}): ${summary}`)
  }

  return parts.join('\n\n---\n\n')
}

function planTaskForAgent(
  agent: { id: string; personality_name: string; team: string; role: string },
  phase: number,
  productContext: string,
  agentCompleted: string[],
  allCompleted: any[]
): TaskPlan | null {
  // Role-based task planning -- what does this agent's role need to do NEXT
  // given what's been completed?

  const hasBuilt = allCompleted.some((c: any) => c.type === 'build' && c.team === 'tech')
  const hasLaunched = allCompleted.some((c: any) =>
    c.output_preview?.toLowerCase().includes('deploy') ||
    c.output_preview?.toLowerCase().includes('live') ||
    c.output_preview?.toLowerCase().includes('launched'))
  const hasGTM = allCompleted.some((c: any) => c.agent_id === 'sol' && c.type === 'write')
  const hasCopy = allCompleted.some((c: any) => c.agent_id === 'cass' && c.type === 'write')
  const hasQA = allCompleted.some((c: any) => c.agent_id === 'theo')
  const contextSnippet = productContext.slice(0, 800)

  // Phase 2: Build & Validate
  if (phase === 2) {
    switch (agent.role) {
      case 'Engineer':
        if (!hasBuilt) return { agentId: agent.id, type: 'build', phase,
          description: `Build the MVP based on team decisions and specs.\n\nContext:\n${contextSnippet}\n\nShip working code a real user can try. Focus on core feature.` }
        break
      case 'QA Engineer':
        if (hasBuilt) return { agentId: agent.id, type: 'review', phase,
          description: `QA the MVP build. Test core user flows, edge cases, and verify all links/forms work.\n\nContext:\n${contextSnippet}` }
        break
    }
  }

  // Phase 3: Launch & Revenue
  if (phase === 3) {
    switch (agent.team) {
      case 'tech':
        if (agent.role === 'Engineer' && !hasLaunched)
          return { agentId: agent.id, type: 'build', phase,
            description: `Deploy and verify the product is live. Check payment flow, analytics, error monitoring.\n\nWhat was built:\n${contextSnippet}` }
        if (agent.role === 'QA Engineer' && hasBuilt && !hasQA)
          return { agentId: agent.id, type: 'review', phase,
            description: `Run full QA on the live product. Test purchase flow end-to-end, verify all links, check mobile.\n\nProduct context:\n${contextSnippet}` }
        if (agent.role === 'Frontend Engineer' && hasBuilt)
          return { agentId: agent.id, type: 'build', phase,
            description: `Polish the landing page and buyer experience. Check responsive design, load speed, CTA clarity.\n\nProduct context:\n${contextSnippet}` }
        break

      case 'marketing':
        if (agent.id === 'sol' && !hasGTM)
          return { agentId: agent.id, type: 'write', phase,
            description: `Write launch content for all channels: Product Hunt, Reddit, Twitter/X, email. Customize each for the platform.\n\nProduct:\n${contextSnippet}` }
        if (agent.id === 'vera')
          return { agentId: agent.id, type: 'write', phase,
            description: `Execute growth tactics for launch week. Set up tracking links, schedule posts, identify quick-win distribution channels.\n\nProduct:\n${contextSnippet}` }
        if (agent.id === 'cass' && !hasCopy)
          return { agentId: agent.id, type: 'write', phase,
            description: `Write product copy: Gumroad listing description, email sequences, social proof snippets.\n\nProduct:\n${contextSnippet}` }
        if (agent.id === 'paz')
          return { agentId: agent.id, type: 'write', phase,
            description: `Create visual assets for launch: social media graphics specs, product screenshots layout, brand guidelines for listing.\n\nProduct:\n${contextSnippet}` }
        break

      case 'strategy':
        if (agent.id === 'nina')
          return { agentId: agent.id, type: 'research', phase,
            description: `Monitor launch metrics and customer feedback. Track: sign-ups, conversions, bounce rate, support requests.\n\nProduct:\n${contextSnippet}` }
        if (agent.id === 'marcus')
          return { agentId: agent.id, type: 'write', phase,
            description: `Post-launch analysis. Revenue vs projections, acquisition cost, channel performance, recommendations.\n\nProduct:\n${contextSnippet}` }
        if (agent.id === 'zara')
          return { agentId: agent.id, type: 'research', phase,
            description: `Competitive response analysis. Monitor competitor reactions, identify positioning opportunities, track market share signals.\n\nProduct:\n${contextSnippet}` }
        break

      case 'ops':
        if (agent.id === 'jordan')
          return { agentId: agent.id, type: 'write', phase,
            description: `Set up customer support: FAQ, email templates, bug triage workflow, feedback collection.\n\nProduct:\n${contextSnippet}` }
        if (agent.id === 'alex')
          return { agentId: agent.id, type: 'write', phase,
            description: `Financial setup: verify payment processing, set up revenue tracking, reconcile costs vs budget.\n\nProduct:\n${contextSnippet}` }
        break

      case 'exec':
        if (agent.id === 'reza' && allCompleted.length >= 5)
          return { agentId: agent.id, type: 'decide', phase,
            description: `Review launch progress and make go/iterate decisions. Evaluate team output, identify blockers, prioritize next actions.\n\nCompleted work:\n${contextSnippet}` }
        if (agent.id === 'priya')
          return { agentId: agent.id, type: 'review', phase,
            description: `Audit phase progress: Are all workstreams on track? Who's blocked? What's missing? Flag risks.\n\nCompleted work:\n${contextSnippet}` }
        break
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Build smart context — replaces the "dump everything" approach in memory.ts
// ---------------------------------------------------------------------------
export function buildSmartContext(
  agentId: string,
  personalityName: string,
  taskDescription: string,
  phase: number
): string {
  const profile = getAgentProfile(agentId)
  const relevantWork = scoreContextRelevance(taskDescription, agentId, phase)
  const feedback = extractReviewFeedback(agentId, phase)
  const gaps = analyzePhaseGaps(phase)

  let context = ''

  // Performance awareness
  if (profile.totalFailed > 0) {
    context += `\n## Performance Note\nYou have ${profile.totalFailed} failed task(s). `
    if (profile.recentVerificationIssues.length > 0) {
      context += `Recent issues: ${profile.recentVerificationIssues[0]}. `
    }
    context += 'Ensure your output is substantive (>150 chars), contains no placeholder text, and differs from your previous outputs.\n'
  }

  // Relevant prior work — prefer Handoff sections (structured for next person)
  if (relevantWork.length > 0) {
    context += '\n## Most Relevant Prior Work\n'
    for (const item of relevantWork.slice(0, 3)) { // Top 3, not 5
      const handoffIdx = item.output.indexOf('## Handoff')
      let summary: string
      if (handoffIdx !== -1) {
        summary = item.output.slice(handoffIdx, handoffIdx + 800)
      } else {
        summary = item.output.slice(0, 800)
      }
      context += `### ${item.agentName}: ${item.description.slice(0, 100)}\n${summary}\n\n`
    }
  }

  // Feedback from reviews
  if (feedback.length > 0) {
    context += '\n## Feedback From Reviews\n'
    for (const fb of feedback) {
      context += `**${fb.fromAgent}**: ${fb.feedback.slice(0, 300)}\n`
      if (fb.actionable.length > 0) {
        context += `Action items: ${fb.actionable.join('; ')}\n`
      }
    }
  }

  // What's still needed (gap awareness)
  const relevantGaps = gaps.filter(g => g.suggestedAgent === agentId)
  if (relevantGaps.length > 0) {
    context += '\n## What\'s Still Needed From You\n'
    for (const gap of relevantGaps) {
      context += `- ${gap.area}: ${gap.reason}\n`
    }
  }

  return context
}

// ---------------------------------------------------------------------------
// Build smart context AND return which agent IDs were actually cited (top-3)
// Used by runner.ts to award output_cited only to agents whose work was used
// ---------------------------------------------------------------------------
export function buildSmartContextWithCitations(
  agentId: string,
  personalityName: string,
  taskDescription: string,
  phase: number
): { context: string; citedAgentIds: string[] } {
  const relevantWork = scoreContextRelevance(taskDescription, agentId, phase)
  const top3 = relevantWork.slice(0, 3)
  const citedAgentIds = [...new Set(top3.map(item => item.agentId).filter(Boolean))]

  // Build the full context using the existing function
  const context = buildSmartContext(agentId, personalityName, taskDescription, phase)

  return { context, citedAgentIds }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Hoisted to module scope (was re-created on every call)
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'that', 'this', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we', 'our', 'you', 'your', 'he', 'she', 'his', 'her', 'not', 'no', 'all', 'each', 'every', 'any', 'some', 'most', 'more', 'less', 'than', 'as', 'so', 'if', 'then', 'else', 'when', 'where', 'how', 'what', 'which', 'who', 'whom'])

// Concept synonym groups -- expands keyword matching to catch semantic neighbors
// "pricing" matches work about "revenue model" even without exact word overlap
const CONCEPT_GROUPS: string[][] = [
  ['customer', 'user', 'buyer', 'client', 'audience', 'persona'],
  ['pricing', 'revenue', 'monetization', 'willingness', 'payment', 'subscription'],
  ['mvp', 'prototype', 'build', 'ship', 'launch', 'deploy'],
  ['marketing', 'distribution', 'channel', 'acquisition', 'growth', 'funnel'],
  ['competitor', 'competition', 'alternative', 'incumbent', 'rival'],
  ['feedback', 'survey', 'interview', 'validation', 'testing'],
  ['opportunity', 'niche', 'market', 'segment', 'vertical'],
  ['brand', 'identity', 'positioning', 'messaging', 'voice'],
  ['budget', 'spend', 'cost', 'expense', 'investment', 'allocation'],
  ['blocker', 'obstacle', 'issue', 'problem', 'bottleneck', 'risk'],
]

// Pre-compute word -> concept group index for O(1) lookup
const _conceptIndex = new Map<string, number>()
for (let i = 0; i < CONCEPT_GROUPS.length; i++) {
  for (const word of CONCEPT_GROUPS[i]) {
    _conceptIndex.set(word, i)
  }
}

function extractKeywords(text: string, expandConcepts = false): Set<string> {
  const words = new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  )

  // Expand with synonym concepts for better semantic matching
  if (expandConcepts) {
    const expanded = new Set(words)
    for (const word of words) {
      const groupIdx = _conceptIndex.get(word)
      if (groupIdx !== undefined) {
        for (const synonym of CONCEPT_GROUPS[groupIdx]) {
          expanded.add(synonym)
        }
      }
    }
    return expanded
  }

  return words
}

function extractTopics(descriptions: string[]): string[] {
  const allKeywords = descriptions.flatMap(d => [...extractKeywords(d)])
  const counts = new Map<string, number>()
  for (const word of allKeywords) {
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word)
}

function extractActionItems(reviewOutput: string, agentName: string): string[] {
  const items: string[] = []
  const lines = reviewOutput.split('\n')

  for (const line of lines) {
    const lower = line.toLowerCase()
    // Look for action-oriented lines mentioning this agent
    if (lower.includes(agentName.toLowerCase()) && (
      lower.includes('should') || lower.includes('needs to') || lower.includes('must') ||
      lower.includes('recommend') || lower.includes('next step') || lower.includes('follow up') ||
      lower.includes('action:') || lower.includes('todo:') || lower.includes('task:')
    )) {
      items.push(line.trim().slice(0, 200))
    }
  }

  return items.slice(0, 5)
}

function extractTopOpportunities(text: string): string {
  // Look for numbered lists, scoring sections, or "top" mentions
  const lines = text.split('\n')
  const relevant: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase()
    if (line.includes('top') || line.includes('#1') || line.includes('highest score') ||
        line.includes('opportunity') || line.includes('recommend') ||
        /^\s*\d+[\.\)]\s/.test(lines[i])) {
      // Grab this line and next 2 for context
      relevant.push(lines.slice(i, i + 3).join('\n'))
      if (relevant.length >= 5) break
    }
  }

  if (relevant.length > 0) {
    return relevant.join('\n\n').slice(0, 2000)
  }

  // Fallback: return a chunked summary of the raw output instead of a vague pointer
  // This ensures downstream agents always get real content to work with
  return text.slice(0, 2000) || '[NO PRIOR RESEARCH FOUND -- use your best judgment based on the product context]'
}

function extractCustomerInsights(text: string): string {
  const lines = text.split('\n')
  const relevant: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase()
    if (line.includes('customer') || line.includes('user') || line.includes('pain') ||
        line.includes('quote') || line.includes('wish') || line.includes('complaint') ||
        line.includes('willing to pay') || line.includes('voice')) {
      relevant.push(lines.slice(i, i + 2).join('\n'))
      if (relevant.length >= 5) break
    }
  }

  if (relevant.length > 0) {
    return relevant.join('\n\n').slice(0, 1500)
  }

  // Fallback: return raw output chunk instead of a vague pointer
  return text.slice(0, 1500) || '[NO CUSTOMER RESEARCH FOUND -- use your best judgment based on the product context]'
}
