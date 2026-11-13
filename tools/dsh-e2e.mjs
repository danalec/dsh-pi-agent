/**
 * End-to-end check: mount the plugin on a bare DSH context, drive one real Pi
 * turn, then resume the same session from the persistence backend.
 *
 * The context carries only the services the plugin's factory contract needs
 * (sessions, agents, session projections, persistence), so this exercises the
 * same code path the desktop app uses — minus the UI.
 *
 * usage: node tools/dsh-e2e.mjs [cwd]
 */
import { mkdtempSync, readFileSync } from 'node:fs'
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

const out = line => process.stdout.write(line + '\n')
const cwd = process.argv[2] ?? 'C:/Users/danalec'
const store = mkdtempSync(join(tmpdir(), 'dsh-pi-e2e-'))

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(SessionProjectionRegistry)
// The agent scope resolves these through the plugin's dependency API, and the
// frontend's composition reads them from the agent context.
await ctx.plugin(LlmRuntime)
await ctx.plugin(ToolsService)
await ctx.plugin(SystemPrompt)
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root: store })

const fiber = await ctx.plugin({
  name,
  inject,
  Config,
  apply,
}, {
  piPath: 'C:/Users/danalec/.pi/agent/bin/pi.cmd',
  cwd,
  model: 'minimax/MiniMax-M3.1-Flash-Preview',
  pinModel: true,
  debug: true,
})
// A cordis fiber is not thenable, and `fiber.await()` may return before the
// activation settles: wait until the factory slot is actually taken.
const deadline = Date.now() + 10_000
while (Date.now() < deadline) {
  try {
    ctx.agents.requireFactory()
    break
  } catch {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const id = SessionId(`e2e-${Date.now().toString(36)}`)
const handle = await ctx.agents.create({
  sessionId: id,
  agentOptions: { provider: 'minimax', model: 'MiniMax-M3.1-Flash-Preview' },
  // The frontend composes the agent in this window (presets, prompt
  // sections, tools) and reads those services from the agent context: a scope
  // that cannot resolve them fails the whole session creation.
  setup: (agentCtx) => {
    // Resolving the services is the point: the frontend's composition reads
    // them from the agent context.
    void agentCtx.systemPrompt
    void agentCtx.tools
    void agentCtx.llm
  },
})
out(`agent created: ${String(id)}`)
out(`agent status: ${handle.agent.status}`)
out(`model: ${JSON.stringify(handle.agent.model.current())}`)

handle.agent.followup({
  id: SessionId(`msg-${Date.now().toString(36)}`),
  role: 'user',
  content: [{ type: 'text', text: 'Reply with exactly: dsh-pi-e2e-ok' }],
  source: { kind: 'user' },
})

await handle.agent.whenIdle()
out('first turn; session log:')
for (const event of handle.agent.session.snapshotEvents()) {
  const summary = event.type === 'assistant/message'
    ? JSON.stringify(event.data.message.content)
    : event.type === 'user/message'
      ? JSON.stringify(event.data.content)
      : ''
  out(`  ${event.seq} ${event.type} ${summary}`)
}
await handle.dispose()

// Resume: the persisted log must come back, and the Pi child must be handed
// the conversation it already had.
const resumed = await ctx.agents.resume({ resumeSessionId: id })
out(`resumed: ${String(resumed.agent.id)}`)
out('resumed log:')
for (const event of resumed.agent.session.snapshotEvents()) {
  const summary = event.type === 'assistant/message'
    ? JSON.stringify(event.data.message.content)
    : event.type === 'user/message'
      ? JSON.stringify(event.data.content)
      : ''
  out(`  ${event.seq} ${event.type} ${summary}`)
}
const piFile = join(process.env.USERPROFILE ?? '', '.dsh', 'pi-sessions', `${String(id).replace(/[^\w-]/g, '_')}.jsonl`)
out(`pi session file: ${piFile}`)
out(readFileSync(piFile, 'utf8').trim())

resumed.agent.followup({
  id: SessionId(`msg2-${Date.now().toString(36)}`),
  role: 'user',
  content: [{ type: 'text', text: 'Reply with exactly: dsh-pi-e2e-resumed' }],
  source: { kind: 'user' },
})
await resumed.agent.whenIdle()
out('second turn; session log:')
for (const event of resumed.agent.session.snapshotEvents()) {
  const summary = event.type === 'assistant/message'
    ? JSON.stringify(event.data.message.content)
    : event.type === 'user/message'
      ? JSON.stringify(event.data.content)
      : ''
  out(`  ${event.seq} ${event.type} ${summary}`)
}
await resumed.dispose()
await fiber.dispose()
await ctx.fiber.dispose()
