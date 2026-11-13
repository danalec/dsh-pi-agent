import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { PiAgent } from '../dist/pi-agent.js'
import { FakeRpc, FakeSession, waitFor } from './helpers.mjs'

function createAgent(options = {}) {
  const ctx = new Context()
  const session = new FakeSession(options.sessionId ?? 'session-1')
  const rpc = new FakeRpc(options.rpc)
  const agent = new PiAgent({
    ctx,
    session,
    agentOptions: options.agentOptions ?? {},
    rpc,
  })
  return { ctx, session, rpc, agent }
}

function userMessage(id, text) {
  return { id, role: 'user', content: [{ type: 'text', text }] }
}

/** Drive one complete Pi run: an assistant message and the settlement. */
async function runOnce(rpc, text = 'answer') {
  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } })
  rpc.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], provider: 'anthropic', model: 'claude-x' } })
  rpc.emit({ type: 'agent_settled', aborted: false })
}

test('each turn numbers its steps from one', async () => {
  const { session, rpc, agent } = createAgent()

  agent.send(userMessage('m1', 'first'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the first prompt')
  await runOnce(rpc)
  await agent.whenIdle()

  agent.send(userMessage('m2', 'second'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 1, 2000, 'the second prompt')
  await runOnce(rpc)
  await agent.whenIdle()

  const starts = session.ofType('step/start')
  assert.equal(starts.length, 2)
  assert.equal(starts[0].data.step, 1)
  assert.equal(starts[1].data.step, 1, 'a new driver restarts the step sequence')
  assert.equal(starts[0].data.turn, 1)
  assert.equal(starts[1].data.turn, 2)
  agent.dispose()
})

test('a steering message reaches the running loop exactly once', async () => {
  const { session, rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'start'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')

  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  agent.steer(userMessage('m2', 'actually do this'))
  await waitFor(() => rpc.commands.some((command) => command.type === 'steer'), 2000, 'the steer command')

  await runOnce(rpc, 'done')
  await agent.whenIdle()

  const steers = rpc.commands.filter((command) => command.type === 'steer')
  assert.equal(steers.length, 1, 'the steer was delivered once')
  assert.equal(steers[0].message, 'actually do this')

  // The steered message is recorded on the durable surface exactly once.
  const userMessages = session.ofType('user/message')
  const texts = userMessages.map((event) => event.data.content[0].text)
  assert.deepEqual(texts, ['start', 'actually do this'])
  agent.dispose()
})

test('a turn-stopping listener can steer into another step', async () => {
  const { ctx, session, rpc, agent } = createAgent()
  let steered = false
  ctx.on('agent/turn-stopping', () => {
    // A listener that always steers would keep the turn open forever: it
    // objects once, then lets the turn close.
    if (steered) return
    steered = true
    agent.steer(userMessage('m2', 'one more thing'))
  })

  agent.send(userMessage('m1', 'start'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the first prompt')
  await runOnce(rpc, 'done')
  await waitFor(() => rpc.prompts.length > 1, 2000, 'the follow-up prompt')

  await runOnce(rpc, 'more')
  await agent.whenIdle()

  assert.equal(rpc.prompts.length, 2)
  assert.equal(rpc.prompts[1], 'one more thing')
  assert.equal(session.ofType('turn/start').length, 1, 'the follow-up stayed in the same turn')
  agent.dispose()
})

test('an injected message waits for the next step boundary', async () => {
  const { rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'start'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')

  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  agent.inject(userMessage('m2', 'extra context'))
  // The injection is delivered when Pi finishes the assistant turn.
  rpc.emit({ type: 'turn_end', message: { role: 'assistant' } })
  await waitFor(() => rpc.commands.some((command) => command.type === 'steer'), 2000, 'the injected context')

  await runOnce(rpc, 'done')
  await agent.whenIdle()
  const steers = rpc.commands.filter((command) => command.type === 'steer')
  assert.equal(steers.length, 1)
  assert.equal(steers[0].message, 'extra context')
  agent.dispose()
})
