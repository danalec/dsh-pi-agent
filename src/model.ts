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
 */
export class PiModel implements Model {
  private state: ModelState

  constructor(
    private readonly session: Session,
    private readonly options: AgentOptions,
    /**
     * Applies a selection to the child.
     *
     * The Pi child owns the route, so a durable selection only takes effect
     * when the child is switched to it. Without this the frontend's model
     * switcher would record the choice and the run would keep using the
     * model the child started with.
     */
    private readonly applyRoute?: (provider: string, model: string) => void,
  ) {
    this.state = foldModelState(session)
  }

  /** The route the next step will use. */
  current(): Readonly<ModelSelection> | undefined {
    const recorded = this.state.pending ?? this.state.lastUsed
    if (recorded !== null) return { ...recorded }
    const { provider, model, reasoningEffort } = this.options
    return provider && model ? toSelection(provider, model, reasoningEffort) : undefined
  }

  /** Replace the next step's complete selection. */
  select(selection: Readonly<ModelSelection>): void {
    const next = toSelection(selection.provider, selection.model, selection.reasoningEffort)
    if (sameModelSelection(this.state.pending ?? this.state.lastUsed, next)) return
    const event = this.session.append('model/selection', next)
    this.state = { ...this.state, pending: event.data }
    // The child owns the route: the durable selection becomes real only when
    // the child is switched to it.
    this.applyRoute?.(next.provider, next.model)
  }
}
