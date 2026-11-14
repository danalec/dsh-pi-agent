/**
 * Add the DSH profile's gateway routes to the Pi model configuration.
 *
 * The DSH profile configures its providers through `dsh-llm-pi-ai`, the
 * adapter over Pi's own model registry. A route that names a gateway of its
 * own (`tencent`, `litellm`) has no Pi provider, and the Pi child refuses
 * the model — "Model not found" — until the endpoint is declared here.
 *
 * The declaration mirrors the DSH route: same base URL, same wire protocol,
 * same model ids. The credential is read from the environment, so no key is
 * written to disk.
 *
 * usage: node tools/sync-pi-providers.mjs [profile]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const profile = process.argv[2] ?? 'desktop'
const patchFile = join(homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml')
const modelsFile = join(homedir(), '.pi', 'agent', 'models.json')

if (!existsSync(patchFile)) {
  console.error('profile patch not found:', patchFile)
  process.exit(1)
}

const patch = readFileSync(patchFile, 'utf8')
const block = patch.slice(patch.indexOf('- id: llm-pi-ai'), patch.indexOf('\n- id: ', patch.indexOf('- id: llm-pi-ai') + 10))

/** The gateways of the profile: a provider with a base URL of its own. */
const gateways = new Map()
let current = undefined
for (const line of block.split('\n')) {
  const provider = /^ {6}([a-z0-9_-]+):\s*$/.exec(line)
  if (provider) {
    current = provider[1]
    gateways.set(current, {})
    continue
  }
  if (current === undefined) continue
  const info = gateways.get(current)
  const apiKey = /apiKeyEnv:\s*(\S+)/.exec(line)
  if (apiKey) info.apiKeyEnv = apiKey[1]
  const api = /^\s+api:\s*(\S+)\s*$/.exec(line)
  if (api) info.api = api[1]
  const baseURL = /baseURL:\s*(\S+)/.exec(line)
  if (baseURL) info.baseURL = baseURL[1]
  const model = /^\s+- id:\s*(\S+)\s*$/.exec(line)
  if (model) {
    info.models ??= []
    info.models.push(model[1])
  }
}

/** The providers Pi already ships: their name is their route. */
const config = existsSync(modelsFile) ? JSON.parse(readFileSync(modelsFile, 'utf8')) : { providers: {} }
config.providers ??= {}

let added = 0
for (const [name, info] of gateways) {
  if (info.baseURL === undefined || info.api === undefined) continue
  if (config.providers[name] !== undefined) {
    console.log(`keep    ${name}: already declared in models.json`)
    continue
  }
  config.providers[name] = {
    name,
    baseUrl: info.baseURL,
    api: info.api,
    // The credential comes from the environment; no key is written to disk.
    apiKey: info.apiKeyEnv === undefined ? undefined : `$${info.apiKeyEnv}`,
    models: (info.models ?? []).map(id => ({ id })),
  }
  added += 1
  console.log(`add     ${name}: ${info.baseURL} (${info.api}) — ${(info.models ?? []).length} models`)
}

if (added === 0) {
  console.log('nothing to add')
} else {
  writeFileSync(modelsFile, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`written: ${modelsFile}`)
}
