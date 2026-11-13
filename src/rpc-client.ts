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
   * Per-command response timeout in ms. `0` disables the timeout.
   * Default 120000 — long enough for Pi's `abort` command, which waits for the
   * session to become idle before responding.
   */
  commandTimeoutMs?: number
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
  private readonly closeGraceMs: number
  private killTimer: NodeJS.Timeout | undefined
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private resolveExit!: (info: { code: number | null; signal: NodeJS.Signals | null }) => void

  constructor(options: PiRpcClientOptions) {
    this.cwd = resolve(options.cwd)
    this.logger = options.logger
    this.commandTimeoutMs = options.commandTimeoutMs ?? 120_000
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
      env: process.env,
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
      const [provider, ...rest] = options.model.split('/')
      const modelId = rest.join('/')
      this.ready = this.send({
        type: 'set_model',
        provider,
        modelId,
      }).then((response) => {
        if (!response.success) {
          throw new Error(`pi set_model failed for "${options.model}": ${response.error ?? 'unknown error'}`)
        }
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
   * Send a prompt and report what Pi did with it.
   *
   * The response only means the prompt was accepted, queued, or handled — it
   * does NOT mean the run finished. Use {@link PiRpcClient.onEvent} with
   * `agent_settled` to learn that Pi will not continue automatically.
   */
  async prompt(message: string): Promise<PiPromptDisposition> {
    const response = await this.send({ type: 'prompt', message })
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
