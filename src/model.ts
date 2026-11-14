/**
 * PiModel — the agent's durable model-choice facade.
 *
 * DSH's `Agent` contract exposes `agent.model`: the route the next step will
 * use, and the way to replace it. Since the Pi child owns the actual route
 * (Pi's own `provider/model`), the facade records the choice durably in the
 * session log (`model/selection`) so the frontend and the session log agree
 * on it, and reads it back on resume.
 */

import type { AgentOptions, Model, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'

/** The recorded selection of one session, with the live options as fallback. */
export interface ModelState {
  readonly lastUsed: ModelSelection | null
  readonly pending: ModelSelection | null
}

/** Compare two selections without comparing the reasoning effort. */
function sameRoute(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider && left.model === right.model
}

/** Compare two complete selections, treating an absent effort as its own value. */
export function sameModelSelection(left: ModelSelection | null, right: ModelSelection | null): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  return sameRoute(left, right) && left.reasoningEffort === right.reasoningEffort
}

/** Build a detached selection, omitting an absent effort. */
function toSelection(
  provider: string,
  model: string,
  reasoningEffort: ReasoningEffortId | undefined,
): ModelSelection {
  return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

/**
 * Rebuild the recorded selection of a session from its durable log.
 *
 * @param session - the session whose `model/selection` events are replayed.
 */
export function foldModelState(session: Session): ModelState {
  let pending: ModelSelection | null = null
  for (const event of session.snapshotEvents(session.inheritedEventCount)) {
    if (event.type !== 'model/selection') continue
    if (!sameModelSelection(pending, event.data)) pending = event.data
  }
  return { lastUsed: null, pending }
}

/**
 * The Pi driver's model facade.
 *
 * The recorded choice wins over the live options; a selection is durable
 * before it is visible.
 *
 * The selection is the DSH session's own record: the Pi child runs on the
 * route its own configuration names (see `pinModel`), and the DSH
 * selection does not reach it. The Pi agent has a model of its own.
 */
export class PiModel implements Model {
  private state: ModelState

  constructor(
    private readonly session: Session,
    private readonly options: AgentOptions,
    /**
     * Whether the route belongs to the agent rather than to the session.
     *
     * A pinned route is the agent's own: the plugin names it, and the
     * session's model selection never reaches the child. The durable
     * selection then records the route that actually runs, so the session
     * log and the frontend's projection agree with the child instead of
     * reporting a choice that was never applied.
     */
    private readonly pinned: boolean = true,
    /**
     * Applies a selection to the child.
     *
     * A session that owns its route (the plugin does not pin one) hands the
     * choice to the child: a recorded selection that never reaches the child
     * would be a lie in the log.
     */
    private readonly applyRoute?: (provider: string, model: string) => void,
  ) {
    this.state = foldModelState(session)
  }

  /** The route the next step will use. */
  current(): Readonly<ModelSelection> | undefined {
    if (this.pinned) return this.effective()
    const recorded = this.state.pending ?? this.state.lastUsed
    if (recorded !== null) return { ...recorded }
    return this.effective()
  }

  /** Replace the next step's complete selection. */
  select(selection: Readonly<ModelSelection>): void {
    // A pinned route is the agent's own: the session's choice is recorded
    // as the route that actually runs, so the log never names a model the
    // child did not use.
    const next = this.pinned
      ? this.effective() ?? toSelection(selection.provider, selection.model, selection.reasoningEffort)
      : toSelection(selection.provider, selection.model, selection.reasoningEffort)
    if (sameModelSelection(this.state.pending ?? this.state.lastUsed, next)) return
    const event = this.session.append('model/selection', next)
    this.state = { ...this.state, pending: event.data }
    // A session that owns its route hands the choice to the child.
    if (!this.pinned) this.applyRoute?.(next.provider, next.model)
  }

  /** The route the child runs on: the agent's own. */
  private effective(): Readonly<ModelSelection> | undefined {
    const { provider, model, reasoningEffort } = this.options
    return provider && model ? toSelection(provider, model, reasoningEffort) : undefined
  }
}
