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
  // DSH's ToolResultMessage carries one tool-result block; its content holds
  // the model-facing blocks.
  const block = result.data.message.content[0]
  assert.equal(block.type, 'tool-result')
  assert.equal(block.toolCallId, 'call_1')
  assert.deepEqual(block.content, [{ type: 'text', text: 'file body' }])
  agent.dispose()
})

test('a streamed tool call carries the id announced by toolcall_start', async () => {
  const { session, rpc, agent } = createAgent()
  agent.send(userMessage('m1', 'read a.ts'), 'next-turn', true)
  await waitFor(() => rpc.prompts.length > 0, 2000, 'the prompt')

  rpc.emit({ type: 'message_start', message: { role: 'assistant', content: [] } })
  rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'call_1', toolName: 'read' } })
  rpc.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"path":' } })
  rpc.emit({ type: 'agent_settled', aborted: false })
  await agent.whenIdle()

  const chunk = session.last('assistant/chunk')
  assert.ok(chunk, 'an assistant/chunk event was recorded')
  assert.equal(chunk.data.chunk.type, 'tool-call-delta')
  assert.equal(chunk.data.chunk.id, 'call_1')
  assert.equal(chunk.data.chunk.name, 'read')
  assert.equal(chunk.data.chunk.argumentsDelta, '{"path":')
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
  const { session, rpc, agent } = createAgent({ rpc: { disposition: 'handled' } })
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
