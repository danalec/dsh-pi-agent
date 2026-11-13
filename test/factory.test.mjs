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
