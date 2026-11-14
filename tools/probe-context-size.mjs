/**
 * Experiment: what makes Pi's provider reject the request?
 *
 * Takes the Pi session file of a broken session, produces variants of it and
 * asks Pi to answer a trivial prompt with each one. The variant that works
 * names the cause.
 *
 * usage: node tools/probe-context-size.mjs <pi-session-file>
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnPi } from '../dist/spawn.js'
import { createInterface } from 'node:readline'

const source = process.argv[2]
if (source === undefined) {
  console.error('usage: node tools/probe-context-size.mjs <pi-session-file>')
  process.exit(1)
}

const raw = readFileSync(source, 'utf8')
const lines = raw.split('\n').filter(Boolean)
console.log(`source: ${source}`)
console.log(`entries: ${lines.length}, size: ${(raw.length / 1048576).toFixed(1)} MB`)

/** Truncate every text block of every entry. */
function truncate(limit) {
  const out = []
  for (const line of lines) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const content = entry.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.length > limit) {
          block.text = `${block.text.slice(0, limit)}\n[truncated]`
        }
      }
    }
    out.push(JSON.stringify(entry))
  }
  return out.join('\n') + '\n'
}

/** Drop the oldest entries, keeping the header and the newest. */
function keepRecent(count) {
  return [lines[0], ...lines.slice(-count)].join('\n') + '\n'
}

/** Ask Pi one trivial question with a given session file. */
function ask(label, sessionFile) {
  return new Promise((resolve) => {
    const child = spawnPi('C:/Users/danalec/.pi/agent/bin/pi.cmd', ['--mode', 'rpc', '--session', sessionFile], {
      cwd: 'C:/Users/danalec',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let answer = null
    let failure = null
    let settled = false
    const rl = createInterface({ input: child.stdout })
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdin.end() } catch {}
      setTimeout(() => { try { child.kill() } catch {} }, 300)
      resolve(result)
    }
    rl.on('line', (line) => {
      let record
      try { record = JSON.parse(line) } catch { return }
      if (record.type === 'message_end' && record.message?.role === 'assistant') {
        if (record.message.stopReason === 'error') {
          failure = String(record.message.errorMessage ?? 'error').slice(0, 140)
        } else {
          answer = (record.message.content ?? []).map(c => c.text ?? '').join('').slice(0, 40)
        }
      }
      if (record.type === 'agent_settled') finish({ label, answer, failure })
    })
    const timer = setTimeout(() => finish({ label, answer, failure: failure ?? 'timeout' }), 150000)
    child.stdin.write(`${JSON.stringify({ type: 'set_model', provider: 'minimax', modelId: 'MiniMax-M3.1-Flash-Preview', id: 'm' })}\n`)
    child.stdin.write(`${JSON.stringify({ type: 'prompt', message: 'Reply with exactly: OK', id: 'p' })}\n`)
  })
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-ctx-'))
const variants = [
  { label: 'original            ', text: raw },
  { label: 'blocks <= 20k chars ', text: truncate(20000) },
  { label: 'blocks <= 4k chars  ', text: truncate(4000) },
  { label: 'last 400 entries    ', text: keepRecent(400) },
  { label: 'last 200 entries    ', text: keepRecent(200) },
  { label: 'last 100 entries    ', text: keepRecent(100) },
  { label: 'last  50 entries    ', text: keepRecent(50) },
  { label: 'last  25 entries    ', text: keepRecent(25) },
]

for (const variant of variants) {
  const file = join(dir, `${variant.label.trim().replace(/\W+/g, '-')}.jsonl`)
  writeFileSync(file, variant.text)
  const result = await ask(variant.label, file)
  console.log(
    `${result.label} | ${(variant.text.length / 1048576).toFixed(2).padStart(6)} MB | ` +
    (result.answer !== null ? `OK: ${JSON.stringify(result.answer)}` : `FAILED: ${result.failure}`),
  )
}
