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

export { buildPiSessionFile } from './history.ts'
export type {
  BuildPiSessionFileOptions,
  PiMessage,
  PiMessageEntry,
  PiSessionHeader,
} from './history.ts'
export { PiInbox, applyInboxSplice, foldInboxState } from './inbox.ts'
export type { PiInboxNotifications, PiInboxState } from './inbox.ts'
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
   * Always use `model`, ignoring the route DSH requests for a session.
   *
   * DSH's own providers are not Pi providers: without this, a session created
   * with the frontend's model picker would hand Pi a route Pi refuses.
   */
  pinModel?: boolean
  /** Protocol diagnostics; appended to `<tmpdir>/dsh-pi-loop.log`. */
  debug?: boolean
}

export const Config = z.object({
  piPath: z.string(),
  cwd: z.string(),
  model: z.string(),
  pinModel: z.boolean(),
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
        logger,
        trace: debug ? trace : undefined,
      },
      ctx,
    )
    const dispose = ctx.agents.setFactory(factory)
    trace('factory registered (pi loop active)')
    // The frontend reads a session's model from the standard `modelSelection`
    // projection. Registering it is asynchronous and the factory does not
    // depend on it (the agent owns its own durable selection), so it runs in
    // the background.
    void ctx.sessionProjections.register(modelSelectionProjectionDefinition).catch((error: unknown) => {
      ctx.logger.warn(`pi-loop: could not register the model selection projection: ${String(error)}`)
    })
    return dispose
  } catch (error: unknown) {
    trace(`apply failed: ${String(error)}`)
    throw error
  }
}
