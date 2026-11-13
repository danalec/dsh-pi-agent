/**
 * Repair a stored DSH session log whose tool calls were never advertised.
 *
 * DSH's session format wants every `tool/call` advertised by an assistant
 * message that carries the matching tool-call block, and every call answered
 * by a tool result before its step closes. An agent that writes the call
 * before the message leaves the log unreadable: the backend refuses it with
 * "tool/call … has no advertised tool lifecycle".
 *
 * The repair advertises the calls with an assistant message and lets DSH's
 * own recovery answer the calls nothing ever answered. It then renumbers the
 * log. The file keeps the backend's frame layout: the first frame is exactly
 * the header line, the rest carries the events.
 *
 * usage: node tools/repair-tool-lifecycle.mjs <session-log> [--dry]
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as zlib from 'node:zlib'
import { ToolCallRecovery } from '@deepseek-ai/dsh-session'

const file = process.argv[2]
const dry = process.argv.includes('--dry')
if (file === undefined) {
  console.error('usage: node tools/repair-tool-lifecycle.mjs <session-log> [--dry]')
  process.exit(1)
}

const raw = readFileSync(file)
const plain = zlib.zstdDecompressSync(raw).toString('utf8')
const lines = plain.split('\n').filter(Boolean)
const events = lines.map(line => JSON.parse(line))
const header = events[0]
const body = events.slice(1)

/** The tool calls an assistant message advertises. */
const advertised = new Set()
for (const event of body) {
  if (event.type !== 'assistant/message') continue
  for (const block of event.data?.message?.content ?? []) {
    if (block.type === 'tool-call') advertised.add(block.id)
  }
}

/** The last assistant message before an index, used as the shape template. */
const templateBefore = index => {
  for (let i = index; i >= 0; i -= 1) {
    if (body[i].type === 'assistant/message') return body[i]
  }
  return undefined
}

// The groups of consecutive tool calls nobody advertised.
const groups = []
let current
for (const [index, event] of body.entries()) {
  if (event.type === 'tool/call' && !advertised.has(event.data.callId)) {
    if (current === undefined) {
      current = { first: index, indexes: [] }
      groups.push(current)
    }
    current.indexes.push(index)
    continue
  }
  current = undefined
}

if (groups.length === 0) {
  console.log('nothing to repair')
  process.exit(0)
}
console.log(`unadvertised tool calls: ${groups.reduce((sum, group) => sum + group.indexes.length, 0)} in ${groups.length} groups`)

/** Build the assistant message that advertises one group of calls. */
const advertisement = (group) => {
  const calls = group.indexes.map(index => body[index])
  const template = templateBefore(group.first)
  const first = calls[0]
  const content = calls.map(call => ({
    type: 'tool-call',
    id: call.data.callId,
    name: call.data.name,
    arguments: call.data.arguments,
  }))
  const stream = calls.map((call, index) => ({
    time: call.time,
    chunk: {
      type: 'tool-call-delta',
      index,
      id: call.data.callId,
      name: call.data.name,
      argumentsDelta: call.data.arguments,
    },
  }))
  const message = template?.data?.message ?? {}
  return {
    type: 'assistant/message',
    time: first.time,
    surfaceOp: 'append',
    data: {
      turn: first.data.turn,
      step: first.data.step,
      message: {
        ...message,
        id: randomUUID(),
        role: 'assistant',
        content,
        source: message.source ?? { kind: 'model', provider: 'mistral', model: 'mistral-large-4' },
      },
      stream,
    },
  }
}

// Rebuild the log with the advertisements in place.
const rewritten = []
const skipped = new Set()
for (const [index, event] of body.entries()) {
  const group = groups.find(candidate => candidate.first === index)
  if (group !== undefined) {
    rewritten.push(advertisement(group))
    for (const callIndex of group.indexes) {
      rewritten.push(body[callIndex])
      skipped.add(callIndex)
    }
    continue
  }
  if (skipped.has(index)) continue
  rewritten.push(event)
}

// Let DSH's own recovery answer the calls nothing answered. The results go
// in front of the step they belong to: a step that closes with a call in
// flight is what the format refuses.
const recovery = new ToolCallRecovery()
const balanced = []
for (const event of rewritten) {
  if (event.type === 'step/end') {
    balanced.push(...recovery.results())
  }
  recovery.observe(event)
  balanced.push(event)
}
balanced.push(...recovery.results())

// The old sequence number of each event, and its new one.
const oldSeqs = balanced.map(event => event.seq)
balanced.forEach((event, index) => {
  event.seq = index
})
const seqRemap = new Map()
oldSeqs.forEach((seq, index) => {
  if (typeof seq === 'number') seqRemap.set(seq, index)
})

/** Move every reference to an old sequence number onto its new one. */
const remap = value => (typeof value === 'number' ? (seqRemap.get(value) ?? value) : value)
for (const event of balanced) {
  const sourceEventSeqs = event.data?.sourceEventSeqs
  if (Array.isArray(sourceEventSeqs)) {
    event.data.sourceEventSeqs = sourceEventSeqs.map(remap)
  }
  const surfaceOp = event.surfaceOp
  if (surfaceOp !== null && typeof surfaceOp === 'object') {
    if (typeof surfaceOp.startSeq === 'number') surfaceOp.startSeq = remap(surfaceOp.startSeq)
    if (typeof surfaceOp.endSeq === 'number') surfaceOp.endSeq = remap(surfaceOp.endSeq)
  }
}

const bodyText = balanced.map(event => JSON.stringify(event)).join('\n') + '\n'
if (dry) {
  console.log('dry run: nothing written')
  process.exit(0)
}

const options = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
const frame1 = zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), options)
const frame2 = zlib.zstdCompressSync(Buffer.from(bodyText, 'utf8'), options)

const backup = `${file}.bak`
copyFileSync(file, backup)
writeFileSync(file, Buffer.concat([frame1, frame2]))
console.log(`backup: ${backup}`)
console.log(`rewritten: ${file}, ${raw.length} -> ${frame1.length + frame2.length} bytes, ${balanced.length} events`)
