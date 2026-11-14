/**
 * Check the stored DSH session logs for the tool-lifecycle rule the
 * persistence backend enforces on write:
 *
 *   every `tool/call` must match a tool-call block advertised by an
 *   `assistant/message` — same id, same name, same arguments string.
 *
 * A mismatch makes the backend refuse the write ("tool/call … does not
 * match one advertised tool call"), so the log stops growing.
 *
 * usage: node tools/check-tool-lifecycle.mjs [session-dir]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const root = process.argv[2] ?? join(homedir(), '.dsh', 'sessions')

/** Every stored session log under the root. */
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

/** Parse one stored log into its events. */
function read(file) {
  const plain = zstdDecompressSync(readFileSync(file)).toString('utf8')
  return plain.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return undefined }
  }).filter(Boolean)
}

let checked = 0
let calls = 0
const problems = []

for (const file of logs(root)) {
  let events
  try {
    events = read(file)
  } catch {
    continue
  }
  const advertised = new Map()
  for (const event of events) {
    if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block.type !== 'tool-call') continue
        advertised.set(block.id, { name: block.name, arguments: block.arguments })
      }
      continue
    }
    if (event.type !== 'tool/call') continue
    calls += 1
    const callId = event.data?.callId
    const pending = advertised.get(callId)
    if (pending === undefined) {
      problems.push(`${file}: tool/call ${callId} was never advertised`)
      continue
    }
    if (pending.name !== event.data?.name) {
      problems.push(`${file}: tool/call ${callId} name "${event.data?.name}" != advertised "${pending.name}"`)
    }
    if (pending.arguments !== event.data?.arguments) {
      problems.push(`${file}: tool/call ${callId} arguments differ from the advertised ones`)
    }
  }
  checked += 1
}

console.log(`logs checked: ${checked}`)
console.log(`tool calls:   ${calls}`)
if (problems.length === 0) {
  console.log('OK: every tool/call matches one advertised tool call')
} else {
  console.log(`PROBLEMS (${problems.length}):`)
  for (const problem of problems.slice(0, 20)) console.log(`  ${problem}`)
  process.exitCode = 1
}
