/**
 * Extract the provider routes the desktop profile configures, with their
 * model ids, from the DSH patch layer.
 *
 * usage: node tools/read-profile-models.mjs [profile]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const profile = process.argv[2] ?? 'desktop'

/**
 * The routes the profile's plugin declares.
 *
 * @param name - the profile to read.
 * @returns the routes, as `provider/model` strings.
 */
export function profileRoutes(name) {
  const file = join(homedir(), '.dsh', 'profiles', name, 'cordis.patch.yml')
  const text = readFileSync(file, 'utf8')

// The llm-pi-ai block: its providers dict owns the routes.
const start = text.indexOf('- id: llm-pi-ai')
const end = text.indexOf('\n- id: ', start + 10)
const block = text.slice(start, end === -1 ? text.length : end)

const lines = block.split('\n')
let provider = undefined
const routes = new Map()
for (const line of lines) {
  const providerMatch = /^ {6}([a-z0-9_-]+):\s*$/.exec(line)
  if (providerMatch) {
    provider = providerMatch[1]
    routes.set(provider, [])
    continue
  }
  if (provider === undefined) continue
  const apiKey = /apiKeyEnv:\s*(\S+)/.exec(line)
  if (apiKey) routes.set(provider, { apiKeyEnv: apiKey[1], models: routes.get(provider)?.models ?? [] })
  const baseURL = /baseURL:\s*(\S+)/.exec(line)
  if (baseURL) {
    const current = routes.get(provider)
    if (current && typeof current === 'object') current.baseURL = baseURL[1]
  }
  const modelId = /^\s+- id:\s*(\S+)\s*$/.exec(line)
  if (modelId) {
    const current = routes.get(provider)
    if (current && typeof current === 'object') current.models.push(modelId[1])
  }
}

  const declared = []
  for (const [provider, info] of routes) {
    const apiKeyEnv = info?.apiKeyEnv ?? '-'
    const baseURL = info?.baseURL ?? '-'
    const models = info?.models ?? []
    if (name === process.argv[2]) {
      console.log(`${provider}:  apiKeyEnv=${apiKeyEnv}  baseURL=${baseURL}`)
      console.log(`   models (${models.length}): ${models.join(', ') || '(from the pi-ai catalog)'}`)
    }
    for (const model of models) declared.push(`${provider}/${model}`)
  }
  return declared
}

/**
 * The credential references the profile's plugin declares.
 *
 * @param name - the profile to read.
 * @returns the environment variable names the profile's providers read.
 */
export function profileCredentialRefs(name) {
  const file = join(homedir(), '.dsh', 'profiles', name, 'cordis.patch.yml')
  const text = readFileSync(file, 'utf8')
  const refs = new Set()
  let current
  for (const line of text.split(/\r?\n/)) {
    const provider = /^ {6}([a-z0-9_-]+):\s*$/.exec(line)
    if (provider) {
      current = provider[1]
      continue
    }
    if (current === undefined) continue
    const key = /apiKeyEnv:\s*(\S+)/.exec(line)
    if (key) refs.add(key[1])
  }
  return [...refs]
}

const declared = profileRoutes(profile)
if (process.argv[1]?.endsWith('read-profile-models.mjs')) {
  console.log(`routes: ${declared.length}`)
}
