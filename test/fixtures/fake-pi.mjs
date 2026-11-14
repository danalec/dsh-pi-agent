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

/** Whether the stand-in is busy, the way a running agent is. */
let processing = false

/**
 * The dialog an extension would open: Pi blocks until the client answers.
 *
 * The stand-in reports the answer it received on stdout, so a test can see
 * what the client did with the request.
 */
const askDialog = () => {
  respond({ type: 'extension_ui_request', id: 'dialog-1', method: 'confirm', title: 'Allow?', message: 'Allow it?' })
}

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
    // Pi refuses a prompt that arrives while it is processing, unless the
    // command says what to do with it.
    if (command.streamingBehavior === undefined && processing) {
      respond({
        id,
        type: 'response',
        command: 'prompt',
        success: false,
        error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
      })
      return
    }
    respond({ id, type: 'response', command: 'prompt', success: true, data: { disposition: processing ? 'queued' : 'started' } })
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
  if (type === 'set_thinking_level') {
    respond({ id, type: 'response', command: 'set_thinking_level', success: true, data: { level: command.level } })
    return
  }
  if (type === 'busy') {
    processing = true
    respond({ id, type: 'response', command: 'busy', success: true })
    return
  }
  if (type === 'idle') {
    processing = false
    respond({ id, type: 'response', command: 'idle', success: true })
    return
  }
  if (type === 'never_answer') {
    // Deliberately silent: exercises the client's response timeout.
    return
  }
  if (type === 'ask_dialog') {
    askDialog()
    respond({ id, type: 'response', command: 'ask_dialog', success: true })
    return
  }
  if (type === 'extension_ui_response') {
    respond({ type: 'extension_ui_answered', payload: command })
    return
  }
  respond({ id, type: 'response', command: type, success: true })
})

rl.on('close', () => process.exit(0))
