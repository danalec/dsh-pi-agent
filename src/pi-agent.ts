/**
 * PiAgent — a DSH `Agent` implementation whose driver is the Pi coding agent
 * loop running headless in a child process (`pi --mode rpc`).
 *
 * DSH's frontend, session log, and hooks program against the `Agent`
 * interface (`@deepseek-ai/dsh-agent`); this class satisfies that contract and
 * translates Pi's RPC event stream into DSH's durable session events
 * (`turn/*`, `step/*`, `user/message`, `assistant/chunk`,
 * `assistant/message`, `tool/call`, `tool/result`).
 *
 * ## Boundary mapping
 *
 * | DSH | Pi |
 * | --- | --- |
 * | one turn | one `prompt` command (one Pi run) |
 * | one step | one assistant message (one model call + its tool executions) |
 * | step boundary | Pi's `turn_end` event (the assistant turn finished) |
 * | next-step input | Pi's `steer` command (delivered before the next LLM call) |
 *
 * The driver follows `@deepseek-ai/dsh-agent-loop`'s phase model: a single
 * `idle | running | maintenance` phase owns the abort controller, the wake
 * latch, and the activity promise that `whenIdle()` follows.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import {
  agentEvents,
  type Agent,
  type AgentEventDispatch,
  type AgentOptions,
  type AgentStatus,
  type InboxTarget,
} from '@deepseek-ai/dsh-agent'
import {
  AssistantStreamAccumulator,
  createAssistantMessage,
  createToolResultMessage,
  LlmAttemptId,
  ToolCallId,
  type AssistantStreamRecord,
  type ContentBlock,
  type StreamChunk,
  type TokenUsage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  AgentCancelCause,
  Session,
  SessionId,
  SessionSeq,
  TurnEndReason,
} from '@deepseek-ai/dsh-session'
import { PiInbox, type PiInboxNotifications } from './inbox.ts'
import { PiModel } from './model.ts'
import type { PiEvent, PiRpcClient } from './rpc-client.ts'

export interface PiAgentOptions {
  /** Base context whose dependency API the agent's own scope inherits. */
  ctx: Context
  session: Session
  agentOptions: AgentOptions
  rpc: PiRpcClient
  /**
   * The session's last turn number.
   *
   * A resumed agent continues the session's turn sequence: the next turn is
   * `lastTurn + 1`. Restarting at 1 would open a turn the session never
   * opened, and the durable log would reject the boundary.
   */
  lastTurn?: number
  /** Diagnostics sink. */
  logger?: (line: string) => void
}

/**
 * The agent's lifecycle phase.
 *
 * - `idle`: no driver and no maintenance task owns the agent;
 * - `running`: a driver owns the agent and drains turns;
 * - `maintenance`: a non-turn task owns the agent (public status stays idle).
 */
type Phase =
  | { kind: 'idle'; lastTurn: number }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }
  | { kind: 'maintenance'; abort: AbortController; lastTurn: number; wakeRequested: boolean }

/** Minimal deferred, kept local so the package still runs on Node 20. */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Map a Pi assistant content block to a DSH content block. */
function convertBlock(block: unknown): ContentBlock | undefined {
  if (!block || typeof block !== 'object') return undefined
  const record = block as { type?: string }
  switch (record.type) {
    case 'text': {
      const text = (block as { text?: unknown }).text
      return { type: 'text', text: typeof text === 'string' ? text : '' }
    }
    case 'thinking': {
      const thinking = (block as { thinking?: unknown }).thinking
      return { type: 'reasoning', text: typeof thinking === 'string' ? thinking : '' }
    }
    case 'toolCall': {
      const tool = block as { id?: unknown; name?: unknown; arguments?: unknown }
      const args = tool.arguments
      return {
        type: 'tool-call',
        id: ToolCallId(String(tool.id ?? '')),
        name: String(tool.name ?? ''),
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      }
    }
    default:
      return undefined
  }
}

/**
 * Convert Pi's tool outcome into DSH content blocks.
 *
 * Pi reports a tool result as `{content: [{type:'text', text}], details}`.
 * The DSH `tool/result` message carries the *content*, so the envelope must
 * be unwrapped — stringifying it would hand the model a JSON blob instead of
 * the tool's actual output.
 */
function convertToolResult(result: unknown): ContentBlock[] {
  if (typeof result === 'string') return [{ type: 'text', text: result }]
  if (!result || typeof result !== 'object') return [{ type: 'text', text: '' }]
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(result) }]
  const blocks: ContentBlock[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as { type?: string; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') {
      blocks.push({ type: 'text', text: record.text })
    } else if (record.type === 'image') {
      // DSH image blocks carry an attachment reference the Pi child cannot
      // provide; keep the payload as text so nothing is silently dropped.
      blocks.push({ type: 'text', text: JSON.stringify(block) })
    } else {
      blocks.push({ type: 'text', text: JSON.stringify(block) })
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }]
}

/** Map Pi's usage report onto DSH's token accounting. */
function convertUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as {
    input?: unknown
    output?: unknown
    cacheRead?: unknown
    cacheWrite?: unknown
    reasoning?: unknown
  }
  if (typeof record.input !== 'number' || typeof record.output !== 'number') return undefined
  return {
    inputTokens: record.input,
    outputTokens: record.output,
    ...(typeof record.cacheRead === 'number' ? { cacheReadTokens: record.cacheRead } : {}),
    ...(typeof record.cacheWrite === 'number' ? { cacheWriteTokens: record.cacheWrite } : {}),
    ...(typeof record.reasoning === 'number' ? { reasoningTokens: record.reasoning } : {}),
  }
}

/** Extract the text payload of a DSH UserMessage for the Pi prompt command. */
function extractDshText(message: UserMessage): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}

export class PiAgent implements Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session
  readonly inbox: PiInbox
  readonly model: PiModel
  readonly ctx: Context

  private readonly rpc: PiRpcClient
  private readonly scope: Scope
  private readonly dispatch: AgentEventDispatch
  private readonly disposeScope: () => void
  private readonly unwatch: () => void
  private readonly unwatchExit: () => void
  private readonly logger?: (line: string) => void

  private phase: Phase = { kind: 'idle', lastTurn: 0 }
  private activityDone: Promise<void> = Promise.resolve()
  private cancelCause: AgentCancelCause | undefined

  /** Run/settle bookkeeping. `settled` latches so a late event cannot be missed. */
  private settled = true
  private settleError: unknown = undefined
  private readonly settleWaiters: ((error: unknown) => void)[] = []
  private piRunning = false
  /** The failure of the last model call, when the provider refused it. */
  private modelError: Error | undefined

  /** Step bookkeeping. */
  private turn = 0
  private step = 0
  private stepOpen = false
  private assistantSeen = 0
  /** Compact provider stream of the assistant message currently being built. */
  private stream = new AssistantStreamAccumulator()
  /** Identity of the assistant attempt currently streaming. */
  private attemptId: LlmAttemptId | undefined
  /** Monotone revision of the assistant attempts of this agent. */
  private attemptRevision = 0
  /**
   * Monotone revision of the assistant frames of this agent lifecycle.
   *
   * DSH's session controller accepts an assistant frame only when its
   * revision is the successor of the last one it took (`revision + 1`), so
   * the revision is allocated per FRAME, not per attempt: a per-attempt
   * revision would make every chunk after the first one a gap, and the
   * controller would drop the whole live stream.
   */
  private frameRevision = 0
  /** Number of chunk frames published for the current attempt. */
  private chunkIndex = 0
  private readonly toolCallSeqs = new Map<string, SessionSeq>()
  private readonly toolCallNames = new Map<string, string>()
  /** Tool calls announced by `toolcall_start`, keyed by the content index. */
  private readonly pendingToolCalls = new Map<number, { id: string; name?: string }>()

  /**
   * Messages already delivered to Pi whose `user/message` event still has to
   * be written. They are flushed when the next step opens, so the durable
   * surface keeps the same order Pi's own context has.
   */
  private pendingSurface: UserMessage[] = []
  /**
   * Messages Pi refused to accept as steering. They ride along with the next
   * prompt so nothing is lost.
   */
  private pendingPrompt: UserMessage[] = []
  /**
   * Steering batches handed to Pi and not yet confirmed as delivered.
   *
   * Pi polls its steering queue at the step boundary, so a batch that arrives
   * after the last poll waits for the NEXT run — and the next run may never
   * come. The batch stays here until Pi echoes it back as an injected user
   * message; a run that settles without that echo hands the batch back to the
   * inbox, where the turn loop delivers it as a step of its own.
   */
  private steeringInFlight: { messages: UserMessage[] }[] = []
  /**
   * User messages Pi echoed during the current run.
   *
   * Pi echoes the prompt first and every steering message it injects after
   * it, so the second and later echoes are the steering deliveries.
   */
  private userEchoes = 0

  constructor(options: PiAgentOptions) {
    this.rpc = options.rpc
    this.logger = options.logger
    this.id = options.session.id
    this.options = options.agentOptions
    this.session = options.session
    // A resumed session continues its turn sequence; the next turn is the
    // next number, never 1 again.
    this.turn = options.lastTurn ?? 0
    this.phase = { kind: 'idle', lastTurn: this.turn }
    // DSH contract: each Agent owns a scope keyed by ITSELF (an object — the
    // scope key feeds WeakMaps downstream), and its ctx shadows `agent` with
    // an own property, so creation-window setup (`childCtx.agent`), prompt
    // assembly, and tools all resolve the live agent from its scoped context.
    this.scope = createScope(options.ctx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.disposeScope = () => void this.scope.dispose()
    this.inbox = new PiInbox(this.session, {
      inserted: (message) => this.dispatch.emit('agent/inbox/inserted', { message }),
      discarded: (message) => this.dispatch.emit('agent/inbox/discarded', { message }),
      claimed: (message, turn) => this.dispatch.emit('agent/inbox/claimed', { message, turn }),
    } satisfies PiInboxNotifications)
    // The model facade is driver-owned: it records a durable `model/selection`
    // and reads the recorded choice back, so the frontend's model switcher and
    // the session log agree on the route the next step will use. A selection
    // also reaches the child: the Pi child owns the route it runs on.
    this.model = new PiModel(this.session, this.options, (provider, model) => {
      void this.contain(() => this.rpc.setModel(provider, model))
    })
    this.dispatch = agentEvents(options.ctx, this)
    this.unwatch = this.rpc.onEvent((event) => this.onPiEvent(event))
    // A dead child must not leave the driver waiting forever: settle the
    // pending run with the exit reason so the turn can close.
    this.unwatchExit = this.rpc.onExit((info) => {
      this.markSettled(new Error(`pi process exited (code=${String(info.code)} signal=${String(info.signal)})`))
    })
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previous = this.status
    this.phase = next
    const status = this.status
    if (status !== previous) this.dispatch.emit('agent/status', { status })
  }

  // ---- Agent interface: message intake ----

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // A wake submitted after an active cancellation is queued for the next
    // turn instead of the aborted one.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget: InboxTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.append(resolvedTarget, message)
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    this.inbox.append('next-step', message)
    if (this.piRunning) {
      // Pi delivers a queued steer right before its next LLM call, which is
      // exactly DSH's "next step boundary". Delivering it here (instead of at
      // the boundary) is what makes the steer reach the running loop.
      void this.contain(() => this.deliverNextStepToPi())
      return
    }
    this.wakeDriver()
  }

  inject(message: UserMessage): void {
    // Queued for the next pre-step; it never wakes the driver on its own.
    this.inbox.append('next-step', message)
    if (this.piRunning) {
      // The driver is running, so the message belongs to the running loop's
      // next step boundary. Handing it to Pi now reaches the boundary Pi
      // takes after the current model call; leaving it in the inbox would
      // wait for the whole run to finish.
      void this.contain(() => this.deliverNextStepToPi())
    }
  }

  cancel(cause: AgentCancelCause, options?: { keepInbox?: boolean }): void {
    if (!options?.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind === 'idle') {
      // No active activity: cancellation is a no-op and must not arm later
      // work (DSH contract).
      return
    }
    this.cancelCause = cause
    this.phase.abort.abort(cause)
    void this.rpc.abort()
  }

  whenIdle(): Promise<void> {
    return this.followActivity()
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') {
      throw new Error(`agent "${this.id}" already has active work`)
    }
    const controller = new AbortController()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: controller,
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    const done = deferred<void>()
    this.activityDone = done.promise
    return (async () => {
      try {
        return await task(controller.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /** Resolve once no driver or maintenance task remains active. */
  private async followActivity(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  // ---- Driver ----

  /**
   * Start one driver, or latch the wake behind maintenance or an aborted
   * activity.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      const reason = this.phase.abort.signal.reason as { kind?: string } | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = deferred<void>()
    this.activityDone = driver.promise
    // A fresh driver starts a fresh step sequence; the turn counter keeps
    // running across drivers.
    this.step = 0
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.contain(() => this.kick()).then(driver.resolve, driver.reject)
  }

  /** Drain turns until the queue is empty. */
  private async kick(): Promise<void> {
    try {
      while (await this.runTurn()) {
        // keep draining queued turns in the same driver run
      }
    } catch {
      // Failures are reported at their live boundary (agent/error) and the
      // turn is closed with an error reason; the driver must not die here.
    } finally {
      if (this.phase.kind === 'running') {
        const { wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: this.turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  /**
   * Run one DSH turn: claim the pending input, propose the step, drive Pi, and
   * close the turn.
   *
   * @returns whether another turn should follow in the same driver run.
   */
  private async runTurn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      throw new Error(`agent "${this.id}": turn without driver reservation`)
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      this.session.append('turn/start', { turn })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    this.turn = turn
    let turnEnds: TurnEndReason = { kind: 'completed' }
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = this.step + 1
        const claimed = this.inbox.claim(target, turn)
        const carried = this.pendingPrompt.splice(0)
        const proposal = [...carried, ...claimed]
        const decision = await this.dispatch.waterfall(
          'agent/pre-step',
          {
            messages: proposal,
            turn,
            step,
            signal,
            modelSelection: this.model.current() ?? { provider: '', model: '' },
          },
          () => Promise.resolve({ kind: 'enter' as const, messages: proposal }),
        )
        signal.throwIfAborted()
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          break
        }
        const messages = decision.messages
        if (messages.length === 0) {
          turnEnds = { kind: 'completed' }
          break
        }

        this.openStep()
        for (const message of messages) {
          this.session.append('user/message', message, { surfaceOp: 'append' })
        }
        const promptText = messages.map(extractDshText).filter((text) => text !== '').join('\n')
        try {
          // Pi runs the model even for an empty prompt, and DSH's "continue
          // generation" is exactly that: an empty user message that asks the
          // model to pick the generation up again.
          await this.runPi(promptText)
        } finally {
          // The step closes even when the run failed: an open step without
          // its `step/end` leaves the durable log with a dangling boundary.
          this.closeStep()
        }

        signal.throwIfAborted()
        if (this.inbox.nextStep.length === 0) {
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: this.cancelCause ?? { kind: 'user' } }
        throw error
      }
      turnEnds = {
        kind: 'error',
        error: { message: error instanceof Error ? error.message : String(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      this.flushPendingSurface()
      try {
        this.session.append('turn/end', { turn, reason: turnEnds })
      } catch (error: unknown) {
        this.dispatch.emit('agent/error', { turn, step: this.step, error })
      }
    }
    // The carried messages are pending work too: a driver that stops with
    // them in hand leaves them waiting for the next wake.
    if (!this.inbox.hasPending && this.pendingPrompt.length === 0) return false
    phase.abort = new AbortController()
    phase.wakeRequested = false
    this.step = 0
    return true
  }

  /**
   * Report a failed model call.
   *
   * The failure is published at its live boundary (so the frontend shows it
   * right away) and kept, so the run throws and the turn closes with an
   * error reason instead of a completed turn holding an empty answer.
   *
   * @param detail - the provider's own error message, when Pi reported one.
   */
  private reportModelError(detail: unknown): void {
    const text = typeof detail === 'string' && detail !== '' ? detail : 'the model call failed'
    const error = new Error(text)
    this.modelError = error
    this.dispatch.emit('agent/error', { turn: this.turn, step: this.step, error })
  }

  /**
   * Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.turn
    const step = this.phase.kind === 'running' ? this.phase.step : this.step
    // A model failure is already published at its live boundary; the turn
    // boundary carries it from there.
    if (error !== this.modelError) {
      this.dispatch.emit('agent/error', { turn, step, error })
    }
    throw error
  }

  // ---- Pi run ----

  /** Send one prompt to Pi and wait until Pi reports the run settled. */
  private async runPi(promptText: string): Promise<void> {
    // A refused model route must fail loudly: `ready` settles when the
    // initial `set_model` was accepted or rejected. Awaiting it before the
    // first prompt is what turns "Pi refused the route" into a failed turn
    // instead of a silent run on Pi's own default model.
    await this.rpc.ready
    this.settled = false
    this.settleError = undefined
    this.assistantSeen = 0
    this.userEchoes = 0
    this.modelError = undefined
    this.piRunning = true
    try {
      const disposition = await this.rpc.prompt(promptText)
      if (disposition === 'handled') {
        // An extension command or input handler consumed the prompt: no run
        // started, so `agent_settled` will never arrive.
        this.markSettled()
        return
      }
      await this.waitSettled()
      // The provider refused the model call: the run throws, so the turn
      // closes with an error reason instead of a completed turn holding an
      // empty answer.
      if (this.modelError !== undefined) throw this.modelError
    } finally {
      this.piRunning = false
    }
  }

  private waitSettled(): Promise<void> {
    if (this.settled) {
      return this.settleError === undefined
        ? Promise.resolve()
        : Promise.reject(this.settleError)
    }
    return new Promise<void>((resolve, reject) => {
      this.settleWaiters.push((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }

  /** Latch the run as settled; later calls are no-ops. */
  private markSettled(error?: unknown): void {
    if (this.settled) return
    this.settled = true
    this.settleError = error
    const waiters = this.settleWaiters.splice(0)
    for (const waiter of waiters) waiter(error)
  }

  // ---- Step boundaries ----

  private openStep(): void {
    if (this.stepOpen) return
    this.step += 1
    this.stepOpen = true
    this.session.append('step/start', { turn: this.turn, step: this.step })
    this.flushPendingSurface()
  }

  private closeStep(): void {
    if (!this.stepOpen) return
    this.stepOpen = false
    this.session.append('step/end', { turn: this.turn, step: this.step })
  }

  /** Write the `user/message` events of already-delivered messages. */
  private flushPendingSurface(): void {
    if (this.pendingSurface.length === 0) return
    const messages = this.pendingSurface.splice(0)
    for (const message of messages) {
      this.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }

  /**
   * Hand the pending next-step input to the running Pi loop.
   *
   * Pi's `steer` command is delivered right before its next LLM call, which is
   * DSH's next step boundary. The claimed messages are remembered for the
   * durable surface; a refusal (Pi already settled) carries them into the
   * next prompt instead of dropping them.
   */
  private async deliverNextStepToPi(): Promise<void> {
    if (!this.piRunning) return
    let batch: UserMessage[]
    try {
      batch = this.inbox.claim('next-step', this.turn)
    } catch (error: unknown) {
      // The inbox could not be claimed (a disposed session, a broken log).
      // The input stays pending; the turn loop picks it up later.
      this.logger?.(`[pi-loop] could not claim the next-step input: ${String(error)}`)
      return
    }
    if (batch.length === 0) return
    const text = batch.map(extractDshText).filter((entry) => entry !== '').join('\n')
    if (text === '') {
      this.pendingSurface.push(...batch)
      return
    }
    try {
      const response = await this.rpc.send({ type: 'steer', message: text })
      if (!response.success) {
        throw new Error(response.error ?? 'unknown error')
      }
      // The batch is in flight: it is confirmed when Pi injects it, and
      // recovered when the run settles without that injection.
      this.steeringInFlight.push({ messages: batch })
    } catch (error: unknown) {
      this.logger?.(`[pi-loop] steer delivery failed: ${String(error)}`)
      this.pendingPrompt.push(...batch)
    }
  }

  /**
   * Confirm the oldest in-flight steering batch: Pi injected it.
   *
   * The message reached the model, so it belongs on the durable surface.
   */
  private confirmSteering(): void {
    const batch = this.steeringInFlight.shift()
    if (batch === undefined) return
    this.pendingSurface.push(...batch.messages)
  }

  /**
   * Recover the steering batches Pi never injected.
   *
   * Pi polls its steering queue at the step boundary, so a batch handed over
   * after the last poll waits for the NEXT run — and the next run may never
   * come. Pi's copy is taken back (the command stream is ordered, so the
   * `steer` this batch came from is processed before the `clear_queue` and is
   * cleared with it) and the batch returns to the inbox, where the turn loop
   * delivers it as a step of its own.
   */
  private async recoverStrandedSteering(): Promise<void> {
    const stranded = this.steeringInFlight.splice(0)
    if (stranded.length === 0) return
    try {
      // The clear is a courtesy: Pi answers it at once, and the short
      // timeout keeps the recovery from delaying the turn when it does not.
      await this.rpc.send({ type: 'clear_queue' }, 2000)
    } catch (error: unknown) {
      this.logger?.(`[pi-loop] could not clear the stranded steering queue: ${String(error)}`)
    }
    for (const batch of stranded) {
      try {
        for (const message of batch.messages) this.inbox.append('next-step', message)
      } catch (error: unknown) {
        this.logger?.(`[pi-loop] could not recover a stranded steering batch: ${String(error)}`)
      }
    }
  }

  /**
   * Settle the run, recovering the steering Pi never injected first.
   *
   * The recovery runs before the settle so the turn loop finds the recovered
   * messages in the inbox when it decides whether another step follows.
   */
  private async settleRun(): Promise<void> {
    try {
      await this.recoverStrandedSteering()
    } catch (error: unknown) {
      this.logger?.(`[pi-loop] the steering recovery failed: ${String(error)}`)
    } finally {
      this.markSettled()
    }
  }

  /**
   * Run a background action whose failure must never reach the process.
   *
   * A rejected promise nobody awaits is an unhandled rejection, and Node
   * ends the process on one. The DSH host runs this driver, so a rejection
   * that escaped here would kill the host with the session still open — the
   * application would crash and stop driving the sessions. Every background
   * action of this driver goes through this helper.
   */
  private contain(action: () => Promise<void>): Promise<void> {
    return action().catch((error: unknown) => {
      this.logger?.(`[pi-loop] background action failed: ${String(error)}`)
    })
  }

  // ---- Pi event translation ----

  private onPiEvent(event: PiEvent): void {
    switch (event.type) {
      case 'message_start': {
        const message = event.message as { role?: string } | undefined
        if (message?.role !== 'assistant') return
        this.assistantSeen += 1
        // Each Pi assistant message is one DSH assistant attempt: a fresh
        // compact stream, a fresh attempt identity, and a fresh `start` frame.
        this.stream = new AssistantStreamAccumulator()
        this.attemptRevision += 1
        this.attemptId = LlmAttemptId(`${this.id}:${this.attemptRevision}`)
        this.chunkIndex = 0
        if (this.assistantSeen === 1) {
          // The first assistant message belongs to the step the prompt opened.
          this.openStep()
        } else {
          // A further assistant message means Pi looped through tools: close
          // the previous step and open a fresh one.
          this.closeStep()
          this.openStep()
        }
        this.dispatch.emit('agent/assistant-stream', {
          frame: {
            type: 'start',
            attemptId: this.attemptId,
            revision: this.nextFrameRevision(),
            turn: this.turn,
            step: this.step,
          },
        })
        return
      }
      case 'message_update': {
        // Pi is waiting for the provider while it streams, so its steering
        // queue is polled again at the next step boundary: handing the pending
        // input over now reaches that boundary.
        if (this.inbox.nextStep.length > 0) void this.contain(() => this.deliverNextStepToPi())
        const assistantEvent = event.assistantMessageEvent as
          | {
            type: string
            contentIndex?: number
            delta?: string
            text?: string
            id?: string
            toolName?: string
            toolCall?: { id?: string; name?: string }
          }
          | undefined
        if (!assistantEvent) return
        const index = assistantEvent.contentIndex ?? 0
        switch (assistantEvent.type) {
          case 'toolcall_start': {
            // The call id and tool name only exist here; the deltas that follow
            // carry the arguments alone.
            this.pendingToolCalls.set(index, {
              id: String(assistantEvent.id ?? ''),
              ...(assistantEvent.toolName !== undefined ? { name: assistantEvent.toolName } : {}),
            })
            return
          }
          case 'toolcall_delta': {
            const pending = this.pendingToolCalls.get(index)
            const chunk: StreamChunk = {
              type: 'tool-call-delta',
              index,
              id: ToolCallId(pending?.id ?? ''),
              ...(pending?.name !== undefined ? { name: pending.name } : {}),
              argumentsDelta: assistantEvent.delta ?? '',
            }
            this.openStep()
            this.appendChunk(chunk)
            return
          }
          case 'toolcall_end': {
            const toolCall = assistantEvent.toolCall
            if (toolCall !== undefined) {
              this.pendingToolCalls.set(index, {
                id: String(toolCall.id ?? ''),
                ...(toolCall.name !== undefined ? { name: toolCall.name } : {}),
              })
            }
            return
          }
          case 'text_delta': {
            const chunk: StreamChunk = {
              type: 'text-delta',
              index,
              text: assistantEvent.delta ?? assistantEvent.text ?? '',
            }
            this.openStep()
            this.appendChunk(chunk)
            return
          }
          case 'thinking_delta': {
            const chunk: StreamChunk = {
              type: 'reasoning-delta',
              index,
              text: assistantEvent.delta ?? assistantEvent.text ?? '',
            }
            this.openStep()
            this.appendChunk(chunk)
            return
          }
          default:
            return
        }
      }
      case 'message_end': {
        const message = event.message as
          | {
            role?: string
            content?: unknown
            provider?: string
            model?: string
            stopReason?: string
            errorMessage?: unknown
            usage?: unknown
          }
          | undefined
        if (message?.role === 'user') {
          // Pi echoes the prompt first and every steering message it injects
          // after it, so the second and later echoes are steering deliveries.
          this.userEchoes += 1
          if (this.userEchoes > 1) this.confirmSteering()
          return
        }
        if (message?.role !== 'assistant') return
        const content = Array.isArray(message.content) ? message.content : []
        const blocks = content.map(convertBlock).filter((block): block is ContentBlock => block !== undefined)
        // A failed model call is a failure, not an answer: Pi reports it as
        // an assistant message with an empty content and a stop reason of
        // `error`. Writing that as an assistant message would show an empty
        // bubble in the UI and close the turn as completed, hiding the real
        // cause (a provider error, a context window that does not fit).
        if (message.stopReason === 'error') {
          this.reportModelError(message.errorMessage)
          return
        }
        this.openStep()
        const sourceProvider = typeof message.provider === 'string' ? message.provider : this.options.provider ?? ''
        const sourceModel = typeof message.model === 'string' ? message.model : this.options.model ?? ''
        const usage = convertUsage(message.usage)
        const stream: AssistantStreamRecord[] = [...this.stream.snapshot()]
        const committed = this.session.append(
          'assistant/message',
          {
            turn: this.turn,
            step: this.step,
            message: createAssistantMessage({
              content: blocks,
              source: { provider: sourceProvider, model: sourceModel },
            }),
            stream,
            ...(usage === undefined ? {} : { usage }),
          },
          { surfaceOp: 'append' },
        )
        const attemptId = this.attemptId
        if (attemptId !== undefined) {
          this.dispatch.emit('agent/assistant-stream', {
            frame: {
              type: 'end',
              attemptId,
              revision: this.nextFrameRevision(),
              index: this.chunkIndex,
              outcome: { kind: 'committed', eventType: 'assistant/message', seq: committed.seq },
            },
          })
        }
        return
      }
      case 'turn_end': {
        // Pi finished one assistant turn (model call plus its tool executions).
        // The steering queue is polled right after this event, so handing the
        // input over now would be too late: it would wait for the next run.
        // The pending input is delivered while Pi is still awaiting (see the
        // `message_update` and `tool_execution_start` branches) instead.
        return
      }
      case 'tool_execution_start': {
        // Pi is waiting for the tool, so the steering queue is polled again at
        // the boundary that follows the tool execution.
        if (this.inbox.nextStep.length > 0) void this.contain(() => this.deliverNextStepToPi())
        const start = event as { toolCallId?: unknown; toolName?: unknown; args?: unknown }
        const callId = ToolCallId(String(start.toolCallId ?? ''))
        const name = String(start.toolName ?? '')
        const args = start.args
        const argumentsText = typeof args === 'string' ? args : JSON.stringify(args ?? {})
        const callEvent = this.session.append('tool/call', {
          turn: this.turn,
          step: this.step,
          callId,
          name,
          arguments: argumentsText,
        })
        this.toolCallSeqs.set(String(callId), callEvent.seq)
        this.toolCallNames.set(String(callId), name)
        return
      }
      case 'tool_execution_end': {
        const end = event as { toolCallId?: unknown; toolName?: unknown; result?: unknown; isError?: boolean }
        const callId = ToolCallId(String(end.toolCallId ?? ''))
        const blocks = convertToolResult(end.result)
        const isError = end.isError === true
        const message = createToolResultMessage({
          callId,
          content: blocks,
          isError,
        })
        const callSeq = this.toolCallSeqs.get(String(callId))
        this.session.append(
          'tool/result',
          { turn: this.turn, step: this.step, message },
          { surfaceOp: 'append', ...(callSeq !== undefined ? { sourceEventSeqs: [callSeq] } : {}) },
        )
        return
      }
      case 'agent_settled': {
        // Pi will not continue automatically: retries, compaction recovery and
        // queued work are all done. The steering Pi never injected is
        // recovered first, so the turn loop can still deliver it.
        void this.contain(() => this.settleRun())
        return
      }
      case 'agent_end': {
        // One low-level run ended. More work may still follow (retry,
        // compaction, steering), so the run is NOT settled here.
        this.logger?.('[pi-loop] agent_end (run may continue)')
        return
      }
      default:
        return
    }
  }

  private appendChunk(chunk: StreamChunk): void {
    const time = Date.now()
    this.stream.push({ time, chunk })
    const attemptId = this.attemptId
    if (attemptId === undefined) return
    this.dispatch.emit('agent/assistant-stream', {
      frame: {
        type: 'chunk',
        attemptId,
        revision: this.nextFrameRevision(),
        index: this.chunkIndex,
        time,
        chunk,
      },
    })
    this.chunkIndex += 1
  }

  /**
   * Allocate the next assistant frame revision.
   *
   * @returns the dense successor of the last emitted frame revision.
   */
  private nextFrameRevision(): number {
    this.frameRevision += 1
    return this.frameRevision
  }

  /** Tear down: stop Pi and unwind the scoped context. */
  dispose(): void {
    this.unwatch()
    this.unwatchExit()
    if (this.phase.kind !== 'idle') {
      this.cancelCause = this.cancelCause ?? { kind: 'disposed' }
      this.phase.abort.abort(this.cancelCause)
    }
    this.markSettled(new Error('agent disposed'))
    this.rpc.close()
    void this.disposeScope()
  }
}
