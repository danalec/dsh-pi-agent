/**
 * Test doubles for the DSH session and the Pi RPC client.
 *
 * The session double records the durable log exactly like `dsh-session` does
 * (seq/time/data plus the surface metadata), so the agent's translation can
 * be asserted on the real event vocabulary.
 */

/** A minimal `Session` stand-in that records every appended event. */
export class FakeSession {
  constructor(id = 'session-1', header = {}) {
    this.id = id
    this.header = { version: 1, id, createdAt: Date.now(), seedLength: 0, cwd: '/tmp/project', ...header }
    this.events = []
    this.inheritedEventCount = 0
  }

  append(type, data, opts) {
    const seq = this.events.length
    const time = Date.now()
    const event = { type, seq, time, data }
    if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp
    if (opts?.sourceEventSeqs !== undefined) event.sourceEventSeqs = opts.sourceEventSeqs
    this.events.push(event)
    return event
  }

  /** The session log after the fork-inherited prefix. */
  snapshotEvents(from = 0) {
    return this.events.slice(from)
  }

  get seq() {
    return this.events.length
  }

  /** Every event of one type. */
  ofType(type) {
    return this.events.filter((event) => event.type === type)
  }

  /** The last event of one type. */
  last(type) {
    const matching = this.ofType(type)
    return matching[matching.length - 1]
  }
}

/**
 * A `PiRpcClient` stand-in that records commands and lets the test push Pi
 * events back into the agent.
 */
export class FakeRpc {
  constructor(options = {}) {
    this.eventListeners = new Set()
    this.exitListeners = new Set()
    this.prompts = []
    this.commands = []
    this.aborted = false
    this.closed = false
    this.ready = Promise.resolve()
    this.disposition = options.disposition ?? 'started'
    this.steerSucceeds = options.steerSucceeds ?? true
  }

  onEvent(listener) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onExit(listener) {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  /** Push one Pi event into the agent. */
  emit(event) {
    for (const listener of [...this.eventListeners]) listener(event)
  }

  /** Push the child-process exit into the agent. */
  exit(info = { code: 0, signal: null }) {
    for (const listener of [...this.exitListeners]) listener(info)
  }

  async prompt(message) {
    this.prompts.push(message)
    return this.disposition
  }

  async send(command) {
    this.commands.push(command)
    return {
      type: 'response',
      command: command.type,
      success: command.type === 'steer' ? this.steerSucceeds : true,
    }
  }

  async abort() {
    this.aborted = true
  }

  close() {
    this.closed = true
  }
}

/** Poll until `predicate` holds, or fail after `timeoutMs`. */
export async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Let the microtask queue drain. */
export function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
