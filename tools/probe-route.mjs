/**
 * Drive one real Pi turn on a chosen model route.
 *
 * The DSH profile configures several providers; this checks that the loop
 * runs on the route a session asks for, not only on the pinned default.
 *
 * usage: node tools/probe-route.mjs <provider/model> [model]
 */
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { loadDshCredentials } from './dsh-credentials.mjs'
import { profileRoutes } from './read-profile-models.mjs'

const out = line => process.stdout.write(line + '\n')
const profile = process.env.DSH_PROFILE ?? 'desktop'
const [provider, ...rest] = (process.argv[2] ?? profileRoutes(profile)[0]).split('/')
const model = rest.join('/')
const store = mkdtempSync(join(tmpdir(), 'dsh-pi-route-'))
loadDshCredentials()

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(LlmRuntime)
await ctx.plugin(ToolsService)
await ctx.plugin(SystemPrompt)
// The Pi child is another process: the keys it needs come from the
// host's credential service, which the driver resolves and hands over.
await ctx.plugin(LocalCredentialProvider, { dshHome: join(homedir(), '.dsh') })
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root: store })

const fiber = await ctx.plugin({ name, inject, Config, apply }, {
  piPath: 'C:/Users/danalec/.pi/agent/bin/pi.cmd',
  cwd: 'C:/Users/danalec',
  // No pinned model: the session's own route is the one that runs.
  pinModel: false,
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

const id = SessionId(`route-${Date.now().toString(36)}`)
const handle = await ctx.agents.create({
  sessionId: id,
  agentOptions: { provider, model },
  setup: (agentCtx) => {
    void agentCtx.systemPrompt
    void agentCtx.tools
    void agentCtx.llm
  },
})
out(`route: ${provider}/${model}`)

handle.agent.followup({
  id: SessionId(`msg-${Date.now().toString(36)}`),
  role: 'user',
  content: [{ type: 'text', text: 'Reply with exactly: ROUTE-OK and nothing else.' }],
  source: { kind: 'user' },
})
await handle.agent.whenIdle()

const log = handle.agent.session.snapshotEvents()
const turnEnd = log.filter(e => e.type === 'turn/end').pop()
const assistants = log.filter(e => e.type === 'assistant/message')
const answer = assistants.length > 0
  ? (assistants[assistants.length - 1].data.message.content ?? []).map(c => c.text ?? '').join('')
  : ''
out(`turn reason: ${turnEnd?.data.reason?.kind}`)
if (turnEnd?.data.reason?.error) out(`error: ${String(turnEnd.data.reason.error.message).slice(0, 200)}`)
out(`answer: ${JSON.stringify(answer.slice(0, 60))}`)
out(`the route works: ${answer.includes('ROUTE-OK') ? 'yes' : 'NO'}`)

await handle.dispose()
await fiber.dispose()
await ctx.fiber.dispose()
