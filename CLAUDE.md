# AgentOS Simulation — Claude Code Instructions

## What This Project Is
A multi-agent simulation orchestrator. 18 AI agents with distinct personalities work
autonomously to build and launch a product and generate real revenue.

## Your Job When Working on This Repo
You are maintaining and extending the ORCHESTRATOR — not the product being built.
The product lives at ~/experiment-product/ (separate repo, separate concerns).

Never modify ~/experiment-product/ from within this repo.
Never create worktrees in this repo — the orchestrator is a single-branch system.

## Critical Rules
1. Run `bun run migrate` before any schema changes take effect
2. All agent spawning happens through runner.ts — never bypass it
3. The reward system (server/reward/) is the most sensitive code — test changes carefully
4. Budget enforcer (server/budget/enforcer.ts) must never be disabled even during testing
5. All logs are append-only — never delete from /logs/ during a run

## Tech Stack
- Runtime: Bun (native SQLite via bun:sqlite, Bun.spawn() for agents)
- Backend: Hono on Bun
- Database: Bun native SQLite (raw SQL, no ORM)
- Frontend: Vite + React + Tailwind
- Real-time: AG-UI SSE protocol
- Bun automatically loads .env — no dotenv needed

## File Structure
server/         ← Hono backend + orchestrator
ui/             ← Vite + React dashboard
migrations/     ← SQL migrations, applied in numeric order
scripts/        ← Seed, reset, audit, init-product-repo
logs/           ← Append-only experiment logs

## Running the Project
bun run dev          ← starts orchestrator + UI dev server
bun run migrate      ← applies pending migrations
bun run seed         ← seeds all 18 agents (idempotent)
bun run audit        ← pre-flight checks
bun run reset        ← DANGER: wipes DB and state for fresh experiment
