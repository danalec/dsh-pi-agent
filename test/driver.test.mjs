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
  // Pi injects the steering before it answers: the echo comes first.
  await waitFor(() => rpc.echoed.includes('actually do this'), 2000, 'the steering echo')

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

test('an injected message reaches the running loop while Pi is streaming', async () => {
  const { rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'start'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')

  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  agent.inject(userMessage('m2', 'extra context'))
  // Pi is waiting for the provider while it streams: the injection is
  // handed over right away, so it reaches the boundary Pi takes after the
  // current model call. Waiting for `turn_end` would be too late — Pi polls
  // its steering queue right after that event.
  rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'thinking' } })
  await waitFor(() => rpc.commands.some((command) => command.type === 'steer'), 2000, 'the injected context')
  await waitFor(() => rpc.echoed.includes('extra context'), 2000, 'the injection echo')

  await runOnce(rpc, 'done')
  await agent.whenIdle()
  const steers = rpc.commands.filter((command) => command.type === 'steer')
  assert.equal(steers.length, 1)
  assert.equal(steers[0].message, 'extra context')
  agent.dispose()
})

test('an empty message still asks the model to continue', async () => {
  const { session, rpc, agent } = createAgent()
  // DSH's "continue generation" sends an empty user message: the model is
  // asked to pick the generation up again.
  agent.send({ id: 'm1', role: 'user', content: [] }, 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')
  assert.equal(rpc.prompts[0], '', 'the empty prompt still reaches Pi')

  await runOnce(rpc, 'continued')
  await agent.whenIdle()
  assert.equal(session.ofType('step/start').length, 1, 'the continuation opened a step')
  assert.equal(session.last('assistant/message').data.message.content[0].text, 'continued')
  agent.dispose()
})

test('a failing inbox never rejects in the background', async () => {
  // A rejected promise nobody awaits ends the Node process, and the DSH host
  // runs this driver: the application would crash with the session open.
  const rejections = []
  const onRejection = (reason) => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  try {
    const { session } = createAgent()
    // The session refuses every write from now on: the stranded steering
    // cannot be recovered.
    let broken = false
    const brokenSession = new Proxy(session, {
      get(target, property, receiver) {
        if (property === 'append') {
          return (...args) => {
            if (broken) throw new Error('the session log is closed')
            return Reflect.get(target, property, receiver).apply(target, args)
          }
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const brokenRpc = new FakeRpc({ echoSteering: false })
    const agent2 = new PiAgent({
      ctx: new Context(),
      session: brokenSession,
      agentOptions: {},
      rpc: brokenRpc,
    })
    agent2.send(userMessage('m1', 'start'), 'next-turn', true)
    await waitFor(() => brokenRpc.prompts.length > 0, 2000, 'the prompt')
    brokenRpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
    agent2.steer(userMessage('m2', 'steered'))
    await waitFor(
      () => brokenRpc.commands.some((command) => command.type === 'steer'),
      2000,
      'the steer command',
    )
    // The log breaks while the steering is still in flight.
    broken = true
    brokenRpc.emit({ type: 'agent_settled', aborted: false })
    await agent2.whenIdle()
    // Give the background work a chance to reject.
    await new Promise(resolve => setTimeout(resolve, 100))
    agent2.dispose()
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  assert.deepEqual(rejections.map(String), [], 'no rejection escaped into the process')
})

test('a steering Pi never injects is recovered instead of lost', async () => {
  const { session, rpc, agent } = createAgent({ rpc: { echoSteering: false } })
  agent.send(userMessage('m1', 'start'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')

  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  agent.steer(userMessage('m2', 'never injected'))
  await waitFor(() => rpc.commands.some((command) => command.type === 'steer'), 2000, 'the steer command')

  // Pi settles without injecting the steering: the message must not vanish.
  rpc.emit({ type: 'agent_settled', aborted: false })
  await waitFor(() => rpc.prompts.length > 1, 2000, 'the recovered prompt')
  assert.equal(rpc.prompts[1], 'never injected', 'the steering is delivered as a step of its own')
  assert.ok(
    rpc.commands.some((command) => command.type === 'clear_queue'),
    "Pi's copy of the stranded steering is cleared, so it is not delivered twice",
  )
  const userMessages = session.ofType('user/message')
  assert.equal(userMessages.length, 2, 'the recovered message is recorded exactly once')
  agent.dispose()
})
