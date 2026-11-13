/**
 * Load every stored session with the real DSH persistence backend and report
 * the ones it refuses.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyPersistence, Config as PersistenceConfig, name as persistenceName } from '@deepseek-ai/dsh-session-persistence-jsonl'

const root = process.argv[2] ?? process.env.DSH_SESSIONS_ROOT ?? join(homedir(), '.dsh', 'sessions')
const ctx = new Context()
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root })
const persistence = ctx.get('sessionPersistence')

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('session-')) out.push(full)
      else walk(full, out)
    }
  }
  return out
}

const dirs = walk(root)
console.log('sessions:', dirs.length)

const failures = []
for (const dir of dirs) {
  const id = dir.split(/[\\/]/).pop()
  try {
    const handle = await persistence.open(id, 'read')
    const read = await handle.read(0, undefined)
    await handle.close()
    if (read.events.length === 0) failures.push({ id, why: 'empty log' })
  } catch (error) {
    failures.push({ id, why: String(error).slice(0, 220) })
  }
}

console.log('unreadable:', failures.length)
for (const failure of failures) console.log(' -', failure.id, '->', failure.why)
await ctx.fiber.dispose()
