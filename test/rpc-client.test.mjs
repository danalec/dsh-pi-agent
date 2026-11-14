import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PiRpcClient } from '../dist/rpc-client.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakePi = join(here, 'fixtures', 'fake-pi.mjs')

/** Build a launcher the client can spawn as a plain executable. */
function makeLauncher() {
  const directory = mkdtempSync(join(tmpdir(), 'pi-rpc-'))
  if (process.platform === 'win32') {
    const launcher = join(directory, 'fake-pi.cmd')
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${fakePi}" %*\r\n`)
    return launcher
  }
  const launcher = join(directory, 'fake-pi.sh')
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}" "$@"\n`)
  chmodSync(launcher, 0o755)
  return launcher
}

test('the client correlates commands with their responses', async () => {
  const client = new PiRpcClient({ cwd: tmpdir(), piPath: makeLauncher(), commandTimeoutMs: 10_000 })
  try {
    const response = await client.send({ type: 'get_state' })
    assert.equal(response.success, true)
    assert.equal(response.command, 'get_state')
  } finally {
    client.close()
  }
})

test('the client streams agent events', async () => {
  const client = new PiRpcClient({ cwd: tmpdir(), piPath: makeLauncher(), commandTimeoutMs: 10_000 })
  try {
    const seen = []
    client.onEvent((event) => seen.push(event.type))
    const disposition = await client.prompt('hello')
    assert.equal(disposition, 'started')
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.ok(seen.includes('message_update'))
    assert.ok(seen.includes('agent_settled'))
  } finally {
    client.close()
  }
})

test('the initial model is applied and a refused route fails loudly', async () => {
  const client = new PiRpcClient({ cwd: tmpdir(), piPath: makeLauncher(), model: 'anthropic/claude-x', commandTimeoutMs: 10_000 })
  try {
    await client.ready
  } finally {
    client.close()
  }
})

test('a command that never answers times out', async () => {
  const client = new PiRpcClient({ cwd: tmpdir(), piPath: makeLauncher(), commandTimeoutMs: 200 })
  try {
    await assert.rejects(
      () => client.send({ type: 'never_answer' }),
      /timed out/,
    )
  } finally {
    client.close()
  }
})

test('closing the client stops the child', async () => {
  const client = new PiRpcClient({ cwd: tmpdir(), piPath: makeLauncher(), commandTimeoutMs: 10_000 })
  client.close()
  const info = await client.whenExit()
  assert.equal(typeof info.code, 'number')
  assert.equal(client.running, false)
})

test('a dialog request is answered, so the child is never left waiting', async () => {
  // A Pi extension's dialog blocks the child until the client answers. An
  // unanswered request freezes the whole child: the run stops and every
  // later command waits behind it.
  const client = new PiRpcClient({ cwd: tmpdir(), piPath: makeLauncher(), commandTimeoutMs: 10_000 })
  try {
    const answers = []
    client.onEvent((event) => {
      if (event.type === 'extension_ui_answered') answers.push(event.payload)
    })
    await client.send({ type: 'ask_dialog' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(answers.length, 1, 'the dialog was answered')
    assert.equal(answers[0].type, 'extension_ui_response')
    assert.equal(answers[0].id, 'dialog-1')
    assert.equal(answers[0].cancelled, true, 'the answer is a cancellation: the DSH frontend has no surface for it')
  } finally {
    client.close()
  }
})

test('the thinking level is sent after the route it belongs to', async () => {
  // The level applies to the model that is selected: it is sent after the
  // route, never before it.
  const client = new PiRpcClient({
    cwd: tmpdir(),
    piPath: makeLauncher(),
    model: 'anthropic/claude-x',
    thinkingLevel: 'high',
    commandTimeoutMs: 10_000,
  })
  try {
    await client.ready
    const state = await client.send({ type: 'get_state' })
    assert.equal(state.success, true)
  } finally {
    client.close()
  }
})
