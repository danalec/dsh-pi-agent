/**
 * PiRpcClient — spawns a headless `pi --mode rpc` process and speaks the
 * JSONL protocol on stdin/stdout.
 *
 * Commands are JSON objects on stdin; responses and agent events are JSON
 * lines on stdout. Responses carry the caller's `id` for correlation; events
 * are streamed as they occur (see `AgentSessionEvent` in
 * `@earendil-works/pi-coding-agent`).
 *
 * Protocol rules this client honours (see Pi's `docs/rpc.md`):
 * - one JSON object per line, terminated by LF; stdout is split on LF only
 *   (never on U+2028/U+2029, so no `readline`);
 * - a command response means the command was *accepted*, not that the model
 *   work finished — the run is settled by the `agent_settled` event;
 * - closing the child's stdin requests an orderly shutdown.
 */

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { spawnPi } from './spawn.ts'

/** Minimal structural types mirroring Pi's RPC surface (kept local to avoid a hard dependency on pi packages). */

export interface PiCommand {
  id?: string
  type: string
  [key: string]: unknown
}

export interface PiResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
}

/**
 * The extension UI methods that expect no answer.
 *
 * They are notifications: the child does not wait for them, so answering
 * them would only confuse the extension.
 */
const FIRE_AND_FORGET_UI_METHODS: ReadonlySet<string> = new Set([
  'notify',
  'setStatus',
  'setWidget',
  'setTitle',
  'set_editor_text',
])

/** The event envelope Pi streams on stdout during a run. */
export interface PiEvent {
  type: string
  [key: string]: unknown
}

/**
 * What Pi did with a submitted prompt.
 *
 * - `started`: a run began for this prompt;
 * - `queued`: the prompt was queued behind an active run;
 * - `handled`: an extension command or input handler consumed the prompt and
 *   **no run started** — the client must not wait for `agent_settled`.
 */
export type PiPromptDisposition = 'started' | 'queued' | 'handled' | (string & {})

/**
 * What the child does with a prompt that arrives while it is processing.
 *
 * `followUp` waits for the run to finish; `steer` delivers the message
 * before the next model call. Pi refuses a prompt that arrives during a
 * run without one of them.
 */
export type PiStreamingBehavior = 'followUp' | 'steer'

export interface PiRpcClientOptions {
  /** Pi executable; defaults to `pi` resolved from PATH. */
  piPath?: string
  /** Working directory for the Pi agent session. */
  cwd: string
  /** Initial model route (`provider/model`), e.g. `anthropic/claude-sonnet-4-5`. */
  model?: string
  /**
   * Pi session file (v3 JSONL) to load at startup. When provided, the child
   * resumes that conversation — full history in its context window — instead
   * of starting ephemeral (`--no-session`). Used by the mid-session handoff
   * bridge (see history.ts).
   */
  sessionFile?: string
  /** Abort signal that kills the child process. */
  signal?: AbortSignal
  /** Log sink for protocol diagnostics. */
  logger?: (line: string) => void
  /**
   * Environment variables the child receives on top of the host's.
   *
   * The child is a separate process: it does not inherit the host's
   * credential store. A provider whose key is missing has no usable
   * models — Pi lists a provider's models only when it can authenticate.
   */
  env?: Record<string, string>
  /**
   * Per-command response timeout in ms. `0` disables the timeout.
   * Default 120000 — long enough for Pi's `abort` command, which waits for the
   * session to become idle before responding.
   */
  commandTimeoutMs?: number
  /**
   * The thinking level the child runs on.
   *
   * Pi's reasoning effort is a session setting of its own: the level
   * applies to the model that is selected, so it is sent after the
   * route. A model that does not expose the level refuses the command,
   * and the refusal is reported instead of ignored.
   */
  thinkingLevel?: string
  /**
   * Response timeout of the `prompt` command in ms. `0` disables it.
   *
   * The prompt's response only says the child accepted the message. A child
   * that is restoring a large session or compacting it answers late, and a
   * flat command timeout would turn a slow child into a failed turn.
   * Default 600000.
   */
  promptTimeoutMs?: number
  /**
   * Grace period before a still-running child is killed after `close()`.
   * Pi shuts down on stdin EOF; this is the safety net.
   */
  closeGraceMs?: number
}

interface PendingCommand {
  resolve: (response: PiResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | undefined
}

export class PiRpcClient {
  readonly cwd: string
  /**
   * Resolves when the initial `set_model` succeeded, rejects when the model
   * route was refused. Await this before the first prompt so a bad route
   * fails loudly instead of silently running Pi's default model.
   */
  readonly ready: Promise<void>
  private readonly proc: ChildProcess
  private readonly events = new EventEmitter()
  private readonly pending = new Map<string, PendingCommand>()
  private buffer = ''
  private closed = false
  private exited = false
  private nextId = 0
  private readonly logger?: (line: string) => void
  private readonly commandTimeoutMs: number
  private readonly promptTimeoutMs: number
  private readonly closeGraceMs: number
  private killTimer: NodeJS.Timeout | undefined
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private resolveExit!: (info: { code: number | null; signal: NodeJS.Signals | null }) => void

  constructor(options: PiRpcClientOptions) {
    this.cwd = resolve(options.cwd)
    this.logger = options.logger
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000
    // The prompt's answer says the child accepted the message, not that
    // the model answered: a child restoring a large session or compacting
    // it takes much longer than a command that only reads state.
    this.promptTimeoutMs = options.promptTimeoutMs ?? 600_000
    this.closeGraceMs = options.closeGraceMs ?? 5_000
    this.exitPromise = new Promise((resolvePromise) => {
      this.resolveExit = resolvePromise
    })
    const piPath = options.piPath ?? 'pi'
    // A session file carries the pre-handoff history; without one the child
    // runs ephemeral (current default behavior).
    const args = options.sessionFile !== undefined
      ? ['--mode', 'rpc', '--session', options.sessionFile]
      : ['--mode', 'rpc', '--no-session']
    this.proc = spawnPi(piPath, args, {
      cwd: this.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
      windowsHide: true,
    })
    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr!.setEncoding('utf8')
    this.proc.stderr!.on('data', (chunk: string) => this.logger?.(`[pi:stderr] ${chunk.trimEnd()}`))
    this.proc.on('error', (error) => {
      this.logger?.(`[pi:error] ${String(error)}`)
      this.failAll(new Error(`pi process failed to start: ${String(error)}`))
    })
    this.proc.on('exit', (code, signal) => {
      this.closed = true
      this.exited = true
      if (this.killTimer !== undefined) {
        clearTimeout(this.killTimer)
        this.killTimer = undefined
      }
      this.logger?.(`[pi:exit] code=${String(code)} signal=${String(signal)}`)
      const failure = new Error(`pi process exited (code=${String(code)} signal=${String(signal)})`)
      this.failAll(failure)
      this.events.emit('exit', { code, signal })
      this.resolveExit({ code, signal })
    })
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', () => {
        this.close()
      }, { once: true })
    }
    if (options.model !== undefined && options.model !== '') {
      this.ready = this.resolveRoute(options.model).then((route) => {
        if (route === undefined) return undefined
        const { provider, modelId } = route
        return this.send({
          type: 'set_model',
          provider,
          modelId,
        }).then((response) => {
          if (!response.success) {
            throw new Error(`pi set_model failed for "${options.model}": ${response.error ?? 'unknown error'}`)
          }
          // The thinking level belongs to the model that is now selected:
          // it is sent after the route, never before it.
          if (options.thinkingLevel === undefined) return undefined
          return this.send({ type: 'set_thinking_level', level: options.thinkingLevel })
            .then((level) => {
              if (!level.success) {
                throw new Error(
                  `pi set_thinking_level failed for "${options.thinkingLevel}": ${level.error ?? 'unknown error'}`,
                )
              }
              return undefined
            })
        })
      })
    } else {
      this.ready = Promise.resolve()
    }
    // A failed `set_model` must not become an unhandled rejection: the caller
    // awaits `ready`, but a caller that never does must not crash the host.
    this.ready.catch(() => undefined)
  }

  /** Whether the child process is still alive. */
  get running(): boolean {
    return !this.closed && !this.exited
  }

  /** Resolves when the child process exits. */
  whenExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exitPromise
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.trim() === '') continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        this.logger?.(`[pi:bad-json] ${line.slice(0, 200)}`)
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const record = message as Record<string, unknown>
    if (record.type === 'extension_ui_request') {
      this.answerExtensionUi(record)
      return
    }
    if (record.type === 'response') {
      const response = message as PiResponse
      const id = response.id ?? response.command
      if (id === undefined) return
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.resolve(response)
      return
    }
    this.logger?.(`[pi:event] ${String(record.type)}`)
    this.events.emit('event', message)
  }

  /**
   * Answer an extension's user-interaction request.
   *
   * Pi's extensions can ask the user something through `ctx.ui`. In RPC mode
   * a dialog method (`select`, `confirm`, `input`, `editor`) makes the child
   * BLOCK until the client answers on stdin: an unanswered request freezes
   * the whole child — the run stops, and every later command waits behind
   * it. The DSH frontend has no surface for a Pi extension's dialog, and a
   * frozen child takes the session down with it, so the answer is a
   * cancellation: the extension receives `undefined` (or `false`) and the
   * child continues.
   *
   * The fire-and-forget methods expect no answer and are only logged.
   *
   * @param request - the request envelope Pi sent.
   */
  private answerExtensionUi(request: Record<string, unknown>): void {
    const id = request.id
    const method = typeof request.method === 'string' ? request.method : ''
    if (typeof id !== 'string' || id === '') return
    if (FIRE_AND_FORGET_UI_METHODS.has(method)) {
      this.logger?.(`[pi:ui] ${method} (no answer expected)`)
      return
    }
    this.write({ type: 'extension_ui_response', id, cancelled: true })
    this.logger?.(`[pi:ui] ${method} cancelled`)
  }

  /** Write one JSON line to the child's stdin. */
  private write(payload: Record<string, unknown>): void {
    if (!this.running) return
    try {
      this.proc.stdin!.write(`${JSON.stringify(payload)}\n`)
    } catch (error: unknown) {
      this.logger?.(`[pi:ui] the answer could not be written: ${String(error)}`)
    }
  }

  /**
   * Resolve a model route into the provider and the model id Pi knows.
   *
   * A route that names its provider is used as it is. A route that names
   * only a model asks Pi's own catalog: the plugin does not stipulate
   * which provider a model belongs to.
   *
   * @param route - the route, `provider/model` or a bare model id.
   * @returns the provider and the model id, or `undefined` when the route
   * names no model.
   */
  private async resolveRoute(route: string): Promise<{ provider: string, modelId: string } | undefined> {
    const slash = route.indexOf('/')
    if (slash > 0) {
      return { provider: route.slice(0, slash), modelId: route.slice(slash + 1) }
    }
    const response = await this.send({ type: 'get_available_models' })
    const models = (response.data as { models?: { id?: string, provider?: string }[] } | undefined)?.models ?? []
    const found = models.find(model => model.id === route)
    if (found?.provider === undefined) {
      throw new Error(
        `pi does not know the model "${route}": a model id without a provider must exist in pi's catalog`,
      )
    }
    return { provider: found.provider, modelId: route }
  }

  /**
   * Send one command and await its correlated response.
   *
   * @param command - the command envelope; `id` is generated when absent.
   * @param timeoutMs - response timeout override; `0` disables it.
   * @returns the response envelope (success or failure).
   */
  send(command: PiCommand, timeoutMs?: number): Promise<PiResponse> {
    if (!this.running) return Promise.reject(new Error('pi process is not running'))
    const id = command.id ?? `cmd-${++this.nextId}`
    const framed = { ...command, id }
    const effectiveTimeout = timeoutMs ?? this.commandTimeoutMs
    return new Promise<PiResponse>((resolvePromise, reject) => {
      const timer = effectiveTimeout > 0
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`pi command "${command.type}" timed out after ${effectiveTimeout}ms`))
          }, effectiveTimeout)
        : undefined
      timer?.unref?.()
      this.pending.set(id, { resolve: resolvePromise, reject, timer })
      const line = JSON.stringify(framed)
      this.logger?.(`[pi:cmd] ${line.slice(0, 200)}`)
      this.proc.stdin!.write(`${line}\n`, (error) => {
        if (error) {
          const entry = this.pending.get(id)
          this.pending.delete(id)
          if (entry?.timer !== undefined) clearTimeout(entry.timer)
          reject(error)
          return
        }
        // Honor stdin backpressure: a client that floods the pipe makes Pi
        // wait on writes. Drain before considering the command delivered.
        if (this.proc.stdin!.writableNeedDrain) {
          this.proc.stdin!.once('drain', () => undefined)
        }
      })
    })
  }

  /**
   * Switch the child to another model.
   *
   * The route names the Pi provider and the model id Pi knows it under. A
   * route Pi refuses is reported: the session must not keep running on the
   * previous model as if the switch had happened.
   *
   * @param provider - the Pi provider name.
   * @param modelId - the model id within that provider.
   */
  async setModel(provider: string, modelId: string): Promise<void> {
    const response = await this.send({ type: 'set_model', provider, modelId })
    if (!response.success) {
      throw new Error(`pi set_model failed for "${provider}/${modelId}": ${response.error ?? 'unknown error'}`)
    }
  }

  /**
   * Send a prompt and report what Pi did with it.
   *
   * The response only means the prompt was accepted, queued, or handled — it
   * does NOT mean the run finished. Use {@link PiRpcClient.onEvent} with
   * `agent_settled` to learn that Pi will not continue automatically.
   *
   * The response therefore answers a question about the CHILD, not about the
   * model: a child that is restoring a large session, compacting it, or
   * waiting on a provider takes a while to accept anything. The wait is
   * bounded by {@link PiRpcClientOptions.promptTimeoutMs}, not by the
   * command timeout — the run itself is bounded by the agent's lifecycle.
   *
   * @param message - the user message.
   * @param behavior - what the child does with the message when it is
   * already processing: `followUp` waits for the run to finish, `steer`
   * delivers the message before the next model call.
   * @returns what Pi did with the prompt.
   */
  async prompt(message: string, behavior: PiStreamingBehavior = 'followUp'): Promise<PiPromptDisposition> {
    // The behaviour says what happens to the message when the child is
    // already processing: without it, pi refuses the command outright.
    const response = await this.send({ type: 'prompt', message, streamingBehavior: behavior }, this.promptTimeoutMs)
    if (!response.success) throw new Error(`pi prompt failed: ${response.error ?? 'unknown error'}`)
    const data = response.data as { disposition?: PiPromptDisposition } | undefined
    return data?.disposition ?? 'started'
  }


  /** Abort the active run. */
  async abort(): Promise<void> {
    try {
      await this.send({ type: 'abort' })
    } catch {
      // process may already be gone
    }
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  onEvent(listener: (event: PiEvent) => void): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  /** Resolves when the child process exits. */
  onExit(listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): () => void {
    this.events.on('exit', listener)
    return () => this.events.off('exit', listener)
  }

  /**
   * Stop the child. Pi shuts down in an orderly way when its stdin closes,
   * so the pipe is closed first and the process is killed only if it lingers.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.proc.stdin?.end()
    } catch {
      // already gone
    }
    if (this.exited) return
    this.killTimer = setTimeout(() => {
      try {
        this.proc.kill('SIGKILL')
      } catch {
        // already gone
      }
    }, this.closeGraceMs)
    this.killTimer.unref?.()
  }
}
