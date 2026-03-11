import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Init Product Repo — triggered when Phase 2→3 gate opens
//
// Creates ~/experiment-product with:
//   - git init, main branch
//   - CLAUDE.md with experiment rules
//   - post-commit hook for orchestrator reporting
//   - Branch protection configured
// ---------------------------------------------------------------------------

const PRODUCT_REPO = process.env.PRODUCT_REPO_PATH ?? join(process.env.HOME ?? '', 'experiment-product')
const ORCHESTRATOR_URL = `http://localhost:${process.env.PORT ?? 3411}`

function run(cmd: string[], cwd: string): boolean {
  const result = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr)
    console.error(`  Command failed: ${cmd.join(' ')}\n  ${stderr}`)
    return false
  }
  return true
}

async function initProductRepo(): Promise<void> {
  console.log('=== INIT PRODUCT REPO ===\n')

  // 1. Create directory
  if (existsSync(PRODUCT_REPO)) {
    console.log(`  Product repo already exists at ${PRODUCT_REPO}`)
    console.log('  Skipping init (idempotent).')
    return
  }

  console.log(`  Creating ${PRODUCT_REPO}...`)
  mkdirSync(PRODUCT_REPO, { recursive: true })

  // 2. Git init
  console.log('  git init...')
  run(['git', 'init'], PRODUCT_REPO)
  run(['git', 'checkout', '-b', 'main'], PRODUCT_REPO)

  // 3. Write CLAUDE.md
  console.log('  Writing CLAUDE.md...')
  const claudeMd = `# Experiment Product — Agent Instructions

## Rules for ALL agents working in this repo

1. **Work in your assigned worktree only** — never touch files outside your worktree branch.
2. **Declare files before editing**: POST ${ORCHESTRATOR_URL}/api/worktree/declare-file
   with { "agentId": "<your-id>", "filePath": "<path>" }
3. **Check-in every 30 minutes**: POST ${ORCHESTRATOR_URL}/api/agent/checkin
   with { "agentId": "<your-id>" }
4. **Merge Manager handles all merges** — never self-merge to main.
5. **You cannot modify** server/, migrations/, sim.db, or any file outside your worktree.

## Commit Protocol
- All commits are reported to the orchestrator via post-commit hook.
- Commits touching protected paths will be rejected.
- Write meaningful commit messages describing what changed and why.

## Code Standards
- All code must pass \`bun test\` before marking task complete.
- Follow existing patterns and conventions in the codebase.
- No placeholder code (TODO, TBD, coming soon).
`

  writeFileSync(join(PRODUCT_REPO, 'CLAUDE.md'), claudeMd)

  // 4. Write .gitignore
  writeFileSync(join(PRODUCT_REPO, '.gitignore'), `node_modules/
dist/
.env
*.db
*.log
.DS_Store
`)

  // 5. Create hooks directory and post-commit hook
  console.log('  Installing git hooks...')
  const hooksDir = join(PRODUCT_REPO, '.git', 'hooks')
  mkdirSync(hooksDir, { recursive: true })

  const postCommitHook = `#!/bin/bash
# AgentOS post-commit hook — reports commits to orchestrator

AGENT_ID="\${AGENT_ID:-unknown}"
COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --pretty=%B)
DIFF_STAT=$(git diff-tree --no-commit-id --name-only -r HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Check for protected file touches
PROTECTED_TOUCH=""
echo "$DIFF_STAT" | while read -r file; do
  case "$file" in
    server/*|migrations/*|sim.db|logs/*)
      PROTECTED_TOUCH="$PROTECTED_TOUCH $file"
      ;;
  esac
done

if [ -n "$PROTECTED_TOUCH" ]; then
  echo "ERROR: Commit touches protected files:$PROTECTED_TOUCH"
  # Report forbidden file touch to orchestrator
  curl -s -X POST ${ORCHESTRATOR_URL}/api/agent/commit \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer agent-\${AGENT_ID}-hook" \\
    -d "{
      \\"agentId\\": \\"\${AGENT_ID}\\",
      \\"commitHash\\": \\"\${COMMIT_HASH}\\",
      \\"message\\": \\"\${COMMIT_MSG}\\",
      \\"branch\\": \\"\${BRANCH}\\",
      \\"protectedFileTouch\\": true,
      \\"touchedFiles\\": \\"\${PROTECTED_TOUCH}\\"
    }" 2>/dev/null || true
  exit 1
fi

# Report normal commit
curl -s -X POST ${ORCHESTRATOR_URL}/api/agent/commit \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer agent-\${AGENT_ID}-hook" \\
  -d "{
    \\"agentId\\": \\"\${AGENT_ID}\\",
    \\"commitHash\\": \\"\${COMMIT_HASH}\\",
    \\"message\\": \\"\${COMMIT_MSG}\\",
    \\"branch\\": \\"\${BRANCH}\\",
    \\"protectedFileTouch\\": false
  }" 2>/dev/null || true
`

  writeFileSync(join(hooksDir, 'post-commit'), postCommitHook)
  chmodSync(join(hooksDir, 'post-commit'), 0o755)

  // 6. Initial commit
  console.log('  Creating initial commit...')
  run(['git', 'add', '-A'], PRODUCT_REPO)
  run(['git', 'commit', '-m', 'Initial commit: experiment product scaffold'], PRODUCT_REPO)

  console.log(`\n  Product repo initialized at ${PRODUCT_REPO}`)
  console.log('  Ready for Phase 3 (Build).')
}

// Run if invoked directly
if (import.meta.main) {
  await initProductRepo()
}

export { initProductRepo }
