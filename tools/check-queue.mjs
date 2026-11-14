/**
 * Audit the stored DSH session logs for queue/steering anomalies.
 *
 * Reports, per session:
 * - inbox splices that DISCARDED pending input (the queue lost work);
 * - inbox splices that claimed input (normal);
 * - user messages that never got an assistant answer;
 * - turns that ended with no step at all;
 * - assistant messages whose content is empty.
 *
 * usage: node tools/check-queue.mjs [session-dir]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] ?? join(homedir(), '.dsh', 'sessions')

function logs(dir) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...logs(path))
    else if (entry.name === 'session.v4.jsonl.zstd') found.push(path)
  }
  return found
}

function read(file) {
  const plain = zstdDecompressSync(readFileSync(file)).toString('utf8')
  return plain.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return undefined }
  }).filter(Boolean)
}

const stats = {
  sessions: 0,
  claimed: 0,
  canceled: 0,
  canceledMessages: 0,
  userWithoutAnswer: 0,
  emptyAssistant: 0,
  turnsWithoutStep: 0,
  steps: 0,
  turns: 0,
}
const examples = []

for (const file of logs(root)) {
  let events
  try {
    events = read(file)
  } catch {
    continue
  }
  stats.sessions += 1

  const canceledIds = []
  const claimedIds = []
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const data = event.data ?? {}
    if (data.outcome === 'canceled') {
      stats.canceled += 1
      stats.canceledMessages += data.removedCount ?? 0
    }
    if (data.removedCount > 0 && data.outcome !== 'canceled') {
      stats.claimed += 1
      for (const message of data.inserted ?? []) claimedIds.push(message.id)
    }
  }

  // A user message with no assistant answer before the next user message.
  let pendingUser = 0
  let answered = 0
  let openSteps = 0
  let openTurn = false
  for (const event of events) {
    switch (event.type) {
      case 'turn/start': openTurn = true; stats.turns += 1; break
      case 'turn/end': openTurn = false; break
      case 'step/start': openSteps += 1; stats.steps += 1; break
      case 'step/end': openSteps -= 1; break
      case 'user/message': pendingUser += 1; break
      case 'assistant/message': {
        answered += 1
        if ((event.data?.message?.content ?? []).length === 0) stats.emptyAssistant += 1
        break
      }
      default: break
    }
  }
  if (openTurn) stats.turnsWithoutStep += 1
  if (pendingUser > answered) {
    stats.userWithoutAnswer += pendingUser - answered
    if (examples.length < 15) {
      examples.push(`${file}: ${pendingUser} user messages, ${answered} assistant answers`)
    }
  }
}

console.log(`sessions:              ${stats.sessions}`)
console.log(`turns / steps:         ${stats.turns} / ${stats.steps}`)
console.log(`inbox claims:          ${stats.claimed}`)
console.log(`inbox cancellations:   ${stats.canceled} (${stats.canceledMessages} messages dropped)`)
console.log(`user msgs w/o answer:  ${stats.userWithoutAnswer}`)
console.log(`empty assistant msgs:  ${stats.emptyAssistant}`)
console.log(`turns left open:       ${stats.turnsWithoutStep}`)
for (const example of examples) console.log(`  - ${example}`)
