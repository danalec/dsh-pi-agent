/**
 * Live steering probe: drive a real Pi turn and check what the loop did with
 * the message queued for the next step.
 *
 * Two deliveries are exercised:
 *
 * - `steer`: the user steers the running loop. The message must reach the
 *   model inside the same turn, and be recorded on the durable surface once.
 * - `inject`: model-facing context queued for the next pre-step. It must also
 *   reach the model — a batch Pi never injects is recovered and delivered as
 *   a step of its own instead of being dropped.
 *
 * usage: node tools/probe-steering.mjs [steer|inject]
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolsService from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply as applyPersistence, Config as PersistenceConfig, name as persistenceName } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply, Config, inject, name } from '../dist/index.js'

const mode = process.argv[2] ?? 'steer'
const out = line => process.stdout.write(line + '\n')
const store = mkdtempSync(join(tmpdir(), 'dsh-pi-steer-'))

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(LlmRuntime)
await ctx.plugin(ToolsService)
await ctx.plugin(SystemPrompt)
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root: store })

const fiber = await ctx.plugin({ name, inject, Config, apply }, {
  piPath: 'C:/Users/danalec/.pi/agent/bin/pi.cmd',
  cwd: 'C:/Users/danalec',
  model: 'minimax/MiniMax-M3.1-Flash-Preview',
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

const id = SessionId(`steer-${Date.now().toString(36)}`)
const handle = await ctx.agents.create({
  sessionId: id,
  agentOptions: { provider: 'minimax', model: 'MiniMax-M3.1-Flash-Preview' },
  setup: (agentCtx) => {
    void agentCtx.systemPrompt
    void agentCtx.tools
    void agentCtx.llm
  },
})

const chunks = []
ctx.on('agent/assistant-stream', ({ frame }) => {
  if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') chunks.push(frame.chunk.text)
})

const userMessage = (text) => ({
  id: SessionId(`msg-${Math.random().toString(36).slice(2)}`),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const marker = mode === 'steer' ? 'STEER-OK' : 'NEXTSTEP-OK'
const task = mode === 'steer'
  ? 'Count slowly from 1 to 5, one number per line.'
  : 'Write a 30 line poem about the sea, one line per line.'
const instruction = mode === 'steer'
  ? `STOP. Reply with exactly: ${marker} and nothing else.`
  : `NOW reply with exactly: ${marker} and nothing else.`

handle.agent.followup(userMessage(task))

const waitFor = async (predicate, timeoutMs, label) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  out(`TIMEOUT: ${label}`)
  return false
}

await waitFor(() => chunks.length > 0, 120_000, 'the first streamed chunk')
out(`--- first chunk seen (${JSON.stringify(chunks.join('').slice(0, 40))}); ${mode}ing mid-run ---`)
out(`    agent status at that moment: ${handle.agent.status}`)

if (mode === 'steer') handle.agent.steer(userMessage(instruction))
else handle.agent.inject(userMessage(instruction))

await handle.agent.whenIdle()
out('--- the agent went idle ---')

const log = handle.agent.session.snapshotEvents()
const users = log.filter(e => e.type === 'user/message')
const assistants = log.filter(e => e.type === 'assistant/message')

out('')
out('=== DSH session log ===')
for (const event of log) {
  if (event.type === 'user/message') {
    const text = (event.data.content ?? []).map(c => c.text ?? `[${c.type}]`).join('')
    out(`  [${event.seq}] USER   ${JSON.stringify(text.slice(0, 80))}`)
  } else if (event.type === 'assistant/message') {
    const text = (event.data.message?.content ?? []).map(c => c.text ?? `[${c.type}]`).join('')
    out(`  [${event.seq}] ASSIST ${JSON.stringify(text.slice(0, 80))}`)
  } else if (event.type === 'agent/inbox/spliced') {
    out(`  [${event.seq}] INBOX  ${event.data.target} removed=${event.data.removedCount ?? 0} outcome=${event.data.outcome ?? '-'} inserted=${(event.data.inserted ?? []).length}`)
  } else if (event.type === 'turn/start' || event.type === 'turn/end') {
    out(`  [${event.seq}] ${event.type}`)
  } else if (event.type === 'step/start' || event.type === 'step/end') {
    out(`  [${event.seq}] ${event.type} ${event.data.turn}.${event.data.step}`)
  }
}

const userText = users.map(e => (e.data.content ?? []).map(c => c.text ?? '').join('')).join(' | ')
const answer = assistants.map(e => (e.data.message?.content ?? []).map(c => c.text ?? '').join('')).join(' | ')
out('')
out(`user messages:      ${users.length}`)
out(`assistant messages: ${assistants.length}`)
out(`recorded in the log: ${userText.includes(marker) ? 'yes' : 'NO'}`)
out(`answered by the model: ${answer.includes(marker) ? 'yes' : 'NO  <-- the message was STRANDED'}`)

await handle.dispose()
await fiber.dispose()
await ctx.fiber.dispose()
