/**
 * PiAgentFactory — the `AgentFactory` (`ctx.agents.setFactory`) that turns
 * DSH's frontend into a client for the Pi coding agent loop.
 *
 * When this plugin is loaded, every new session the frontend creates is
 * driven by a Pi child process (`pi --mode rpc`) instead of DSH's own
 * `dsh-agent-loop`. The factory mints the session, the scoped PiAgent, and
 * the Pi RPC child, then publishes both through the same ordered boundary the
 * default loop uses (`session/created`, `agent/created`,
 * `agent/session-start`), so DSH's frontend, hooks, and session log work
 * unchanged.
 *
 * To fall back to DSH's own loop, disable this plugin's entry (or the
 * profile patch inserting it) — the default `agent-loop` factory remains
 * registered underneath and becomes active again.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  type AgentFactory,
  type AgentHandle,
  type AgentOptions,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import {
  interruptedTurnClosers,
  SessionLogOffset,
  SessionPreparation,
  type Session,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { buildPiSessionFile } from './history.ts'
import { PiAgent } from './pi-agent.ts'
import { PiRpcClient } from './rpc-client.ts'

/** Why the session lifecycle began. */
export type PiSessionStartSource = 'startup' | 'resume'

export interface PiFactoryOptions {
  /** Absolute path to the Pi executable (defaults to `pi` on PATH). */
  piPath?: string
  /** Working directory for Pi sessions (defaults to process.cwd()). */
  cwd: string
  /** Pi model route (`provider/model`, e.g. `anthropic/claude-sonnet-4-5`). */
  model?: string
  /**
   * Ignore the route DSH requests for a session and always use `model`.
   *
   * DSH's own providers are not Pi providers: a session created with the
   * frontend's model picker would otherwise hand Pi a route Pi refuses.
   */
  pinModel?: boolean
  /** Diagnostics sink; omit to keep quiet. */
  logger?: (line: string) => void
  /** Lifecycle trace sink (apply/createAgent/resume); omit to keep quiet. */
  trace?: (line: string) => void
}

/** One resolved model route. */
export interface ResolvedRoute {
  /** `provider/model`, or empty when no route could be resolved. */
  route: string
  provider: string
  model: string
}

/** The provider that owns every Pi model id. */
export const DEFAULT_PROVIDER = 'minimax'

/**
 * Resolve the model route for one agent.
 *
 * The requested per-agent route wins over the factory default: this is what
 * lets a delegated child (whose `agentOptions` come from tool-subagent's
 * config) run on a fixed model like `provider/model` while the top-level
 * session keeps the factory default. A model without a provider borrows the
 * default's provider — never the other way round, so `provider` can never
 * end up holding a model id.
 */
export function resolvePiRoute(factoryModel: string | undefined, requested: AgentOptions | undefined): ResolvedRoute {
  const fallback = factoryModel ?? ''
  const slash = fallback.indexOf('/')
  // A model id without a provider belongs to Pi's own provider. A resumed
  // session asks for no route of its own, so this fallback is what keeps the
  // resumed session's messages carrying a model source. With no factory
  // default at all there is no provider to borrow.
  const fallbackProvider = slash > 0 ? fallback.slice(0, slash) : (fallback === '' ? '' : DEFAULT_PROVIDER)
  const fallbackModel = slash > 0 ? fallback.slice(slash + 1) : fallback

  const requestedProvider = requested?.provider !== undefined && requested.provider !== ''
    ? requested.provider
    : undefined
  const requestedModel = requested?.model !== undefined && requested.model !== ''
    ? requested.model
    : undefined

  let provider: string
  let model: string
  if (requestedModel !== undefined) {
    model = requestedModel
    provider = requestedProvider ?? fallbackProvider
  } else if (requestedProvider !== undefined) {
    provider = requestedProvider
    model = fallbackModel
  } else {
    provider = fallbackProvider
    model = fallbackModel
  }

  if (provider === '' || model === '') return { route: '', provider: '', model: '' }
  return { route: `${provider}/${model}`, provider, model }
}

export class PiAgentFactory implements AgentFactory {
  private readonly registryCtx: Context

  constructor(
    private readonly options: PiFactoryOptions,
    registryCtx: Context,
  ) {
    this.registryCtx = registryCtx
  }

  /**
   * The stored side of one session: the write handle the persistence backend
   * owns and the number of events already written to it.
   */
  private static stored(handle: SessionHandle, storedCount: number): { handle: SessionHandle, storedCount: number } {
    return { handle, storedCount }
  }

  /**
   * Take the write ownership of a fresh session's stored log.
   *
   * The backend routes every live `session/event` of this session into its
   * writer once the handle exists, so the handle must be created before the
   * session is published.
   */
  private async createStoredSession(session: Session, signal: AbortSignal | undefined): Promise<{ handle: SessionHandle, storedCount: number } | undefined> {
    const persistence = this.registryCtx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const handle = await persistence.create(session.header, {
      inheritedEventCount: session.inheritedEventCount,
      ...signal === undefined ? {} : { signal },
    })
    return PiAgentFactory.stored(handle, 0)
  }

  /**
   * Write the events a session holds but never published (its constructor
   * seed and the end-of-seed marker the core appends to it) to the stored
   * log. Without this the session's next sequence number runs ahead of the
   * store's cursor and every later append is refused.
   */
  private async appendUnstoredSuffix(
    stored: { handle: SessionHandle, storedCount: number } | undefined,
    session: Session,
  ): Promise<void> {
    if (stored === undefined) return
    const suffix = session.snapshotEvents(SessionLogOffset(stored.storedCount))
    if (suffix.length > 0) await stored.handle.append(suffix)
    stored.storedCount += suffix.length
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const id = options.sessionId
    this.options.trace?.(`createAgent id=${String(id)} meta=${JSON.stringify(options.meta)}`)
    const cwd = options.meta?.cwd ?? this.options.cwd
    let stored: { handle: SessionHandle, storedCount: number } | undefined
    try {
      const preparation = SessionPreparation.create(this.registryCtx.sessions.prepare(id, {
        ...options.meta === undefined ? {} : { meta: options.meta },
        ...options.seed === undefined ? {} : { seed: options.seed },
      }))
      try {
        const session = preparation.session
        stored = await this.createStoredSession(session, options.signal)
        await this.appendUnstoredSuffix(stored, session)
        const handle = await this.assembleAndPublish(
          ownerCtx,
          id,
          session,
          cwd,
          options.agentOptions,
          options.signal,
          options.setup,
          'startup',
          stored,
        )
        this.options.trace?.(`createAgent OK id=${String(id)}`)
        return handle
      } finally {
        preparation[Symbol.dispose]()
      }
    } catch (error: unknown) {
      await stored?.handle.close().catch(() => undefined)
      this.options.trace?.(`createAgent FAILED id=${String(id)}: ${String(error)}`)
      throw error
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.registryCtx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('cannot resume: session persistence is not configured (load a dsh-session-persistence backend)')
    }
    const id = options.resumeSessionId
    this.options.trace?.(`resume id=${String(id)}`)
    const signal = options.signal
    const handle = await persistence.open(id, 'write', signal === undefined ? {} : { signal })
    try {
      const coldRead = await handle.read(SessionLogOffset(0), undefined, signal === undefined ? {} : { signal })
      const persisted = coldRead.events
      // A turn that was interrupted by the crash left an open boundary: close
      // it durably before the session replays the log.
      const closers = interruptedTurnClosers(persisted)
      if (closers.length > 0) await handle.append(closers)
      const preparation = SessionPreparation.create(this.registryCtx.sessions.prepare(id, {
        seed: [...persisted, ...closers],
        meta: structuredClone(handle.header),
        inheritedEventCount: handle.inheritedEventCount,
        eventState: coldRead.eventState,
      }))
      try {
        const session = preparation.session
        const cwd = session.header.cwd ?? this.options.cwd
        const stored = PiAgentFactory.stored(handle, persisted.length + closers.length)
        // The restored session carries an end-of-seed marker the stored log
        // does not have. It occupies a sequence number, so it has to reach
        // the store before the session appends anything else.
        await this.appendUnstoredSuffix(stored, session)
        const agentHandle = await this.assembleAndPublish(
          ownerCtx,
          id,
          session,
          cwd,
          options.agentOptions,
          signal,
          options.setup,
          'resume',
          stored,
        )
        this.options.trace?.(`resume OK id=${String(id)}`)
        return agentHandle
      } finally {
        preparation[Symbol.dispose]()
      }
    } catch (error: unknown) {
      await handle.close().catch(() => undefined)
      this.options.trace?.(`resume FAILED id=${String(id)}: ${String(error)}`)
      throw error
    }
  }

  /**
   * Resolve the model route for one agent.
   */
  private resolveRoute(requested: AgentOptions | undefined): ResolvedRoute {
    return resolvePiRoute(this.options.model, this.options.pinModel === true ? undefined : requested)
  }

  /** Mint the Pi RPC child, build the scoped PiAgent, and publish the pair. */
  private async assembleAndPublish(
    ownerCtx: Context,
    id: SessionId,
    session: Session,
    cwd: string,
    agentOptions: AgentOptions | undefined,
    signal: AbortSignal | undefined,
    setup: CreateAgentOptions['setup'],
    source: PiSessionStartSource,
    stored: { handle: SessionHandle, storedCount: number } | undefined,
  ): Promise<AgentHandle> {
    ownerCtx.fiber.assertActive()
    if (signal?.aborted) throw new Error(`agent "${id}" creation aborted`)

    const requested = agentOptions
    const { route, provider, model } = this.resolveRoute(requested)

    // Rebuild the Pi session from DSH's durable log: the child inherits the
    // complete conversation (DSH-native turns and earlier Pi turns alike), so
    // a session handed off mid-stream continues with full context.
    const sessionFile = buildPiSessionFile({
      session,
      cwd,
      filePath: join(homedir(), '.dsh', 'pi-sessions', `${String(id).replace(/[^\w-]/g, '_')}.jsonl`),
      logger: this.options.logger,
    })
    const rpc = new PiRpcClient({
      cwd,
      model: route === '' ? undefined : route,
      piPath: this.options.piPath,
      sessionFile,
      signal,
      logger: this.options.logger,
    })
    const agent = new PiAgent({
      ctx: this.registryCtx,
      session,
      agentOptions: {
        ...agentOptions,
        // Only fill route fields the caller did not provide.
        ...(provider !== '' && requested?.provider === undefined ? { provider } : {}),
        ...(model !== '' && requested?.model === undefined ? { model } : {}),
      },
      rpc,
      // Continue the session's turn sequence: a resumed session must not
      // reopen turn 1.
      lastTurn: this.registryCtx.agents.turnBoundaryOf(session).lastTurn,
      logger: this.options.logger,
    })

    // Creation-window composition (the AgentFactory contract): await the
    // caller's setup on the agent's scoped context, invoke its synchronous
    // commit if any, and only then insert/announce — so no observer can see a
    // partially configured child world. Setup composes, it never drives. It
    // runs inside the try below so a rejection rolls the child back through
    // the same dispose path (agent, rpc child, scope).
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined
    const dispose = (): Promise<void> => (disposing ??= (async () => {
      try {
        agent.dispose()
        rpc.close()
      } finally {
        try {
          detachAgent?.()
          detachSession?.()
        } finally {
          // PiAgent.dispose() already unwinds its own scope.
          await stored?.handle.close().catch(() => undefined)
        }
      }
    })())
    const unfollowOwner = ownerCtx.effect(() => () => {
      if (disposing !== undefined) return
      void dispose()
    })

    try {
      detachSession = agent.ctx.sessions.enter(session)
      agent.ctx.sessions.announce(session)
      if (setup !== undefined) {
        try {
          const setupCommit = await setup(agent.ctx, agent)
          setupCommit?.commit()
        } catch (error: unknown) {
          this.options.trace?.(`setup FAILED id=${String(id)}: ${String(error)}`)
          throw error
        }
      }
      detachAgent = this.registryCtx.agents.enter(agent)
      // The registry announces the agent and runs the `agent/created`
      // listeners with the creation source (fresh session or resume).
      await this.registryCtx.agents.announce(agent, source)
      return { agent, dispose: () => dispose().then(() => undefined) }
    } catch (error: unknown) {
      await unfollowOwner?.()
      await dispose()
      throw error
    }
  }
}
