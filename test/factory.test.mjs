import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePiRoute } from '../dist/factory.js'
import { resolveWindowsExecutable } from '../dist/spawn.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the factory default is used when nothing is requested', () => {
  const route = resolvePiRoute('anthropic/claude-sonnet-4-5', undefined)
  assert.equal(route.route, 'anthropic/claude-sonnet-4-5')
  assert.equal(route.provider, 'anthropic')
  assert.equal(route.model, 'claude-sonnet-4-5')
})

test('a requested provider and model win over the factory default', () => {
  const route = resolvePiRoute('anthropic/claude-sonnet-4-5', { provider: 'openai', model: 'gpt-5' })
  assert.equal(route.route, 'openai/gpt-5')
  assert.equal(route.provider, 'openai')
  assert.equal(route.model, 'gpt-5')
})

test('a requested model without a provider borrows the default provider', () => {
  const route = resolvePiRoute('anthropic/claude-sonnet-4-5', { model: 'claude-opus-4-5' })
  assert.equal(route.route, 'anthropic/claude-opus-4-5')
  assert.equal(route.provider, 'anthropic')
  assert.equal(route.model, 'claude-opus-4-5')
})

test('the provider never receives a model id', () => {
  const route = resolvePiRoute('', { model: 'claude-sonnet-4-5' })
  assert.notEqual(route.provider, 'claude-sonnet-4-5')
  assert.equal(route.route, '')
})

test('no factory default and no request means no route', () => {
  const route = resolvePiRoute(undefined, undefined)
  assert.equal(route.route, '')
  assert.equal(route.provider, '')
  assert.equal(route.model, '')
})

test('a provider-only request pairs with the default model', () => {
  const route = resolvePiRoute('anthropic/claude-sonnet-4-5', { provider: 'openai' })
  assert.equal(route.route, 'openai/claude-sonnet-4-5')
})

test('windows resolves a command shim to an executable extension', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-resolve-'))
  const shim = join(directory, 'fake-pi.cmd')
  writeFileSync(shim, '@echo off\r\n')
  assert.equal(resolveWindowsExecutable(shim), shim)
  assert.equal(resolveWindowsExecutable(join(directory, 'fake-pi')), shim)
  assert.equal(resolveWindowsExecutable(join(directory, 'missing-pi')), undefined)
})

test('windows never resolves an explicit path to an extensionless shim', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-resolve-'))
  const shim = join(directory, 'fake-pi.cmd')
  writeFileSync(shim, '@echo off\r\n')
  // The extensionless POSIX shim an npm-style installer drops next to the
  // `.cmd` file is not a runnable Win32 image.
  writeFileSync(join(directory, 'fake-pi'), '#!/bin/sh\nexec node "$@"\n')
  assert.equal(resolveWindowsExecutable(join(directory, 'fake-pi')), shim)
})

test('a session route crosses to the child unchanged', () => {
  // The DSH provider names and the Pi provider names are the same: a route
  // crosses the boundary without a translation table.
  const route = resolvePiRoute('minimax/MiniMax-M3.1-Flash', { provider: 'zai', model: 'glm-5.3-flash' })
  assert.equal(route.route, 'zai/glm-5.3-flash')
  assert.equal(route.provider, 'zai')
  assert.equal(route.model, 'glm-5.3-flash')
})

test('a gateway route crosses to the child unchanged', () => {
  const route = resolvePiRoute('minimax/MiniMax-M3.1-Flash', { provider: 'bailian-tpp', model: 'qwen3.8-max' })
  assert.equal(route.route, 'bailian-tpp/qwen3.8-max')
})

test('a route without a model borrows the default model', () => {
  const route = resolvePiRoute('minimax/MiniMax-M3.1-Flash', { provider: 'deepseek' })
  assert.equal(route.route, 'deepseek/MiniMax-M3.1-Flash')
})

test('a harness route crosses to the Pi provider that serves it', () => {
  // The harness's own DeepSeek route and Pi's DeepSeek provider are the
  // same service; the model ids match one for one.
  const route = resolvePiRoute('minimax/MiniMax-M3.1-Flash', { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.equal(route.route, 'deepseek/deepseek-flash')
  assert.equal(route.provider, 'deepseek-official', 'the harness keeps its own provider name')
  assert.equal(route.piProvider, 'deepseek')
})
