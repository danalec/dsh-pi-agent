/**
 * Check the credential plumbing: does the Pi child receive the keys the host
 * holds?
 *
 * The host keeps its keys in the credential store; the Pi child is another
 * process and does not inherit that store. This mounts the real credential
 * service, drives one turn on a provider the child only knows through the
 * resolved key, and reports what the child answered.
 *
 * usage: node tools/probe-credentials.mjs [provider/model]
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolsService from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { apply as applyPersistence, Config as PersistenceConfig, name as persistenceName } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply, Config, inject, name } from '../dist/index.js'

const out = line => process.stdout.write(line + '\n')
const route = process.argv[2] ?? 'zai/glm-5.3-flash'
const [provider, ...rest] = route.split('/')
const model = rest.join('/')

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(LlmRuntime)
await ctx.plugin(ToolsService)
await ctx.plugin(SystemPrompt)
await ctx.plugin(LocalCredentialProvider, { dshHome: 'C:/Users/danalec/.dsh' })
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root: 'C:/Users/danalec/.dsh/sessions' })

const fiber = await ctx.plugin({ name, inject, Config, apply }, {
  piPath: 'C:/Users/danalec/.pi/agent/bin/pi.cmd',
  cwd: 'C:/Users/danalec',
  model: route,
  pinModel: true,
  debug: true,
})
const deadline = Date.now() + 10_000
while (Date.now() < deadline) {
  try {
    ctx.agents.requireFactory()
    break
  } catch {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const credentials = ctx.get('credentials')
out(`the host has a credential service: ${credentials !== undefined}`)
if (credentials !== undefined) {
  for (const ref of ['ZAI_API_KEY', 'BAILIAN_TOKEN_PLAN_API_KEY', 'TENCENT_API_KEY', 'MINIMAX_API_KEY']) {
    const hit = await credentials.resolve(ref)
    out(`  ${ref}: ${hit === undefined ? 'absent' : 'present'}`)
  }
}

const id = SessionId(`cred-${Date.now().toString(36)}`)
const handle = await ctx.agents.create({
  sessionId: id,
  agentOptions: { provider, model },
  setup: (agentCtx) => {
    void agentCtx.systemPrompt
    void agentCtx.tools
    void agentCtx.llm
  },
})
handle.agent.followup({
  id: SessionId(`msg-${Date.now().toString(36)}`),
  role: 'user',
  content: [{ type: 'text', text: 'Reply with exactly: CRED-OK and nothing else.' }],
  source: { kind: 'user' },
})
await handle.agent.whenIdle()

const log = handle.agent.session.snapshotEvents()
const turnEnd = log.filter(e => e.type === 'turn/end').pop()
const assistants = log.filter(e => e.type === 'assistant/message')
const answer = assistants.length > 0
  ? (assistants[assistants.length - 1].data.message.content ?? []).map(c => c.text ?? '').join('')
  : ''
out(`route: ${route}`)
out(`turn reason: ${turnEnd?.data.reason?.kind}`)
if (turnEnd?.data.reason?.error) out(`error: ${String(turnEnd.data.reason.error.message).slice(0, 200)}`)
out(`answer: ${JSON.stringify(answer.slice(0, 60))}`)
out(`the credential reached the child: ${answer.includes('CRED-OK') ? 'yes' : 'NO'}`)

await handle.dispose()
await fiber.dispose()
await ctx.fiber.dispose()
