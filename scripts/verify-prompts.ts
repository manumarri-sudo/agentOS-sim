import { buildAgentPrompt } from '../server/agents/prompts'
import { AGENTS } from '../server/agents/registry'

const mandatoryPatterns = [
  { name: 'name/team/role', pattern: /team|role/i },
  { name: 'shared objective', pattern: /first dollar|\$200|budget/i },
  { name: 'log actions', pattern: /log|action/i },
  { name: 'send messages', pattern: /message/i },
  { name: 'blocked reporting', pattern: /block/i },
  { name: 'citation protocol', pattern: /cit/i },
]

let allPass = true
for (const agent of AGENTS) {
  const prompt = buildAgentPrompt(agent)
  for (const { name, pattern } of mandatoryPatterns) {
    if (!pattern.test(prompt)) {
      console.error(`MISSING: ${agent.personality_name} - ${name}`)
      allPass = false
    }
  }
}
if (allPass) console.log('✅ All 18 prompts contain all mandatory fields')

// Verify no forbidden patterns
const forbidden = [
  { name: 'hardcoded schedule', pattern: /on day \d/i },
  { name: 'forced collaboration', pattern: /collaborate with|work cross-functionally/i },
  { name: 'calendar schedule', pattern: /weekly schedule|every monday/i },
]

let noForbidden = true
for (const agent of AGENTS) {
  const prompt = buildAgentPrompt(agent)
  for (const { name, pattern } of forbidden) {
    if (pattern.test(prompt)) {
      console.error(`FORBIDDEN: ${agent.personality_name} - ${name}`)
      noForbidden = false
    }
  }
}
if (noForbidden) console.log('✅ No forbidden patterns found in any prompt')
