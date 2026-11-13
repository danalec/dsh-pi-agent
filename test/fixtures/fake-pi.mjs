/**
 * A stand-in for the `pi` binary: it speaks the JSONL RPC protocol on
 * stdin/stdout so the client can be exercised without a model or a network.
 *
 * Usage: `node fake-pi.mjs [--mode rpc] ...`
 */
import { createInterface } from 'node:readline'

const respond = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  if (line.trim() === '') return
  let command
  try {
    command = JSON.parse(line)
  } catch {
    respond({ type: 'response', command: 'parse', success: false, error: 'invalid json' })
    return
  }
  const { id, type } = command
  if (type === 'prompt') {
    respond({ id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
    respond({ type: 'agent_start' })
    respond({ type: 'message_start', message: { role: 'assistant', content: [] } })
    respond({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello' } })
    respond({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], provider: 'anthropic', model: 'claude-x', stopReason: 'stop' } })
    respond({ type: 'agent_end', messages: [], willRetry: false })
    respond({ type: 'agent_settled', aborted: false })
    return
  }
  if (type === 'set_model') {
    respond({ id, type: 'response', command: 'set_model', success: true, data: { id: command.modelId } })
    return
  }
  if (type === 'never_answer') {
    // Deliberately silent: exercises the client's response timeout.
    return
  }
  respond({ id, type: 'response', command: type, success: true })
})

rl.on('close', () => process.exit(0))
