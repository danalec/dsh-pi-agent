/**
 * dsh-pi-subagent — a DSH subagent provider whose child is the Pi coding agent.
 *
 * Each accepted run spawns `pi -p <task>` (print mode) in the delegating
 * session's workspace and returns the final assistant text as the run's
 * output. The child runs to completion and exits — a one-shot, out-of-process
 * engine, exactly like DSH's own `subagent-claude-code` and `subagent-codex`
 * bridges, but for the Pi coding agent.
 *
 * The child is a bare `pi` process: it loads its own system prompt, its four
 * tools, and the workspace's context files (`AGENTS.md`/`CLAUDE.md`). Nothing
 * from the parent conversation, persona, or tool surface crosses the process
 * boundary — `inheritsParentContext: false`, zero prompt collision.
 *
 * Mount alongside the delegation tool and select it by config:
 *
 * ```yaml
 * - id: subagent-pi
 *   name: 'dsh-pi-agent/subagent'
 *   config:
 *     providerName: pi
 *
 * - id: tool-subagent
 *   name: '@deepseek-ai/dsh-tool-subagent'
 *   config:
 *     provider: pi          # pi as the delegation engine
 *     toolName: subagent
 *     backgroundMode: one-shot
 *     maxDepth: 'provider-managed'
 * ```
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { spawnPi } from './spawn.ts'

export const name = 'subagent-pi'

export const inject = ['subagents']

/** Maximum captured child output, in bytes. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** Maximum diagnostic detail carried by a failed run, in UTF-8 bytes. */
const MAX_DIAGNOSTIC_BYTES = 4096

/** Config: how to spawn and drive the child pi process. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `pi`). Must be unique per mounted instance. */
  providerName?: string
  /** Pi executable (default `pi`, resolved from PATH; or an absolute path). */
  piPath?: string
  /** Pi model route (`provider/model`). Omit for pi's configured default. */
  model?: string
  /** Working-directory override; omit to inherit the delegating parent session's cwd. */
  cwd?: string
  /** Extra arguments passed to every pi invocation (e.g. `['--no-context-files']`). */
  args?: string[]
  /** Maximum wall-clock time for one run in ms (default 600000 = 10 minutes). */
  timeoutMs?: number
}

export const Config = z.object({
  providerName: z.string(),
  piPath: z.string(),
  model: z.string(),
  cwd: z.string(),
  args: z.array(z.string()),
  timeoutMs: z.number(),
}) as unknown as z<Config>

/** Flatten the request prompt blocks into the single text task for `pi -p`. */
function promptText(prompt: readonly ContentBlock[]): string {
  return prompt
    .map(block => (block.type === 'text' ? block.text : ''))
    .filter(text => text.length > 0)
    .join('\n')
    .trim()
}

/** Resolve the child cwd: configured override, else the parent session's cwd. */
function resolveCwd(configured: string | undefined, request: ResolvedSubagentStartRequest): string {
  if (configured !== undefined && configured !== '') return configured
  const parentCwd = request.parent.session.header.cwd
  if (parentCwd === undefined) {
    throw new Error('subagent-pi: parent session has no cwd and no cwd override is configured')
  }
  return parentCwd
}

/** Truncate text to a UTF-8 byte budget. */
function clampUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const buffer = Buffer.from(text, 'utf8').subarray(0, maxBytes)
  return buffer.toString('utf8')
}

class PiSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
  // The child is a fresh pi process: no parent conversation crosses the boundary.
  readonly inheritsParentContext = false

  constructor(
    readonly name: string,
    private readonly ctx: Context,
    private readonly config: Required<Pick<Config, 'piPath' | 'timeoutMs'>> & Config,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const task = promptText(request.prompt)
    if (task.length === 0) {
      // The seam validates a non-empty prompt before start, but a prompt of
      // only non-text blocks would still flatten to nothing — fail loud.
      throw new Error('subagent-pi: request prompt contains no text')
    }

    const cwd = resolveCwd(this.config.cwd, request)
    const id = SessionId(`pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)

    const args = ['-p', ...(this.config.args ?? [])]
    if (this.config.model !== undefined && this.config.model !== '') {
      args.push('--model', this.config.model)
    }
    // `--` stops option parsing, so a task that starts with `-` is a prompt
    // and not a flag.
    args.push('--', task)

    // Provider-owned cancellation: dispose() and the request's abort signal
    // both funnel into one controller, so the run settles as 'aborted' either way.
    const controller = new AbortController()
    const onParentAbort = (): void => { controller.abort() }
    if (request.signal.aborted) controller.abort()
    else request.signal.addEventListener('abort', onParentAbort, { once: true })

    const result = (async (): Promise<SubagentResult> => {
      try {
        const output = await this.runPi(args, cwd, controller.signal)
        return { output: output.length > 0 ? [{ type: 'text', text: output }] : [], stopReason: 'completed' }
      } catch (error: unknown) {
        if (controller.signal.aborted) return { output: [], stopReason: 'aborted' }
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(`subagent-pi "${this.name}": child run failed: ${message}`)
        return { output: [], stopReason: 'error', diagnostic: clampUtf8(message, MAX_DIAGNOSTIC_BYTES) }
      } finally {
        request.signal.removeEventListener('abort', onParentAbort)
      }
    })()

    return {
      id,
      localAgent: undefined,
      result,
      dispose: async () => {
        controller.abort()
        await result
      },
    }
  }

  /** Spawn `pi -p`, capture stdout, and enforce the wall-clock timeout. */
  private runPi(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawnPi(this.config.piPath, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const settle = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        action()
      }
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        settle(() => reject(new Error(`subagent-pi: timed out after ${this.config.timeoutMs}ms`)))
      }, this.config.timeoutMs)
      timer.unref?.()

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        // Bound the captured output: a runaway child must not exhaust the host.
        if (stdout.length >= MAX_OUTPUT_BYTES) return
        stdout += chunk
        if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(0, MAX_OUTPUT_BYTES)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length >= MAX_OUTPUT_BYTES) return
        stderr += chunk
        if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(0, MAX_OUTPUT_BYTES)
      })
      child.on('error', error => settle(() => reject(error)))
      child.on('close', (code, killSignal) => {
        settle(() => {
          if (signal.aborted) {
            reject(new Error('aborted'))
          } else if (code === 0) {
            resolve(stdout.trim())
          } else {
            const detail = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 512)
            reject(new Error(`pi exited with code ${String(code)}${killSignal === null ? '' : ` (signal ${killSignal})`}${detail === '' ? '' : `: ${detail}`}`))
          }
        })
      })
    })
  }
}

/**
 * Register the Pi subagent provider.
 *
 * @returns the disposer that unregisters the provider.
 */
export function apply(ctx: Context, config: Config): () => void {
  const providerName = config.providerName === undefined || config.providerName === '' ? 'pi' : config.providerName
  const timeoutMs = config.timeoutMs === undefined ? 600000 : config.timeoutMs
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('subagent-pi: timeoutMs must be a positive finite number')
  }
  const provider = new PiSubagentProvider(providerName, ctx, {
    ...config,
    piPath: config.piPath === undefined || config.piPath === '' ? 'pi' : config.piPath,
    timeoutMs,
  })
  return ctx.subagents.registerProvider(provider)
}
