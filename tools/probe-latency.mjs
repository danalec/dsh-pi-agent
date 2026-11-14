/**
 * Measure how long a resumed session takes to answer.
 *
 * The prompt command of Pi answers as soon as the prompt is accepted, so
 * the time until that answer is the time the child spent restoring its
 * session. A long silence there means the child was blocked — restoring a
 * large session or compacting it.
 *
 * usage: node tools/probe-latency.mjs <session-id> [model]
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
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
import { profileRoutes } from './read-profile-models.mjs'

const out = line => process.stdout.write(line + '\n')
const id = process.argv[2]
const profile = process.env.DSH_PROFILE ?? 'desktop'
const model = process.argv[3] ?? profileRoutes(profile)[0]

const store = mkdtempSync(join(tmpdir(), 'dsh-latency-'))
const live = join(homedir(), '.dsh', 'sessions')
for (const entry of readdirSync(live, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const from = join(live, entry.name, id)
  if (!existsSync(from)) continue
  mkdirSync(join(store, entry.name), { recursive: true })
  cpSync(from, join(store, entry.name, id), { recursive: true })
}

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(LlmRuntime)
await ctx.plugin(ToolsService)
await ctx.plugin(SystemPrompt)
await ctx.plugin(LocalCredentialProvider, { dshHome: join(homedir(), '.dsh') })
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root: store })

const fiber = await ctx.plugin({ name, inject, Config, apply }, {
  piPath: 'C:/Users/danalec/.pi/agent/bin/pi.cmd',
  cwd: 'C:/Users/danalec',
  model,
  pinModel: true,
  debug: true,
})
const deadline = Date.now() + 10_000
while (Date.now() < deadline) {
  try { ctx.agents.requireFactory(); break } catch { await new Promise(r => setTimeout(r, 10)) }
}

const file = join(homedir(), '.dsh', 'pi-sessions', `${id}.jsonl`)
const started = Date.now()
const handle = await ctx.agents.resume({ resumeSessionId: SessionId(id) })
out(`resume: ${Date.now() - started} ms`)
out(`pi session file: ${(statSync(file).size / 1048576).toFixed(2)} MB`)

const sent = Date.now()
handle.agent.followup({
  id: SessionId(`msg-${Date.now().toString(36)}`),
  role: 'user',
  content: [{ type: 'text', text: 'Reply with exactly: LATENCY-OK and nothing else.' }],
  source: { kind: 'user' },
})
await handle.agent.whenIdle()
out(`turn: ${Date.now() - sent} ms`)

const log = handle.agent.session.snapshotEvents()
const turnEnd = log.filter(e => e.type === 'turn/end').pop()
const assistants = log.filter(e => e.type === 'assistant/message')
const text = assistants.length > 0
  ? (assistants[assistants.length - 1].data.message.content ?? []).map(c => c.text ?? '').join('')
  : ''
out(`turn reason: ${turnEnd?.data.reason?.kind}`)
if (turnEnd?.data.reason?.error) out(`error: ${String(turnEnd.data.reason.error.message).slice(0, 200)}`)
out(`answer: ${JSON.stringify(text.slice(0, 60))}`)

await handle.dispose()
await fiber.dispose()
await ctx.fiber.dispose()
