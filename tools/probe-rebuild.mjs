/**
 * Rebuild the Pi session file of a stored session through the plugin and
 * report what the child would receive.
 *
 * usage: node tools/probe-rebuild.mjs <session-id>
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolsService from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply as applyPersistence, Config as PersistenceConfig, name as persistenceName } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply, Config, inject, name } from '../dist/index.js'

const out = line => process.stdout.write(line + '\n')
const id = process.argv[2]
if (id === undefined) {
  out('usage: node tools/probe-rebuild.mjs <session-id>')
  process.exit(1)
}

const store = mkdtempSync(join(tmpdir(), 'dsh-rebuild-'))
// The live session owns its write handle in the app, so the check runs
// against a copy of its stored log.
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

const file = join(homedir(), '.dsh', 'pi-sessions', `${id}.jsonl`)
const before = statSync(file).size
out(`pi session file before: ${(before / 1048576).toFixed(1)} MB`)

const handle = await ctx.agents.resume({ resumeSessionId: SessionId(id) })
const after = statSync(file).size
out(`pi session file after:  ${(after / 1048576).toFixed(1)} MB`)
out(`entries: ${readFileSync(file, 'utf8').split('\n').filter(Boolean).length}`)

handle.agent.followup({
  id: SessionId(`msg-${Date.now().toString(36)}`),
  role: 'user',
  content: [{ type: 'text', text: 'Reply with exactly: REBUILD-OK and nothing else.' }],
  source: { kind: 'user' },
})
await handle.agent.whenIdle()

const log = handle.agent.session.snapshotEvents()
const assistants = log.filter(e => e.type === 'assistant/message')
const last = assistants[assistants.length - 1]
const text = (last?.data.message?.content ?? []).map(c => c.text ?? '').join('')
const turnEnd = log.filter(e => e.type === 'turn/end').pop()
out(`turn reason: ${turnEnd?.data.reason?.kind}`)
out(`answer: ${JSON.stringify(text.slice(0, 80))}`)
out(`the session continued: ${text.includes('REBUILD-OK') ? 'yes' : 'NO'}`)

await handle.dispose()
await fiber.dispose()
await ctx.fiber.dispose()
