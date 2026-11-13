/**
 * End-to-end check: mount the plugin on a bare DSH context and drive one
 * real Pi turn through it.
 *
 * The context carries only the services the plugin's factory contract needs
 * (sessions, agents, session projections), so this exercises the same code
 * path the desktop app uses — minus the UI.
 *
 * usage: node tools/dsh-e2e.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, Config, inject, name } from '../dist/index.js'

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(SessionProjectionRegistry)

const fiber = await ctx.plugin({
  name,
  inject,
  Config,
  apply,
}, {
  piPath: 'C:/Users/danalec/.pi/agent/bin/pi.cmd',
  cwd: process.argv[2] ?? 'C:/Users/danalec',
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
process.stdout.write(`fiber state: ${String(fiber.state)}\n`)
const id = SessionId(`e2e-${Date.now().toString(36)}`)
const handle = await ctx.agents.create({
  sessionId: id,
  agentOptions: { provider: 'minimax', model: 'MiniMax-M3.1-Flash-Preview' },
})
console.log('agent created:', String(id))
console.log('agent status:', handle.agent.status)
console.log('model:', JSON.stringify(handle.agent.model.current()))

handle.agent.followup({
  id: SessionId(`msg-${Date.now().toString(36)}`),
  role: 'user',
  content: [{ type: 'text', text: 'Reply with exactly: dsh-pi-e2e-ok' }],
  source: { kind: 'user' },
})

await handle.agent.whenIdle()
console.log('agent idle; session log:')
for (const event of handle.agent.session.snapshotEvents()) {
  const summary = event.type === 'assistant/message'
    ? JSON.stringify(event.data.message.content)
    : event.type === 'user/message'
      ? JSON.stringify(event.data.content)
      : ''
  console.log(`  ${event.seq} ${event.type} ${summary}`)
}

await handle.dispose()
await fiber.dispose()
await ctx.fiber.dispose()
