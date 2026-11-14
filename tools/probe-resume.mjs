/**
 * Resume a stored session through the plugin and drive one real turn.
 *
 * A session interrupted by a crash keeps an open turn and an open step. The
 * resume path must close them before the session appends anything else, or
 * the next append is refused with "append seq mismatch" and the session
 * never continues.
 *
 * usage: node tools/probe-resume.mjs <session-id> [cwd]
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

const out = line => process.stdout.write(line + '\n')
const id = process.argv[2]
const cwd = process.argv[3] ?? 'C:/Users/danalec'
if (id === undefined) {
  out('usage: node tools/probe-resume.mjs <session-id> [cwd]')
  process.exit(1)
}

const store = join(homedir(), '.dsh', 'sessions')
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
  cwd,
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

const handle = await ctx.agents.resume({ resumeSessionId: SessionId(id) })
out(`resumed: ${String(handle.agent.id)}`)
out(`status: ${handle.agent.status}`)

const before = handle.agent.session.snapshotEvents()
out(`events carried: ${before.length}`)
const openSteps = before.filter(e => e.type === 'step/start').length - before.filter(e => e.type === 'step/end').length
out(`open steps carried: ${openSteps}`)

handle.agent.followup({
  id: SessionId(`msg-${Date.now().toString(36)}`),
  role: 'user',
  content: [{ type: 'text', text: 'Reply with exactly: RESUME-OK and nothing else.' }],
  source: { kind: 'user' },
})
await handle.agent.whenIdle()

const log = handle.agent.session.snapshotEvents()
const last = log[log.length - 1]
const assistants = log.filter(e => e.type === 'assistant/message')
const answer = assistants.length > 0
  ? (assistants[assistants.length - 1].data.message.content ?? []).map(c => c.text ?? '').join('')
  : ''
out(`last event: ${last.type}`)
out(`answer: ${JSON.stringify(answer.slice(0, 80))}`)
out(`turns in the resumed log: ${log.filter(e => e.type === 'turn/start').length}`)
out(`the session continued: ${answer.includes('RESUME-OK') ? 'yes' : 'NO'}`)

await handle.dispose()
await fiber.dispose()
await ctx.fiber.dispose()
