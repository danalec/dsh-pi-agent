/**
 * PiInbox — the durable pending-input store owned by the Pi driver.
 *
 * DSH's `Agent` contract exposes an `Inbox` facade: the pending
 * `next-turn`/`next-step` message lists plus the mutations that queue,
 * replace, or cancel that input. Since DSH 0.2 the interface is structural
 * and the concrete storage belongs to the driver, so the Pi driver owns this
 * implementation.
 *
 * The state is durable: every mutation is recorded as an
 * `agent/inbox/spliced` session event, and a resumed session restores its
 * pending input by folding those events out of the session log. The fold
 * happens once, at construction; afterwards the live state is maintained
 * incrementally.
 */

import type { Inbox as DshInbox, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'

/** The two ordered pending-message lists owned by one agent. */
export interface PiInboxState {
  readonly 'next-turn': readonly UserMessage[]
  readonly 'next-step': readonly UserMessage[]
}

/** Live notifications committed by inbox mutations. */
export interface PiInboxNotifications {
  /** One message entered the pending list. */
  inserted(message: UserMessage): void
  /** One message left the pending list as a cancellation. */
  discarded(message: UserMessage): void
  /** One message was claimed by an open turn. */
  claimed(message: UserMessage, turn: number): void
}

/**
 * Fold one durable splice into a pending-input state.
 *
 * @throws when the splice does not fit the state it is applied to.
 */
export function applyInboxSplice(state: PiInboxState, splice: SessionEvent<'agent/inbox/spliced'>['data']): PiInboxState {
  const inbox = state[splice.target]
  const removedCount = splice.removedCount ?? 0
  if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
    || !Number.isSafeInteger(removedCount) || removedCount < 0
    || splice.start + removedCount > inbox.length) {
    throw new Error('invalid inbox splice')
  }
  const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
  const ids = new Set<string>()
  for (const message of splice.target === 'next-turn'
    ? [...next, ...state['next-step']]
    : [...state['next-turn'], ...next]) {
    if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
    ids.add(message.id)
  }
  return splice.target === 'next-turn'
    ? { 'next-turn': next, 'next-step': state['next-step'] }
    : { 'next-turn': state['next-turn'], 'next-step': next }
}

/**
 * Rebuild the pending-input state of a session from its durable log.
 *
 * @param session - the session whose inbox splices are replayed.
 * @returns the pending state after the whole log.
 */
export function foldInboxState(session: Session): PiInboxState {
  let state: PiInboxState = { 'next-turn': [], 'next-step': [] }
  for (const event of session.snapshotEvents(session.inheritedEventCount)) {
    if (event.type !== 'agent/inbox/spliced') continue
    try {
      state = applyInboxSplice(state, event.data)
    } catch (error: unknown) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  }
  return state
}

/**
 * The Pi driver's inbox facade.
 *
 * The live state is the projection of the session's durable splices; this
 * class computes normalized splice coordinates, appends the durable event,
 * and publishes the live notifications.
 */
export class PiInbox implements DshInbox {
  private state: PiInboxState

  constructor(
    private readonly session: Session,
    private readonly notifications: PiInboxNotifications,
  ) {
    this.state = foldInboxState(session)
  }

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.state['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.state['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    return this.state['next-turn'].length > 0 || this.state['next-step'].length > 0
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the batch proposed for one step, publishing each
   * claimed message. The durable splices are pure deletions.
   *
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') {
      claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    }
    for (const message of claimed) this.notifications.claimed(message, turn)
    return claimed
  }

  /** Append one message to a pending list. */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.state[target].length, 0, [message])
  }

  /** Prepend one message to a pending list. */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place.
   *
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * Remove one pending message.
   *
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /** Apply standard splice semantics and durably record the result. */
  splice(target: InboxTarget, start: number, deleteCount: number, inserted: UserMessage[]): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget, index: number } | undefined {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = this.state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Commit one normalized mutation and publish its live notifications. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const inbox = this.state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    // Validate before the durable commit: a rejected splice must not change
    // the log.
    const candidate = applyInboxSplice(this.state, splice)
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    const event = this.session.append('agent/inbox/spliced', splice)
    this.state = candidate
    if (discardRemoved) {
      for (const message of removed) this.notifications.discarded(message)
    }
    for (const message of event.data.inserted) this.notifications.inserted(message)
    return removed
  }
}
