/**
 * Test which model routes the Pi child accepts.
 *
 * The DSH profile configures several providers; the Pi child has its own
 * provider registry. This probe loads the DSH credentials into the
 * environment and asks Pi, for each route, to set the model and answer one
 * trivial question. The report names the routes that work and the ones the
 * child refuses.
 *
 * usage: node tools/probe-models.mjs [route ...]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawnPi } from '../dist/spawn.js'
import { createInterface } from 'node:readline'
import { loadDshCredentials } from './dsh-credentials.mjs'

const loaded = loadDshCredentials()
console.log(`credentials loaded: ${loaded.join(', ')}`)
console.log('')

/** The routes to test: provider/model. */
const routes = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : [
      'minimax/MiniMax-M3.1-Flash',
      'minimax/MiniMax-M3',
      'zai/glm-5.3-highspeed',
      'zai/glm-5.3-flash',
      'mistral/mistral-large-4',
      'mistral/mistral-medium-2604',
      'qwen-token-plan/qwen3.8-max',
      'deepseek/deepseek-v4-pro',
      'kimi-coding/kimi-k2.5',
      'moonshotai/kimi-k2.5',
      'xiaomi-token-plan-cn/mimo-v2.5',
      'openrouter/deepseek/deepseek-chat',
      'litellm/deepseek-v4-pro',
      'tencent/hy4',
    ]

/** Ask Pi to use one route and answer one trivial question. */
function test(route) {
  const [provider, ...rest] = route.split('/')
  const modelId = rest.join('/')
  return new Promise((resolve) => {
    const child = spawnPi('C:/Users/danalec/.pi/agent/bin/pi.cmd', ['--mode', 'rpc', '--no-session'], {
      cwd: 'C:/Users/danalec',
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let setModelError = null
    let answer = null
    let failure = null
    let settled = false
    const rl = createInterface({ input: child.stdout })
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdin.end() } catch {}
      setTimeout(() => { try { child.kill() } catch {} }, 200)
      resolve(result)
    }
    rl.on('line', (line) => {
      let record
      try { record = JSON.parse(line) } catch { return }
      if (record.type === 'response' && record.command === 'set_model' && !record.success) {
        setModelError = String(record.error ?? 'unknown error').slice(0, 120)
        return
      }
      if (record.type === 'message_end' && record.message?.role === 'assistant') {
        if (record.message.stopReason === 'error') {
          failure = String(record.message.errorMessage ?? 'error').slice(0, 120)
        } else {
          answer = (record.message.content ?? []).map(c => c.text ?? '').join('').slice(0, 30)
        }
      }
      if (record.type === 'agent_settled') {
        finish({ route, setModelError, answer, failure })
      }
    })
    const timer = setTimeout(() => finish({ route, setModelError, answer, failure: failure ?? 'timeout' }), 90000)
    child.stdin.write(`${JSON.stringify({ type: 'set_model', provider, modelId, id: 'm' })}\n`)
    child.stdin.write(`${JSON.stringify({ type: 'prompt', message: 'Reply with exactly: OK', id: 'p' })}\n`)
  })
}

for (const route of routes) {
  const result = await test(route)
  const verdict = result.setModelError !== null
    ? `set_model refused: ${result.setModelError}`
    : result.answer !== null
      ? `OK ${JSON.stringify(result.answer)}`
      : `FAILED ${result.failure}`
  console.log(`${route.padEnd(46)} ${verdict}`)
}
