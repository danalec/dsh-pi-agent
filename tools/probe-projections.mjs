/**
 * Probe: which session projections does the Pi loop register?
 *
 * `@deepseek-ai/dsh-agent-loop` — the factory the Pi loop replaces — mounts
 * the `modelSelection` AND the `inbox` projection. The `inbox` projection is
 * what the frontend reads to show the pending queue and the steering items.
 *
 * usage: node tools/probe-projections.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolsService from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, inject, name } from '../dist/index.js'

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

const fiber = await ctx.plugin({ name, inject, Config, apply }, {
  piPath: 'C:/Users/danalec/.pi/agent/bin/pi.cmd',
  cwd: 'C:/Users/danalec',
  model: 'minimax/MiniMax-M3.1-Flash-Preview',
  pinModel: true,
})

// The registration is asynchronous; give it a moment to settle.
await new Promise(resolve => setTimeout(resolve, 500))

const registry = ctx.get('sessionProjections')
const keys = [...registry.summaryKeys()].sort()
console.log('registered projections:', JSON.stringify(keys))
console.log("has 'modelSelection':", keys.includes('modelSelection'))
console.log("has 'inbox'        :", keys.includes('inbox'))

await fiber.dispose()
await ctx.fiber.dispose()
