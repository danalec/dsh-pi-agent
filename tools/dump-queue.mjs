/**
 * Dump the queue/steering timeline of one stored session.
 *
 * Shows every inbox splice (what was queued, claimed, or discarded), every
 * turn/step boundary, and every user message, in log order.
 *
 * usage: node tools/dump-queue.mjs <session-id>
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const id = process.argv[2]
if (id === undefined) {
  console.error('usage: node tools/dump-queue.mjs <session-id>')
  process.exit(1)
}

const root = join(homedir(), '.dsh', 'sessions')

function find(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (!entry.isDirectory()) continue
    if (entry.name === id) {
      const file = join(path, 'session.v4.jsonl.zstd')
      try {
        readFileSync(file)
        return file
      } catch {}
    }
    const found = find(path)
    if (found !== undefined) return found
  }
  return undefined
}

const file = find(root)
if (file === undefined) {
  console.error('session log not found:', id)
  process.exit(1)
}

const plain = zstdDecompressSync(readFileSync(file)).toString('utf8')
const events = plain.split('\n').filter(Boolean).map(line => JSON.parse(line))

console.log(`log: ${file}`)
console.log(`events: ${events.length}`)
console.log('')

for (const event of events) {
  const data = event.data ?? {}
  switch (event.type) {
    case 'agent/inbox/spliced': {
      const target = data.target ?? '?'
      const removed = data.removedCount ?? 0
      const inserted = (data.inserted ?? []).map(m => `${m.id}:${JSON.stringify(m.content?.map?.(c => c.text ?? c.type) ?? m.content)}`)
      console.log(`[${String(event.seq).padStart(5)}] INBOX  ${target}  removed=${removed} outcome=${data.outcome ?? '-'}  inserted=[${inserted.join(' | ')}]`)
      break
    }
    case 'turn/start':
      console.log(`[${String(event.seq).padStart(5)}] TURN   start ${data.turn}`)
      break
    case 'turn/end':
      console.log(`[${String(event.seq).padStart(5)}] TURN   end   ${data.turn} reason=${data.reason?.kind}${data.reason?.reason ? `(${data.reason.reason.kind})` : ''}`)
      break
    case 'step/start':
      console.log(`[${String(event.seq).padStart(5)}] STEP   start ${data.turn}.${data.step}`)
      break
    case 'step/end':
      console.log(`[${String(event.seq).padStart(5)}] STEP   end   ${data.turn}.${data.step}`)
      break
    case 'user/message': {
      const text = (data.content ?? []).map(c => c.text ?? `[${c.type}]`).join('')
      console.log(`[${String(event.seq).padStart(5)}] USER   ${data.id}  ${JSON.stringify(text.slice(0, 120))}`)
      break
    }
    case 'assistant/message': {
      const text = (data.message?.content ?? []).map(c => c.text ?? `[${c.type}]`).join('')
      console.log(`[${String(event.seq).padStart(5)}] ASSIST ${data.turn}.${data.step}  ${JSON.stringify(text.slice(0, 120))}`)
      break
    }
    default:
      break
  }
}
