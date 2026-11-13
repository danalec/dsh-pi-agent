/**
 * Reproduce the projection failure the desktop app reports for a session.
 *
 * The app hydrates the session projections when it observes a stored
 * session; this tool does the same, so the failing event is visible.
 *
 * usage: node tools/project-session.mjs <session-id>
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { apply as applyPersistence, Config as PersistenceConfig, name as persistenceName } from '@deepseek-ai/dsh-session-persistence-jsonl'

const electronApp = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
if (!process.versions.electron && existsSync(electronApp) && !process.env.DSH_PROJECT_NODE_FALLBACK) {
  const result = spawnSync(electronApp, [process.argv[1], ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  })
  process.exit(result.status ?? 0)
}

const root = join(homedir(), '.dsh', 'sessions')
const id = process.argv[2]
if (id === undefined) {
  console.error('usage: node tools/project-session.mjs <session-id>')
  process.exit(1)
}

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root })

const asarModules = 'C:/Users/danalec/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai'
const projectionFiles = [
  'dsh-action-cards/lib/types/projection.js',
  'dsh-agent/lib/types/projection.js',
  'dsh-agent-team/lib/types/projection.js',
  'dsh-api-session-controller/lib/types/continuation.js',
  'dsh-attachment/lib/types/request-projection.js',
  'dsh-compaction-image-offload/lib/types/projection.js',
  'dsh-experimental-worktree/lib/types/projection.js',
  'dsh-session-reference/lib/types/projection.js',
  'dsh-session-stats/lib/types/projection.js',
  'dsh-session-turn-outline/lib/types/projection.js',
  'dsh-subagent/lib/types/projection.js',
  'dsh-token-meter/lib/types/breakdown-projection.js',
  'dsh-token-meter/lib/types/measurement-projection.js',
  'dsh-token-meter/lib/types/projection.js',
  'dsh-token-meter/lib/types/surface-projection.js',
  'dsh-token-meter/lib/types/usage-projection.js',
  'dsh-user-questions/lib/types/projection.js',
]

for (const rel of projectionFiles) {
  const full = join(asarModules, rel)
  try {
    const mod = await import(pathToFileURL(full).href)
    for (const v of Object.values(mod)) {
      if (v && typeof v === 'object' && typeof v.apply === 'function' && typeof v.key === 'string') {
        ctx.sessionProjections.register(v)
      }
    }
  } catch {}
}

const persistence = ctx.get('sessionPersistence')

const handle = await persistence.open(SessionId(id), 'read')
const read = await handle.read(SessionLogOffset(0), undefined)
await handle.close()
console.log('stored events:', read.events.length)

const session = ctx.sessions.prepare(SessionId(id), {
  seed: read.events,
  meta: structuredClone(handle.header),
  inheritedEventCount: handle.inheritedEventCount,
  eventState: read.eventState,
})
const detach = ctx.sessions.enter(session)
ctx.sessions.announce(session)

const registry = ctx.get('sessionProjections')
try {
  const projections = registry.hydrate(session, {}, read.events, SessionLogOffset(0))
  console.log('projected keys:', Object.keys(projections?.values ?? projections ?? {}).join(', '))
} catch (error) {
  console.log('projection failed:', String(error))
  console.log('cause:', String(error?.cause ?? ''))
}
detach()
await ctx.fiber.dispose()
