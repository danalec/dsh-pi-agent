/**
 * dsh-pi-loop — DeepSeek Harness plugin that runs the Pi coding agent loop
 * inside DSH's frontend.
 *
 * The plugin registers an `AgentFactory` through `ctx.agents.setFactory`, so
 * every new session the frontend creates is driven by a headless
 * `pi --mode rpc` child process instead of DSH's own `dsh-agent-loop`.
 *
 * Pluggable by configuration: the default loop stays registered underneath;
 * disable this plugin's entry (or remove the profile patch that inserts it)
 * and DSH's own loop is active again immediately.
 *
 * Mount in the profile patch layer (cordis.patch.yml):
 *
 * ```yaml
 * # Use the Pi loop for all new sessions.
 * - insert:
 *     - id: pi-loop
 *       name: 'dsh-pi-loop'
 *       config:
 *         piPath: 'pi'                      # or an absolute path
 *         cwd: '/path/to/your/project'
 *         model: 'provider/model'           # e.g. anthropic/claude-sonnet-4-5
 *         debug: false
 * # Fall back to DSH's own loop: disable this entry and re-enable agent-loop.
 * # - id: pi-loop
 * #   disabled: true
 * ```
 */

import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { PiAgentFactory } from './factory.ts'
import { inboxProjectionDefinition } from './inbox-projection.ts'

export { buildPiSessionFile } from './history.ts'
export type {
  BuildPiSessionFileOptions,
  PiMessage,
  PiMessageEntry,
  PiSessionHeader,
} from './history.ts'
export { PiInbox, applyInboxSplice, foldInboxState } from './inbox.ts'
export type { PiInboxNotifications, PiInboxState } from './inbox.ts'
export { inboxProjectionDefinition, inboxProjectionSchema } from './inbox-projection.ts'
export { PiModel, foldModelState, sameModelSelection } from './model.ts'
export type { ModelState } from './model.ts'
export { PiAgent } from './pi-agent.ts'
export type { PiAgentOptions } from './pi-agent.ts'
export { PiRpcClient } from './rpc-client.ts'
export type {
  PiCommand,
  PiEvent,
  PiPromptDisposition,
  PiResponse,
  PiRpcClientOptions,
} from './rpc-client.ts'
export { PiAgentFactory } from './factory.ts'
export type { PiFactoryOptions, PiSessionStartSource } from './factory.ts'

export const name = 'pi-loop'

/**
 * Register the standard `modelSelection` projection.
 *
 * The frontend reads a session's model from that projection. A driver that
 * owns the factory slot but does not own the plugin's `apply` (a router that
 * delegates to this driver) registers it through this helper.
 *
 * @returns a promise that settles when the projection is registered.
 */
export function registerModelSelectionProjection(ctx: Context): Promise<unknown> {
  try {
    return ctx.sessionProjections.register(modelSelectionProjectionDefinition).catch((error: unknown) => {
      ctx.logger.warn(`pi-loop: could not register the model selection projection: ${String(error)}`)
    })
  } catch (error: unknown) {
    ctx.logger.warn(`pi-loop: could not register the model selection projection: ${String(error)}`)
    return Promise.resolve()
  }
}

/**
 * Register the `inbox` projection — the session's pending input.
 *
 * The native loop (`@deepseek-ai/dsh-agent-loop`) owns this projection, and
 * the Pi loop replaces that plugin: with the native loop disabled, nothing
 * else registers the key, and the frontend's queue dock — which reads
 * `projections.faceOf('inbox')` — has nothing to render.
 *
 * @returns a promise that settles when the projection is registered.
 */
export function registerInboxProjection(ctx: Context): Promise<unknown> {
  try {
    return ctx.sessionProjections.register(inboxProjectionDefinition).catch((error: unknown) => {
      ctx.logger.warn(`pi-loop: could not register the inbox projection: ${String(error)}`)
    })
  } catch (error: unknown) {
    ctx.logger.warn(`pi-loop: could not register the inbox projection: ${String(error)}`)
    return Promise.resolve()
  }
}

/**
 * Register every session projection the Pi loop owns.
 *
 * A router that owns the agent-factory slot registers both through this
 * helper: the model route and the pending queue are the same for every
 * engine, so one registration covers them all.
 *
 * @returns a promise that settles when the projections are registered.
 */
export async function registerSessionProjections(ctx: Context): Promise<void> {
  try {
    await Promise.all([
      registerModelSelectionProjection(ctx),
      registerInboxProjection(ctx),
    ])
  } catch (error: unknown) {
    // A rejected registration must never escape: the caller fires and
    // forgets, and an unhandled rejection ends the host process.
    ctx.logger.warn(`pi-loop: could not register the session projections: ${String(error)}`)
  }
}

/**
 * Services the agent scope must be able to resolve.
 *
 * The agent's scoped context inherits this plugin's dependency API, and the
 * frontend's composition (agent presets, prompt sections, tools) reads those
 * services from the agent context during setup. A missing one fails the
 * session creation with `cannot get property "<service>" without inject`.
 * The set mirrors `@deepseek-ai/dsh-agent-loop`, the factory this plugin
 * replaces.
 */
export const inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']

export interface Config {
  /** Pi executable; defaults to `pi` on PATH. */
  piPath?: string
  /** Working directory for Pi sessions. Defaults to process.cwd(). */
  cwd?: string
  /** Pi model route (`provider/model`, e.g. `anthropic/claude-sonnet-4-5`). */
  model?: string
  /**
   * Always use `model`, ignoring the route the session asks for.
   *
   * The Pi agent has a model of its own: the session's own model selection
   * is the session's record and never reaches the child. Set this to `false`
   * to let the session's route drive the child instead.
   *
   * Defaults to `true`.
   */
  pinModel?: boolean
  /**
   * Byte budget for the Pi session file rebuilt from the DSH log.
   *
   * The rebuilt file is the child's context: a session whose log grew past
   * the budget is rebuilt with its oldest messages dropped, the way the
   * native loop compacts. Without it the provider refuses the request with
   * "context window exceeds limit" and every answer comes back empty.
   */
  contextBudgetBytes?: number
  /** Protocol diagnostics; appended to `<tmpdir>/dsh-pi-loop.log`. */
  debug?: boolean
}

export const Config = z.object({
  piPath: z.string(),
  cwd: z.string(),
  model: z.string(),
  pinModel: z.boolean().default(true),
  contextBudgetBytes: z.number(),
  debug: z.boolean(),
}) as unknown as z<Config>

/** Name of the diagnostics file inside the platform temp directory. */
export const DEBUG_LOG_FILE = 'dsh-pi-loop.log'

/**
 * Register the Pi agent factory.
 *
 * The registration is synchronous: the factory slot is taken before this
 * function returns, so a session created right after the plugin mounts finds
 * the Pi factory already in place.
 *
 * @returns the disposer that unregisters the factory.
 */
export function apply(ctx: Context, config: Config): () => void {
  const debug = config.debug === true
  const logFile = join(tmpdir(), DEBUG_LOG_FILE)
  const trace = (line: string): void => {
    if (!debug) return
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
    } catch { /* diagnostics must never break the plugin */ }
  }
  trace(`apply entered config=${JSON.stringify(config)}`)
  try {
    const cwd = config.cwd ?? process.cwd()
    // Without `debug`, no sink is installed at all: the protocol layer then
    // formats no diagnostics and touches no disk.
    const logger = debug
      ? (line: string): void => {
          trace(`[pi] ${line}`)
        }
      : undefined
    const factory = new PiAgentFactory(
      {
        piPath: config.piPath,
        cwd,
        model: config.model,
        pinModel: config.pinModel,
        contextBudgetBytes: config.contextBudgetBytes,
        logger,
        trace: debug ? trace : undefined,
      },
      ctx,
    )
    const dispose = ctx.agents.setFactory(factory)
    trace('factory registered (pi loop active)')
    // The frontend reads a session's model from the standard `modelSelection`
    // projection and its pending queue from the `inbox` projection. The
    // native loop owns both, and this plugin replaces it, so it registers
    // them itself. Registration is asynchronous and the factory does not
    // depend on it (the agent owns its own durable selection), so it runs in
    // the background.
    void registerSessionProjections(ctx)
    return dispose
  } catch (error: unknown) {
    trace(`apply failed: ${String(error)}`)
    throw error
  }
}
