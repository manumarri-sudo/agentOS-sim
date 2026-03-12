import type { Context, Next } from 'hono'
import { logGovernanceEvent } from '../governance/observer'

// ---------------------------------------------------------------------------
// API Auth Layer — Phase 5
//
// Every route has an explicit caller type: 'agent' | 'orchestrator' | 'human' | 'system'
//
// Agent token: AGENT_TOKEN env var injected per spawn, scoped to agentId
//   Format: 'agent-[agentId]-[sessionId]'
//
// Orchestrator: internal calls only (same process or localhost:3411/internal/*)
//
// Human token: SIM_HUMAN_TOKEN from .env
// ---------------------------------------------------------------------------

export type CallerType = 'agent' | 'orchestrator' | 'human' | 'system' | 'unknown'

export interface AuthInfo {
  callerType: CallerType
  callerId: string | null | undefined
  agentId: string | null | undefined
}

// ---------------------------------------------------------------------------
// Route permission table
// ---------------------------------------------------------------------------
interface RoutePermission {
  pattern: RegExp
  method: string
  allowedCallers: CallerType[]
  agentIdCheck?: 'own_only' | 'zara_only'  // additional agent constraints
}

const ROUTE_PERMISSIONS: RoutePermission[] = [
  // Agent-accessible routes
  { pattern: /^\/api\/action\/complete$/, method: 'POST', allowedCallers: ['agent', 'orchestrator'] },
  { pattern: /^\/api\/action\/update$/, method: 'POST', allowedCallers: ['agent', 'orchestrator'] },
  { pattern: /^\/api\/message\/send$/, method: 'POST', allowedCallers: ['agent', 'orchestrator', 'human'] },
  { pattern: /^\/api\/messages\/send$/, method: 'POST', allowedCallers: ['agent', 'orchestrator', 'human'] },
  { pattern: /^\/api\/messages\/broadcast$/, method: 'POST', allowedCallers: ['agent', 'orchestrator', 'human'] },
  { pattern: /^\/api\/phase\/declare-ready$/, method: 'POST', allowedCallers: ['agent', 'orchestrator'] },
  { pattern: /^\/api\/agent\/[^/]+\/.*$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human'], agentIdCheck: 'own_only' },
  { pattern: /^\/api\/phase\/fast-track$/, method: 'POST', allowedCallers: ['agent', 'orchestrator'], agentIdCheck: 'zara_only' },
  { pattern: /^\/api\/marketing\/queue$/, method: 'POST', allowedCallers: ['agent', 'orchestrator', 'human'] },
  { pattern: /^\/api\/agent\/checkin$/, method: 'POST', allowedCallers: ['agent', 'orchestrator'] },
  { pattern: /^\/api\/agent\/commit$/, method: 'POST', allowedCallers: ['agent', 'orchestrator'] },
  { pattern: /^\/api\/agent\/set-urgency$/, method: 'POST', allowedCallers: ['agent', 'orchestrator'] },
  { pattern: /^\/api\/worktree\/declare-file$/, method: 'POST', allowedCallers: ['agent', 'orchestrator'] },

  // Agent/Orchestrator routes
  { pattern: /^\/api\/budget\/spend$/, method: 'POST', allowedCallers: ['agent', 'orchestrator', 'human'] },
  { pattern: /^\/api\/agent\/velocity-assessment$/, method: 'POST', allowedCallers: ['agent', 'orchestrator'] },
  { pattern: /^\/api\/phase\/deadline-revision$/, method: 'POST', allowedCallers: ['agent', 'orchestrator'] },
  { pattern: /^\/api\/phase\/deadline$/, method: 'POST', allowedCallers: ['orchestrator', 'human'] },
  { pattern: /^\/api\/agents\/[^/]+\/kill$/, method: 'POST', allowedCallers: ['human', 'orchestrator'] },

  // Human-only routes
  { pattern: /^\/api\/phase\/advance$/, method: 'POST', allowedCallers: ['human', 'orchestrator'] },
  { pattern: /^\/api\/marketing\/queue\/[^/]+\/approve$/, method: 'POST', allowedCallers: ['human'] },
  { pattern: /^\/api\/marketing\/queue\/[^/]+\/reject$/, method: 'POST', allowedCallers: ['human'] },
  { pattern: /^\/api\/budget\/override$/, method: 'POST', allowedCallers: ['human', 'orchestrator'] },
  { pattern: /^\/api\/experiment\/kill$/, method: 'POST', allowedCallers: ['human'] },

  // Reward system — NEVER accessible to agents
  { pattern: /^\/api\/reward\/event$/, method: 'POST', allowedCallers: ['orchestrator', 'system'] },
  { pattern: /^\/api\/reward\/revenue$/, method: 'POST', allowedCallers: ['orchestrator', 'human'] },
  { pattern: /^\/api\/reward\/.*$/, method: 'POST', allowedCallers: ['orchestrator', 'human'] },

  // Human directives
  { pattern: /^\/api\/directive$/, method: 'POST', allowedCallers: ['human'] },

  // CEO Chat — human sends messages, orchestrator posts Reza's responses
  { pattern: /^\/api\/ceo-chat$/, method: 'POST', allowedCallers: ['human', 'orchestrator'] },
  { pattern: /^\/api\/ceo-chat\/from-reza$/, method: 'POST', allowedCallers: ['orchestrator'] },

  // LLM Provider management — human only
  { pattern: /^\/api\/provider$/, method: 'POST', allowedCallers: ['human'] },
  { pattern: /^\/api\/provider\/bulk$/, method: 'POST', allowedCallers: ['human'] },
  { pattern: /^\/api\/provider\/team\/[^/]+$/, method: 'POST', allowedCallers: ['human'] },
  { pattern: /^\/api\/provider\/[^/]+$/, method: 'POST', allowedCallers: ['human'] },
  { pattern: /^\/api\/provider$/, method: 'GET', allowedCallers: ['human', 'orchestrator'] },

  // Orchestrator control — human/orchestrator only
  { pattern: /^\/api\/orchestrator\/start$/, method: 'POST', allowedCallers: ['human', 'orchestrator'] },
  { pattern: /^\/api\/orchestrator\/stop$/, method: 'POST', allowedCallers: ['human', 'orchestrator'] },

  // Read-only routes — open to all authenticated callers
  { pattern: /^\/api\/health$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/agents$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/phases$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/budget$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/clock$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/reward\/.*$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/messages.*$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/tasks\/all$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/tasks\/.*$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/opportunities$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/debates$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/marketing\/queue$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/reports$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/orchestrator\/status$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/agents\/active$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/usage\/summary$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/governance\/events$/, method: 'GET', allowedCallers: ['orchestrator', 'human'] },
  { pattern: /^\/api\/activity$/, method: 'GET', allowedCallers: ['agent', 'orchestrator', 'human', 'system'] },
  { pattern: /^\/api\/ceo-chat$/, method: 'GET', allowedCallers: ['human', 'orchestrator'] },
  { pattern: /^\/api\/ceo-chat\/unread$/, method: 'GET', allowedCallers: ['human', 'orchestrator'] },
]

// ---------------------------------------------------------------------------
// Resolve caller identity from token
// ---------------------------------------------------------------------------
export function resolveAuth(authHeader: string | undefined): AuthInfo {
  if (!authHeader) {
    return { callerType: 'unknown', callerId: null, agentId: null }
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim()

  // Agent token: agent-[agentId]-[sessionId]
  const agentMatch = token.match(/^agent-([a-z]+)-(.+)$/)
  if (agentMatch) {
    return {
      callerType: 'agent',
      callerId: agentMatch[1],
      agentId: agentMatch[1],
    }
  }

  // Human token
  const humanToken = process.env.SIM_HUMAN_TOKEN
  if (humanToken && token === humanToken) {
    return { callerType: 'human', callerId: 'human', agentId: null }
  }

  // Orchestrator internal token
  if (token === 'orchestrator-internal' || token.startsWith('orch-')) {
    return { callerType: 'orchestrator', callerId: 'orchestrator', agentId: null }
  }

  // System token
  if (token === 'system-internal') {
    return { callerType: 'system', callerId: 'system', agentId: null }
  }

  return { callerType: 'unknown', callerId: null, agentId: null }
}

// ---------------------------------------------------------------------------
// Find matching route permission
// ---------------------------------------------------------------------------
function findRoutePermission(path: string, method: string): RoutePermission | null {
  // Try most specific patterns first (POST before GET wildcard matches)
  for (const perm of ROUTE_PERMISSIONS) {
    if (perm.method === method && perm.pattern.test(path)) {
      return perm
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
export function authMiddleware() {
  return async (c: Context, next: Next) => {
    const path = c.req.path
    const method = c.req.method

    // Skip auth for non-API routes (static files, SSE stream, root)
    // Also skip for /public/* routes (read-only spectator dashboard)
    if (!path.startsWith('/api/') || path.startsWith('/public/')) {
      await next()
      return
    }

    // Resolve auth from header
    const auth = resolveAuth(c.req.header('Authorization'))

    // Dashboard UI (same-origin browser requests) — treat as human
    // The UI serves from the same origin; unauthenticated requests are dashboard calls.
    // GETs are polls, POSTs are human-initiated actions (phase advance, directives, etc.)
    if (auth.callerType === 'unknown') {
      const origin = c.req.header('Origin') || c.req.header('Referer') || ''
      const isSameOrigin =
        origin.includes('localhost') ||
        origin.includes('127.0.0.1') ||
        origin === '' ||  // same-origin requests may omit Origin/Referer
        method === 'GET'
      if (isSameOrigin) {
        auth.callerType = 'human'
        auth.callerId = 'dashboard'
      }
    }

    // Attach auth info to context for downstream handlers
    c.set('auth', auth)

    // In development without SIM_HUMAN_TOKEN, treat as orchestrator (backward compat)
    if (auth.callerType === 'unknown' && !process.env.SIM_HUMAN_TOKEN) {
      // No auth configured — allow all (dev mode)
      await next()
      return
    }

    // Find route permission
    const permission = findRoutePermission(path, method)

    if (!permission) {
      // No explicit permission — default to allowing reads, blocking writes
      if (method === 'GET') {
        await next()
        return
      }
      // Unknown POST/PUT/DELETE — block for agents, allow for human/orchestrator
      if (auth.callerType === 'human' || auth.callerType === 'orchestrator') {
        await next()
        return
      }
      logGovernanceEvent({
        eventType: 'permission_decay',
        agentId: auth.agentId ?? undefined,
        details: `Attempted access to unmapped route: ${method} ${path}`,
        route: `${method} ${path}`,
        severity: 'warning',
      })
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Check caller type
    if (!permission.allowedCallers.includes(auth.callerType)) {
      // Only log governance events for AGENTS violating permissions
      // Unauthenticated/unknown requests are just auth failures, not governance violations
      if (auth.callerType === 'agent') {
        logGovernanceEvent({
          eventType: 'permission_decay',
          agentId: auth.agentId ?? undefined,
          details: `Agent ${auth.agentId} attempted ${method} ${path} -- not permitted`,
          route: `${method} ${path}`,
          severity: 'warning',
        })
      }
      // Unknown/unauthenticated requests silently rejected (not governance events)
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Agent-specific constraints
    if (auth.callerType === 'agent' && permission.agentIdCheck) {
      if (permission.agentIdCheck === 'zara_only' && auth.agentId !== 'zara') {
        logGovernanceEvent({
          eventType: 'permission_decay',
          agentId: auth.agentId ?? undefined,
          details: `Agent ${auth.agentId} attempted ${method} ${path} — zara_only route`,
          route: `${method} ${path}`,
          severity: 'warning',
        })
        return c.json({ error: 'Forbidden' }, 403)
      }

      if (permission.agentIdCheck === 'own_only') {
        // Extract agentId from URL path
        const urlAgentMatch = path.match(/\/api\/agent\/([^/]+)/)
        if (urlAgentMatch && urlAgentMatch[1] !== auth.agentId) {
          logGovernanceEvent({
            eventType: 'permission_decay',
            agentId: auth.agentId ?? undefined,
            details: `Agent ${auth.agentId} attempted to access another agent's data: ${path}`,
            route: `${method} ${path}`,
            severity: 'warning',
          })
          return c.json({ error: 'Forbidden' }, 403)
        }
      }
    }

    await next()
  }
}

// ---------------------------------------------------------------------------
// Protected table write guard — import check for agent routes
// ---------------------------------------------------------------------------
const PROTECTED_TABLES = [
  'collaboration_events',
  'capability_tiers',
  'phase_scores',
  'usage_budget',
]

export function isProtectedTableWrite(tableName: string): boolean {
  return PROTECTED_TABLES.includes(tableName)
}
