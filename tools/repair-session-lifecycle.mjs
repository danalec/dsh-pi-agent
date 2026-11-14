/**
 * Repair a stored DSH session log whose lifecycle drifted.
 *
 * DSH's session format wants a strict lifecycle: a turn holds steps, a
 * step holds the events of one model call, and every event names the turn
 * and the step it belongs to. A driver that ends a turn with an error but
 * leaves the child running breaks that: the child's later steps are written
 * after the `turn/end`, and the boundaries that would have closed the open
 * step and opened the next one are never written — the backend refuses to
 * append them, because the turn is already over.
 *
 * The repair rebuilds the lifecycle around the events that are there:
 *
 * - a step event that names a step the log did not open gets the missing
 *   `step/end` and `step/start` around it,
 * - a step that was never closed is closed before the next one opens,
 * - the events that ran after their turn's end are read back inside it.
 *
 * Nothing is dropped: the conversation survives, and only the boundaries
 * move. The sequence is renumbered afterwards, and every reference is
 * checked against the new numbering.
 *
 * The file keeps the backend's frame layout: the first frame is exactly the
 * header line, the rest carries the events. The original is copied into
 * `$DSH_HOME/session-repairs` before the rewrite.
 *
 * usage: node tools/repair-session-lifecycle.mjs <session-log> [--dry]
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

const file = process.argv[2]
const dry = process.argv.includes('--dry')
if (file === undefined) {
  console.error('usage: node tools/repair-session-lifecycle.mjs <session-log> [--dry]')
  process.exit(1)
}

const raw = readFileSync(file)
const plain = zlib.zstdDecompressSync(raw).toString('utf8')
const lines = plain.split('\n').filter(Boolean)
const header = JSON.parse(lines[0])
const body = lines.slice(1).map(line => JSON.parse(line))

/** The events that name the step they belong to. */
const STEP_EVENT_TYPES = new Set(['assistant/message', 'tool/call', 'tool/result'])

/** The turn of an event, when it names one. */
const turnOf = (event) => event.data?.turn

/**
 * Build one boundary event.
 *
 * @param type - the boundary type.
 * @param turn - the turn the boundary belongs to.
 * @param step - the step the boundary belongs to.
 * @param time - the time of the event the boundary accompanies.
 * @returns the event.
 */
function boundary(type, turn, step, time) {
  return {
    type,
    seq: -1,
    time,
    data: step === undefined ? { turn } : { turn, step },
  }
}

const repaired = []
let turn = null
let step = null
let nextTurn = 1
let nextStep = 1
let inserted = 0
let moved = 0

/** Close the open step, if any. */
const closeStep = (time) => {
  if (step === null) return
  repaired.push(boundary('step/end', turn, step, time))
  step = null
  inserted += 1
}

/** Open the step an event names. */
const openStep = (number, time) => {
  repaired.push(boundary('step/start', turn, number, time))
  step = number
  nextStep = number + 1
  inserted += 1
}

/**
 * Read one event into the repaired log, with the boundaries it needs.
 *
 * @param event - the event to read.
 */
const read = (event) => {
  const data = event.data ?? {}
  const type = event.type
  const time = event.time ?? Date.now()

  if (type === 'turn/start') {
    if (turn !== null) {
      // The turn before it was never closed: close it before the next one.
      closeStep(time)
      repaired.push(boundary('turn/end', turn, undefined, time))
      inserted += 1
    }
    turn = data.turn
    nextStep = 1
    repaired.push(event)
    return
  }

  if (type === 'step/start') {
    closeStep(time)
    // The step number follows the log's own sequence.
    if (data.step !== nextStep) data.step = nextStep
    repaired.push(event)
    step = data.step
    nextStep = data.step + 1
    return
  }

  if (type === 'step/end') {
    if (step !== data.step) {
      // The step it closes was never opened: open it, then close it.
      if (step !== null) closeStep(time)
      if (data.step !== undefined) openStep(data.step, time)
    }
    repaired.push(event)
    step = null
    nextStep = (data.step ?? nextStep) + 1
    return
  }

  if (type === 'turn/end') {
    closeStep(time)
    repaired.push(event)
    turn = null
    nextTurn = (data.turn ?? nextTurn) + 1
    return
  }

  if (STEP_EVENT_TYPES.has(type)) {
    const named = data.step
    if (type === 'tool/result' && event.surfaceOp !== 'append') {
      // A tool result outside the surface only needs the turn.
      repaired.push(event)
      return
    }
    if (step !== named) {
      if (step !== null) closeStep(time)
      if (named !== undefined) openStep(named, time)
    }
    repaired.push(event)
    return
  }

  repaired.push(event)
}

// The pass: a turn's end is read after the events that ran past it.
let index = 0
while (index < body.length) {
  const event = body[index]
  if (event.type !== 'turn/end') {
    read(event)
    index += 1
    continue
  }
  // The events that follow and belong to the turn that is ending.
  const orphans = []
  let cursor = index + 1
  while (cursor < body.length) {
    const next = body[cursor]
    if (turnOf(next) !== turnOf(event)) break
    if (next.type === 'turn/start' || next.type === 'turn/end') break
    orphans.push(next)
    cursor += 1
  }
  if (orphans.length === 0) {
    read(event)
    index += 1
    continue
  }
  // The turn is still open while its late events are read: they belong to
  // it, and the boundaries they missed are written around them.
  moved += orphans.length
  for (const orphan of orphans) read(orphan)
  read(event)
  index = cursor
}

// Renumber the sequence, and every reference to a sequence number.
const oldSeqs = repaired.map(event => event.seq)
repaired.forEach((event, index) => {
  event.seq = index
})
const seqRemap = new Map()
oldSeqs.forEach((seq, index) => {
  if (typeof seq === 'number' && seq >= 0) seqRemap.set(seq, index)
})
const remap = value => (typeof value === 'number' ? (seqRemap.get(value) ?? value) : value)
for (const event of repaired) {
  // The references live on the event itself, and sometimes inside its data.
  if (Array.isArray(event.sourceEventSeqs)) event.sourceEventSeqs = event.sourceEventSeqs.map(remap)
  if (Array.isArray(event.data?.sourceEventSeqs)) event.data.sourceEventSeqs = event.data.sourceEventSeqs.map(remap)
  const surfaceOp = event.surfaceOp
  if (surfaceOp !== null && typeof surfaceOp === 'object') {
    if (typeof surfaceOp.startSeq === 'number') surfaceOp.startSeq = remap(surfaceOp.startSeq)
    if (typeof surfaceOp.endSeq === 'number') surfaceOp.endSeq = remap(surfaceOp.endSeq)
  }
}

/**
 * Repair the references the renumbering could not place.
 *
 * A reference must name an earlier event of this log. One that names the
 * event itself, or a later one, is wrong: the source it meant is found by
 * the call it answers, and the reference is dropped when there is none.
 */
let fixed = 0
let dropped = 0
for (let index = 0; index < repaired.length; index += 1) {
  const event = repaired[index]
  const sourceEventSeqs = Array.isArray(event.sourceEventSeqs)
    ? event.sourceEventSeqs
    : event.data?.sourceEventSeqs
  if (!Array.isArray(sourceEventSeqs)) continue
  const kept = []
  for (const source of sourceEventSeqs) {
    if (typeof source !== 'number' || source < index) {
      kept.push(source)
      continue
    }
    const callId = event.data?.message?.toolCallId ?? event.data?.callId
    const origin = callId === undefined
      ? undefined
      : repaired.find(candidate => (
        candidate !== event
        && (candidate.data?.callId === callId || candidate.data?.message?.toolCallId === callId)
      ))
    if (origin !== undefined) {
      kept.push(origin.seq)
      fixed += 1
      continue
    }
    dropped += 1
  }
  if (Array.isArray(event.sourceEventSeqs)) event.sourceEventSeqs = kept
  else event.data.sourceEventSeqs = kept
}

console.log(`boundaries inserted: ${inserted}; events moved back inside their turn: ${moved}; references fixed: ${fixed}${dropped > 0 ? `; dropped: ${dropped}` : ''}`)

const bodyText = repaired.map(event => JSON.stringify(event)).join('\n') + '\n'
if (dry) {
  console.log('dry run: nothing written')
  process.exit(0)
}

const options = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const frame1 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), options)
const frame2 = zlib.zstdCompressSync(Buffer.from(bodyText, 'utf8'), options)

const repairs = join(homedir(), '.dsh', 'session-repairs')
mkdirSync(repairs, { recursive: true })
const name = file.split(/[\\/]/).slice(-2).join('-')
const backup = join(repairs, `${name}.bak`)
copyFileSync(file, backup)
writeFileSync(file, Buffer.concat([frame1, frame2]))
console.log(`backup: ${backup}`)
console.log(`rewritten: ${file}, ${repaired.length} events`)
