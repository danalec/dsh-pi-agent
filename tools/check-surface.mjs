/**
 * Check whether the stored assistant messages reach the session surface — the
 * ordered, model-visible view the frontend renders.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { apply as applyPersistence, Config as PersistenceConfig, name as persistenceName } from '@deepseek-ai/dsh-session-persistence-jsonl'

const root = join(homedir(), '.dsh', 'sessions')
const id = process.argv[2] ?? 'session-1e6ba3e9-00ef-4090-a6e3-416a333c3b5f'

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root })
const persistence = ctx.get('sessionPersistence')

const handle = await persistence.open(SessionId(id), 'read')
const read = await handle.read(0, undefined)
await handle.close()
console.log('stored events:', read.events.length)

const session = ctx.sessions.prepare(SessionId(id), { seed: read.events })
const detach = ctx.sessions.enter(session)
ctx.sessions.announce(session)

const assistant = read.events.filter(e => e.type === 'assistant/message')
const users = read.events.filter(e => e.type === 'user/message')
console.log('stored: user/message =', users.length, ', assistant/message =', assistant.length)

const surface = session.surface
const nodes = surface.nodes ?? []
console.log('surface nodes:', nodes.length)
const bySeq = new Map(read.events.map(e => [e.seq, e]))
const roles = {}
for (const seq of nodes) {
  const event = bySeq.get(seq)
  const role = event?.data?.message?.role ?? event?.type ?? '?'
  roles[role] = (roles[role] ?? 0) + 1
}
console.log('surface roles:', JSON.stringify(roles))
for (const seq of nodes.slice(-6)) {
  const event = bySeq.get(seq)
  console.log('  ', seq, event?.type, JSON.stringify(event?.data).slice(0, 140))
}

detach()
await ctx.fiber.dispose()
