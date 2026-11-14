/**
 * The `inbox` session projection — the pending input of a session.
 *
 * `@deepseek-ai/dsh-agent-loop` owns this projection, and the Pi loop
 * REPLACES that plugin: with the native loop disabled, nothing else
 * registers the key. The frontend's queue dock reads it
 * (`projections.faceOf('inbox')`) to render the queued and steering items,
 * so without it the queue is invisible in the UI.
 *
 * The fold is the same one the driver owns (`applyInboxSplice`): the
 * projection is a view of the durable `agent/inbox/spliced` events, and the
 * driver keeps the same state in memory.
 */

import { z } from 'zod'
import type { InboxState, InboxWireState } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { applyInboxSplice } from './inbox.ts'

/** Wire validation for pending agent input reconstructed from durable inbox splices. */
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

/**
 * The `inbox` projection unit.
 *
 * Registered with the same key, state version and wire shape as the native
 * loop's, so both plugins may be mounted at once: the registry counts
 * registrants per key and shares one unit between them.
 */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: inboxProjectionSchema,
  init: (): InboxState => ({ 'next-turn': [], 'next-step': [] }),
  apply(state: InboxState, event: SessionEvent): InboxState {
    if (event.type !== 'agent/inbox/spliced') return state
    try {
      return applyInboxSplice(state, event.data)
    } catch (error: unknown) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  },
  wire: {
    // The wire value is the fold state itself: every pending message already
    // round-trips the session log as lossless JSON. Only the static type
    // narrows to the JSON-safe projection table entry.
    viewSchema: inboxProjectionSchema as unknown as z.ZodType<InboxWireState>,
    view: (state: InboxState) => state as unknown as InboxWireState,
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'inbox', InboxState>
