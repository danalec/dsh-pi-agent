/**
 * Check the newest stored sessions for stuck turns and unanswered prompts.
 *
 * A turn that opened and never closed is a run that will never finish; a
 * user message with no assistant answer is a prompt that was dropped.
 *
 * usage: node tools/check-stuck.mjs [count]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const root = join(homedir(), '.dsh', 'sessions')
const limit = Number(process.argv[2] ?? 8)

/** Every stored session log, newest first. */
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
      out.push({ file: path, mtime: statSync(path).mtimeMs })
    }
  }
  return out
}

const rows = []
for (const { file, mtime } of logs(root).sort((a, b) => b.mtime - a.mtime).slice(0, limit)) {
  let events
  try {
    events = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch {
    continue
  }
  const id = file.split(/[\\/]/).slice(-2, -1)[0]
  let openTurn = undefined
  let openStep = undefined
  let lastEvent = ''
  const turns = []
  for (const event of events) {
    lastEvent = event.type
    if (event.type === 'turn/start') openTurn = { turn: event.data.turn, seq: event.seq }
    if (event.type === 'turn/end') { turns.push({ turn: event.data.turn, reason: event.data.reason?.kind }); openTurn = undefined }
    if (event.type === 'step/start') openStep = { step: event.data.step, seq: event.seq }
    if (event.type === 'step/end') openStep = undefined
  }
  const users = events.filter(e => e.type === 'user/message')
  const assistants = events.filter(e => e.type === 'assistant/message')
  const lastUser = users[users.length - 1]
  const lastAssistant = assistants[assistants.length - 1]
  const answered = lastAssistant !== undefined && lastUser !== undefined && lastAssistant.seq > lastUser.seq
  rows.push({
    id,
    mtime: new Date(mtime).toISOString().slice(11, 19),
    events: events.length,
    turns: turns.length,
    lastTurnReason: turns[turns.length - 1]?.reason ?? '-',
    openTurn: openTurn === undefined ? '-' : `turn ${openTurn.turn} @seq ${openTurn.seq}`,
    openStep: openStep === undefined ? '-' : `step ${openStep.step} @seq ${openStep.seq}`,
    users: users.length,
    assistants: assistants.length,
    lastPromptAnswered: answered ? 'yes' : 'NO',
    lastEvent,
  })
}

console.log('mtime    events turns lastReason openTurn openStep  users asst answered lastEvent')
for (const row of rows) {
  console.log(
    row.mtime,
    String(row.events).padStart(6),
    String(row.turns).padStart(5),
    String(row.lastTurnReason).padStart(9),
    String(row.openTurn).padStart(16),
    String(row.openStep).padStart(15),
    String(row.users).padStart(5),
    String(row.assistants).padStart(4),
    String(row.lastPromptAnswered).padStart(8),
    ' ' + row.lastEvent,
  )
}
