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

test('a tool result carries the tool output, not the Pi envelope', async () => {
  const { session, rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'read a.ts'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')

  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  rpc.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'reading' }], provider: 'anthropic', model: 'claude-x' } })
  rpc.emit({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read', args: { path: 'a.ts' } })
  rpc.emit({
    type: 'tool_execution_end',
    toolCallId: 'call_1',
    toolName: 'read',
    result: { content: [{ type: 'text', text: 'file body' }], details: {} },
    isError: false,
  })
  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()

  const result = session.last('tool/result')
  assert.ok(result, 'a tool/result event was recorded')
  // DSH's ToolResultMessage carries the model-facing blocks directly and
  // names the call it answers.
  const message = result.data.message
  assert.equal(message.toolCallId, 'call_1')
  assert.equal(message.isError, false)
  assert.deepEqual(message.content, [{ type: 'text', text: 'file body' }])
  agent.dispose()
})

test('a streamed tool call carries the id announced by toolcall_start', async () => {
  const { session, rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'read a.ts'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')

  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call_1', toolName: 'read' } })
  rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":' } })
  rpc.emit({ type: 'message_end', message: { role: 'assistant', content: [], provider: 'anthropic', model: 'claude-x' } })
  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()

  // The assistant message embeds the compact provider stream.
  const message = session.last('assistant/message')
  assert.ok(message, 'an assistant/message event was recorded')
  const records = message.data.stream
  assert.equal(records.length, 1)
  assert.equal(records[0].type, 'tool-call-chunks')
  assert.equal(records[0].id, 'call_1')
  assert.equal(records[0].name, 'read')
  assert.deepEqual(records[0].args, ['{"path":'])
  agent.dispose()
})

test('agent_end alone does not settle the run', async () => {
  const { rpc, agent } = createAgent()
  let idle = false
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')
  void agent.whenIdle().then(() => { idle = true })

  rpc.emit({ type: 'agent_end', messages: [], willRetry: true })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(idle, false, 'the turn is still open after agent_end')

  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()
  assert.equal(idle, true)
  agent.dispose()
})

test('a disposed Pi child settles the turn instead of hanging', async () => {
  const { session, rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')
  rpc.exit({ code: 1, signal: null })
  await agent.whenIdle()
  const turnEnd = session.last('turn/end')
  assert.ok(turnEnd, 'the turn closed')
  assert.equal(turnEnd.data.reason.kind, 'error')
  agent.dispose()
})

test('the consumed prompt is claimed, never discarded', async () => {
  const { session, rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')
  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()

  const splices = session.ofType('agent/inbox/spliced')
  const removal = splices.find((event) => event.data.removedCount === 1)
  assert.ok(removal, 'the inbox recorded the removal')
  assert.equal(removal.data.outcome, undefined, 'a claimed message is not a cancellation')
  agent.dispose()
})

test('disposing the agent never writes a session/end-seed marker', async () => {
  const { session, agent } = createAgent()
  agent.dispose()
  assert.equal(session.ofType('session/end-seed').length, 0)
})

test('cancelling an idle agent does not swallow the next prompt', async () => {
  const { rpc, agent } = createAgent()
  agent.cancel({ kind: 'user' })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')
  assert.equal(rpc.prompts[0], 'hello')
  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()
  agent.dispose()
})

test('a pre-step rejection blocks the turn without prompting Pi', async () => {
  const { ctx, session, rpc, agent } = createAgent()
  ctx.on('agent/pre-step', (payload, next) => {
    void next
    return { kind: 'reject' }
  })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => session.ofType('turn/end').length > 0, 2000, 'the turn to close')

  assert.equal(rpc.prompts.length, 0, 'Pi was never prompted')
  const turnEnd = session.last('turn/end')
  assert.equal(turnEnd.data.reason.kind, 'blocked')
  assert.equal(session.ofType('step/start').length, 0, 'a blocked turn has no step')
  agent.dispose()
})

test('a handled prompt does not wait for a settle that never comes', async () => {
  const { session, agent } = createAgent({ rpc: { disposition: 'handled' } })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => session.ofType('turn/end').length > 0, 2000, 'the turn to close')
  assert.equal(session.last('turn/end').data.reason.kind, 'completed')
  agent.dispose()
})

test('the turn records the user message, the assistant message and the step', async () => {
  const { session, rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')

  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' } })
  rpc.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], provider: 'anthropic', model: 'claude-x', usage: { input: 10, output: 2 } } })
  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()

  assert.equal(session.ofType('turn/start').length, 1)
  assert.equal(session.ofType('step/start').length, 1)
  assert.equal(session.ofType('step/end').length, 1)
  assert.equal(session.ofType('user/message').length, 1)
  const assistant = session.last('assistant/message')
  assert.equal(assistant.data.message.content[0].text, 'hi')
  assert.equal(assistant.data.usage.inputTokens, 10)
  agent.dispose()
})

test('a resumed agent continues the session turn sequence', async () => {
  const ctx = new Context()
  const session = new FakeSession('session-1')
  const rpc = new FakeRpc()
  // A session resumed on turn 30 must open turn 31: reopening turn 1 is a
  // boundary the durable log rejects.
  const agent = new PiAgent({
    ctx,
    session,
    agentOptions: {},
    rpc,
    lastTurn: 30,
  })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')
  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  rpc.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], provider: 'anthropic', model: 'claude-x' } })
  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()

  assert.equal(session.last('turn/start').data.turn, 31)
  assert.equal(session.last('turn/end').data.turn, 31)
  agent.dispose()
})

test('a failed model call fails the turn instead of answering with nothing', async () => {
  const { ctx, session, rpc, agent } = createAgent()
  const errors = []
  ctx.on('agent/error', (payload) => { errors.push(payload.error) })

  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')

  // The provider refused the call: Pi reports it as an assistant message
  // with an empty content and a stop reason of `error`.
  rpc.emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      provider: 'anthropic',
      model: 'claude-x',
      stopReason: 'error',
      errorMessage: 'context window exceeds limit',
    },
  })
  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()

  assert.equal(session.ofType('assistant/message').length, 0, 'no empty answer is recorded')
  assert.equal(session.last('turn/end').data.reason.kind, 'error')
  assert.match(session.last('turn/end').data.reason.error.message, /context window exceeds limit/)
  assert.equal(errors.length, 1, 'the failure is reported at its live boundary')
  agent.dispose()
})

test('a model error is reported even when the run settles first', async () => {
  const { session, rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')
  rpc.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [], provider: 'anthropic', model: 'claude-x', stopReason: 'error', errorMessage: 'boom' },
  })
  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()
  assert.equal(session.last('turn/end').data.reason.kind, 'error')
  agent.dispose()
})

test('a second assistant message opens a second step', async () => {
  const { session, rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')

  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  rpc.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'one' }], provider: 'anthropic', model: 'claude-x' } })
  rpc.emit({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'read', args: {} })
  rpc.emit({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: 'read', result: { content: [{ type: 'text', text: 'body' }] }, isError: false })
  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  rpc.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], provider: 'anthropic', model: 'claude-x' } })
  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()

  assert.equal(session.ofType('step/start').length, 2)
  assert.equal(session.ofType('step/end').length, 2)
  // The tool call belongs to the first step.
  const call = session.last('tool/call')
  assert.equal(call.data.step, 1)
  agent.dispose()
})

test('the assistant frames carry a dense monotone revision', async () => {
  const { ctx, rpc, agent } = createAgent()
  const frames = []
  ctx.on('agent/assistant-stream', (payload) => { frames.push(payload.frame) })

  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')
  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' } })
  rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' there' } })
  rpc.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }], provider: 'anthropic', model: 'claude-x' } })
  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()

  assert.deepEqual(frames.map(frame => frame.type), ['start', 'chunk', 'chunk', 'end'])
  // DSH's session controller keeps only a frame whose revision is the
  // successor of the last one it accepted: a gap drops the live stream.
  assert.deepEqual(frames.map(frame => frame.revision), [1, 2, 3, 4])
  // The chunk index is dense and zero-based within the attempt.
  assert.deepEqual(frames.filter(frame => frame.type === 'chunk').map(frame => frame.index), [0, 1])
  assert.equal(frames.at(-1).index, 2, 'the end frame counts the chunk frames')
  agent.dispose()
})

test('a refused model route fails the turn instead of running Pi anyway', async () => {
  const { session, rpc, agent } = createAgent({
    rpc: { readyError: new Error('pi set_model failed for "bogus/model"') },
  })
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => session.ofType('turn/end').length > 0, 2000, 'the turn to close')

  assert.equal(rpc.prompts.length, 0, 'Pi was never prompted')
  const turnEnd = session.last('turn/end')
  assert.equal(turnEnd.data.reason.kind, 'error')
  assert.match(turnEnd.data.reason.error.message, /set_model failed/)
  agent.dispose()
})

test('a failed run still closes the step', async () => {
  const { session, rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')
  rpc.exit({ code: 1, signal: null })
  await agent.whenIdle()

  assert.equal(session.ofType('step/start').length, 1)
  assert.equal(session.ofType('step/end').length, 1, 'the step closes even when the run failed')
  agent.dispose()
})

test('a model selection does not reach the child', async () => {
  // The Pi agent has a model of its own: the DSH session's selection is the
  // session's record, not the child's route.
  const { rpc, agent } = createAgent()
  agent.model.select({ provider: 'zai', model: 'glm-5.3-flash' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(
    rpc.commands.some((command) => command.type === 'set_model'),
    false,
    'the child keeps the route its own configuration names',
  )
  agent.dispose()
})

test('the child events that arrive after the turn open no step', async () => {
  // A turn that ends in an error leaves the child running. Its next message
  // must not open a step: a `step/start` outside a turn is a corrupt log.
  const { session, rpc, agent } = createAgent()
  rpc.neverAnswers = true
  agent.send(userMessage('m1', 'hello'), 'next-turn', true)
  await agent.whenIdle()

  const turns = session.ofType('turn/end')
  assert.equal(turns.length, 1, 'the turn ended')
  assert.equal(turns[0].data.reason.kind, 'error', 'the turn ended with the failure')

  // The child answers late, after the turn is over.
  rpc.emit({ type: 'message_start', message: { role: 'assistant' } })
  rpc.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] } })

  const starts = session.ofType('step/start')
  assert.equal(starts.length, 1, 'only the turn that ran opened a step')
  agent.dispose()
})
