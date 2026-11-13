import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPiSessionFile } from '../dist/history.js'

function session(events, id = 'session-1') {
  return { id, header: { seedLength: 0 }, events }
}

function userMessage(seq, text) {
  return {
    type: 'user/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }] },
  }
}

function assistantMessage(seq, content, turn = 1) {
  return {
    type: 'assistant/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      turn,
      step: 1,
      message: {
        id: `a${seq}`,
        role: 'assistant',
        content,
        source: { kind: 'model', provider: 'anthropic', model: 'claude-x' },
      },
    },
  }
}

test('the rebuilt Pi session maps DSH blocks onto Pi blocks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-history-'))
  const file = join(directory, 'session.jsonl')
  try {
    buildPiSessionFile({
      session: session([
        userMessage(0, 'hello'),
        assistantMessage(1, [
          { type: 'text', text: 'sure' },
          { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
        ]),
      ]),
      cwd: '/tmp/project',
      filePath: file,
    })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines[0].type, 'session')
    assert.equal(lines[0].version, 3)
    assert.equal(lines[0].cwd, '/tmp/project')
    assert.equal(lines[1].message.role, 'user')
    assert.equal(lines[1].message.content, 'hello')
    assert.deepEqual(lines[2].message.content, [
      { type: 'text', text: 'sure' },
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the turn end reason becomes the Pi stop reason', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-history-'))
  const file = join(directory, 'session.jsonl')
  try {
    buildPiSessionFile({
      session: session([
        userMessage(0, 'hi'),
        assistantMessage(1, [{ type: 'text', text: 'partial' }]),
        { type: 'turn/end', seq: 2, time: 1_700_000_000_002, data: { turn: 1, reason: { kind: 'max-tokens' } } },
      ]),
      cwd: '/tmp/project',
      filePath: file,
    })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    // `turn/end` is logged AFTER the assistant message it describes, so the
    // reason has to be collected before the entries are built.
    assert.equal(lines[2].message.stopReason, 'length')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an aborted turn maps to the Pi aborted stop reason', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-history-'))
  const file = join(directory, 'session.jsonl')
  try {
    buildPiSessionFile({
      session: session([
        userMessage(0, 'hi'),
        assistantMessage(1, [{ type: 'text', text: 'partial' }]),
        { type: 'turn/end', seq: 2, time: 1_700_000_000_002, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
      ]),
      cwd: '/tmp/project',
      filePath: file,
    })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(lines[2].message.stopReason, 'aborted')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a user message never carries a thinking block', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-history-'))
  const file = join(directory, 'session.jsonl')
  try {
    buildPiSessionFile({
      session: session([
        {
          type: 'user/message',
          seq: 0,
          time: 1_700_000_000_000,
          data: { id: 'm0', role: 'user', content: [{ type: 'reasoning', text: 'thinking only' }] },
        },
      ]),
      cwd: '/tmp/project',
      filePath: file,
    })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    // Pi's UserMessage content is `string | (TextContent | ImageContent)[]`.
    assert.equal(lines[1].message.content, '')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a tool result keeps every content block and recovers the tool name', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-history-'))
  const file = join(directory, 'session.jsonl')
  try {
    buildPiSessionFile({
      session: session([
        userMessage(0, 'read it'),
        assistantMessage(1, [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }]),
        { type: 'tool/call', seq: 2, time: 1_700_000_000_002, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } },
        {
          type: 'tool/result',
          seq: 3,
          time: 1_700_000_000_003,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 't1',
              role: 'user',
              content: [{
                type: 'tool-result',
                toolCallId: 'c1',
                content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
                isError: false,
              }],
              source: { kind: 'tool', name: 'read' },
            },
          },
        },
      ]),
      cwd: '/tmp/project',
      filePath: file,
    })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const toolResult = lines.find((entry) => entry.message?.role === 'toolResult')
    assert.equal(toolResult.message.toolCallId, 'c1')
    assert.equal(toolResult.message.toolName, 'read')
    assert.deepEqual(toolResult.message.content, [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the rebuilt session keeps its identity across rebuilds', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-history-'))
  try {
    const first = join(directory, 'first.jsonl')
    const second = join(directory, 'second.jsonl')
    const events = session([userMessage(0, 'hello')], 'stable-session')
    buildPiSessionFile({ session: events, cwd: '/tmp/project', filePath: first })
    buildPiSessionFile({ session: events, cwd: '/tmp/project', filePath: second })
    const firstHeader = JSON.parse(readFileSync(first, 'utf8').split('\n')[0])
    const secondHeader = JSON.parse(readFileSync(second, 'utf8').split('\n')[0])
    assert.equal(firstHeader.id, secondHeader.id)
    assert.match(firstHeader.id, /^[0-9a-f-]{36}$/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the message timestamp is written in Pi\'s unit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-history-'))
  const file = join(directory, 'session.jsonl')
  try {
    buildPiSessionFile({
      session: session([userMessage(0, 'hello')]),
      cwd: '/tmp/project',
      filePath: file,
    })
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.equal(typeof lines[1].message.timestamp, 'number')
    assert.equal(lines[1].message.timestamp, 1_700_000_000_000)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
