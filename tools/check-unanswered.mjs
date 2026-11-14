/**
 * Find sessions whose LAST prompt was never answered.
 *
 * A prompt the user sent and that never produced an assistant message is
 * the "my prompt stopped" symptom: the message may still be queued in the
 * session's inbox, or the turn may have died with it.
 *
 * usage: node tools/check-unanswered.mjs [days]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const root = join(homedir(), '.dsh', 'sessions')
const days = Number(process.argv[2] ?? 3)
const since = Date.now() - days * 24 * 60 * 60 * 1000

function logs(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) logs(path, out)
    else if (entry.name === 'session.v4.jsonl.zstd') {
      const mtime = statSync(path).mtimeMs
      if (mtime >= since) out.push({ file: path, mtime })
    }
  }
  return out
}

const findings = []
for (const { file, mtime } of logs(root)) {
  let events
  try {
    events = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch {
    continue
  }
  const id = file.split(/[\\/]/).slice(-2, -1)[0]
  let lastUserSeq = -1
  let lastUserText = ''
  let lastAssistantSeq = -1
  let pending = { 'next-turn': 0, 'next-step': 0 }
  let openTurn = false
  for (const event of events) {
    if (event.type === 'user/message') {
      lastUserSeq = event.seq
      lastUserText = (event.data.content ?? []).map(c => c.text ?? `[${c.type}]`).join('')
    }
    if (event.type === 'assistant/message') lastAssistantSeq = event.seq
    if (event.type === 'turn/start') openTurn = true
    if (event.type === 'turn/end') openTurn = false
    if (event.type === 'agent/inbox/spliced') {
      const data = event.data ?? {}
      const list = pending[data.target] ?? 0
      pending[data.target] = list - (data.removedCount ?? 0) + (data.inserted ?? []).length
    }
  }
  const unanswered = lastUserSeq > lastAssistantSeq
  const queued = pending['next-turn'] + pending['next-step']
  if (unanswered || queued > 0 || openTurn) {
    findings.push({
      id,
      mtime: new Date(mtime).toISOString().slice(5, 19).replace('T', ' '),
      unanswered,
      queued,
      openTurn,
      lastUserSeq,
      lastAssistantSeq,
      text: lastUserText.slice(0, 60),
    })
  }
}

findings.sort((a, b) => b.mtime.localeCompare(a.mtime))
console.log(`sessions touched in the last ${days}d with an open turn, a queued message or an unanswered prompt: ${findings.length}`)
console.log('mtime              unanswered queued openTurn  lastUser/lastAssistant  session')
for (const f of findings) {
  console.log(
    f.mtime,
    String(f.unanswered).padStart(10),
    String(f.queued).padStart(6),
    String(f.openTurn).padStart(8),
    ` ${String(f.lastUserSeq)}/${String(f.lastAssistantSeq)}`.padStart(22),
    ' ' + f.id,
    JSON.stringify(f.text),
  )
}
