/**
 * Verify the Pi loop against DSH's REAL assistant-stream consumer.
 *
 * The DSH web UI does not read the assistant text from the durable log while
 * a turn is running: it reads the live `agent/assistant-stream` frames, and
 * the session controller keeps them in a per-session accumulator that accepts
 * a frame only when its revision is the successor of the last accepted one.
 *
 * This script takes that accumulator straight out of the installed
 * `app.asar` (the code the desktop app actually runs), drives one real Pi
 * turn through the plugin, and asserts the streamed text survives.
 *
 * usage: node tools/check-live-stream.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolsService from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { apply as applyPersistence, Config as PersistenceConfig, name as persistenceName } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { apply, Config, inject, name } from '../dist/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const out = line => process.stdout.write(line + '\n')

// ---- The real accumulator, taken from the installed application ----

const ASAR = 'C:/Users/danalec/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const ACCUMULATOR = 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/assistant-stream.js'

/** Extract one file out of an asar archive into a module the project can import. */
async function extractFromAsar(asar, path, target) {
  const { execFileSync } = await import('node:child_process')
  const bytes = execFileSync(process.execPath, [join(here, 'asar.cjs'), 'get', asar, path], {
    maxBuffer: 32 * 1024 * 1024,
  })
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  return target
}

let accumulatorModule
try {
  const target = join(here, '..', '.tmp-live-stream', 'assistant-stream.mjs')
  await extractFromAsar(ASAR, ACCUMULATOR, target)
  accumulatorModule = await import(`file://${target.replace(/\\/g, '/')}`)
} catch (error) {
  out(`SKIP: the installed application was not readable (${String(error)})`)
  process.exit(0)
}
const { SessionAssistantStreamAccumulator } = accumulatorModule
out(`accumulator source: ${ACCUMULATOR}`)

// ---- Drive one real Pi turn through the plugin ----

const store = mkdtempSync(join(tmpdir(), 'dsh-pi-stream-'))
const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(AgentRegistry)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(LlmRuntime)
await ctx.plugin(ToolsService)
await ctx.plugin(SystemPrompt)
// The Pi child is another process: the keys it needs come from the
// host's credential service, which the driver resolves and hands over.
await ctx.plugin(LocalCredentialProvider, { dshHome: join(homedir(), '.dsh') })
await ctx.plugin({ name: persistenceName, Config: PersistenceConfig, apply: applyPersistence }, { root: store })

const fiber = await ctx.plugin({ name, inject, Config, apply }, {
  piPath: 'C:/Users/danalec/.pi/agent/bin/pi.cmd',
  cwd: 'C:/Users/danalec',
  pinModel: true,
  debug: true,
})
const deadline = Date.now() + 10_000
while (Date.now() < deadline) {
  try {
    ctx.agents.requireFactory()
    break
  } catch {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// The real consumer: one accumulator per session, fed every live frame.
const accumulators = new Map()
/** The richest snapshot seen, i.e. the one taken while the attempt was live. */
const best = new Map()
ctx.on('agent/assistant-stream', ({ agent, frame }) => {
  let accumulator = accumulators.get(agent.session.id)
  if (accumulator === undefined) {
    accumulator = new SessionAssistantStreamAccumulator()
    accumulators.set(agent.session.id, accumulator)
  }
  accumulator.accept(frame, agent.session.seq === 0 ? -1 : agent.session.seq - 1)
  const snapshot = accumulator.snapshot()
  const size = (snapshot.activeAttempt?.stream ?? [])
    .reduce((total, record) => total + (record.texts ?? []).join('').length, 0)
  if (size > (best.get(agent.session.id)?.size ?? -1)) {
    best.set(agent.session.id, { size, snapshot })
  }
}, { global: true })

const id = SessionId(`stream-${Date.now().toString(36)}`)
const handle = await ctx.agents.create({
  sessionId: id,
  setup: (agentCtx) => {
    void agentCtx.systemPrompt
    void agentCtx.tools
    void agentCtx.llm
  },
})
out(`agent created: ${String(id)}`)

handle.agent.followup({
  id: SessionId(`msg-${Date.now().toString(36)}`),
  role: 'user',
  content: [{ type: 'text', text: 'Reply with exactly: dsh-pi-stream-ok' }],
  source: { kind: 'user' },
})
await handle.agent.whenIdle()

const accumulator = accumulators.get(id)
if (accumulator === undefined) {
  out('FAIL: no assistant frame reached the session controller')
  await handle.dispose()
  await fiber.dispose()
  await ctx.fiber.dispose()
  process.exit(1)
}

const snapshot = best.get(id)?.snapshot ?? accumulator.snapshot()
out(`frames accepted, revision: ${accumulator.snapshot().revision}`)
const streamed = (snapshot.activeAttempt?.stream ?? [])
  .flatMap(record => record.texts ?? [])
  .join('')
out(`streamed text: ${JSON.stringify(streamed)}`)

// The durable log still carries the final answer.
const assistant = handle.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')
const finalText = assistant.map(event => event.data.message.content.map(block => block.text ?? '').join('')).join('')
out(`durable text:    ${JSON.stringify(finalText)}`)

await handle.dispose()
await fiber.dispose()
await ctx.fiber.dispose()

if (!finalText.includes('dsh-pi-stream-ok')) {
  out('FAIL: the durable log does not carry the answer')
  process.exit(1)
}
if (!streamed.includes('dsh-pi-stream-ok')) {
  out('FAIL: DSH\'s session controller did not keep the live stream')
  process.exit(1)
}
out('OK: the turn completed, the durable log carries the answer, and DSH\'s session controller kept the live stream')
