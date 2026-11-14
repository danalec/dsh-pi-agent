/**
 * Compare the OLD and NEW assistant-frame revisions against DSH's REAL
 * session-controller accumulator (extracted from the installed app.asar).
 *
 * The accumulator is what the web UI reads to render the live answer. It
 * keeps one baseline per revision, and the renderer receives a fresh
 * baseline whenever the value changes. A revision gap makes it drop the
 * active attempt, so every chunk rebuilt the whole baseline — a render
 * storm on the renderer side.
 *
 * usage: node tools/check-stream-storm.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const ASAR = 'C:/Users/danalec/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const ACCUMULATOR = 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/assistant-stream.js'

const target = join(process.cwd(), '.tmp-stream-storm', 'assistant-stream.mjs')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, execFileSync(process.execPath, [join(here, 'asar.cjs'), 'get', ASAR, ACCUMULATOR], { maxBuffer: 32 * 1024 * 1024 }))
const { SessionAssistantStreamAccumulator } = await import(`file://${target.replace(/\\/g, '/')}`)

/** Feed one attempt of N chunks through an accumulator. */
function run(label, revisionOf) {
  const accumulator = new SessionAssistantStreamAccumulator()
  let baselines = 0
  let dropped = 0
  const total = 40
  accumulator.accept({ type: 'start', attemptId: 'a1', revision: revisionOf(0), turn: 1, step: 1 }, 0)
  for (let index = 0; index < total; index += 1) {
    accumulator.accept({
      type: 'chunk',
      attemptId: 'a1',
      revision: revisionOf(index + 1),
      index,
      time: index,
      chunk: { type: 'text-delta', index: 0, text: 'x' },
    }, 0)
    const snapshot = accumulator.snapshot()
    baselines += 1
    if (snapshot.activeAttempt === undefined) dropped += 1
  }
  console.log(`${label}: baselines rebuilt ${baselines}/${total}  dropped attempts ${dropped}`)
  return { baselines, dropped }
}

const old = run('OLD (revision per attempt) ', () => 1)
const current = run('NEW (revision per frame)  ', (index) => index + 1)

console.log('')
if (old.dropped > 0 && current.dropped === 0) {
  console.log('OK: the old revision dropped the live attempt on every chunk; the new one keeps it.')
} else {
  console.log(`unexpected: old dropped ${old.dropped}, new dropped ${current.dropped}`)
  process.exitCode = 1
}
