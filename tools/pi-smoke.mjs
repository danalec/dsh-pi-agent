/**
 * Smoke test: drive the real `pi` binary through the plugin's RPC client.
 *
 * usage: node tools/pi-smoke.mjs [model]
 */
import { PiRpcClient } from '../dist/rpc-client.js'

const model = process.argv[2] ?? 'minimax/MiniMax-M3.1-Flash-Preview'
const cwd = process.argv[3] ?? 'C:/Users/danalec'

const rpc = new PiRpcClient({
  cwd,
  model,
  piPath: 'C:/Users/danalec/.pi/agent/bin/pi.cmd',
  logger: line => console.log('[pi]', line),
})

const events = []
rpc.onEvent(event => {
  events.push(event)
  const type = event.type
  if (type === 'message_update') {
    const inner = event.assistantMessageEvent
    if (inner?.type === 'text_delta') console.log('  delta:', JSON.stringify(inner.delta ?? inner.text ?? ''))
    else if (inner?.type === 'thinking_delta') console.log('  thinking:', JSON.stringify(inner.delta ?? ''))
    else console.log('  update:', inner?.type)
  } else if (type === 'message_end') {
    console.log('  message_end role=', event.message?.role, 'provider=', event.message?.provider, 'model=', event.message?.model)
  } else {
    console.log('  event:', type)
  }
})

console.log('waiting for the child to accept the model route...')
try {
  await rpc.ready
  console.log('model route accepted')
} catch (error) {
  console.error('model route refused:', String(error))
  rpc.close()
  process.exit(1)
}

console.log('prompting...')
const disposition = await rpc.prompt('Reply with exactly: pi-rpc-ok')
console.log('disposition:', disposition)

if (disposition !== 'handled') {
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error('TIMEOUT waiting for agent_settled')
      resolve()
    }, 120000)
    rpc.onEvent(event => {
      if (event.type === 'agent_settled') {
        clearTimeout(timer)
        console.log('settled after', events.length, 'events')
        resolve()
      }
    })
  })
}

rpc.close()
