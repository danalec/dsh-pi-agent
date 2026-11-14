/**
 * History handoff — bridge a DSH session's durable event log into a Pi
 * session file.
 *
 * The Pi child processes we spawn (`pi --mode rpc`) normally start with an
 * empty context: the bridge translates new turns as they arrive, but nothing
 * tells the child what happened BEFORE it took over. That is fine for a
 * session born under Pi, and it is the gap this module closes for
 * mid-session handoff: a session that already ran turns under DSH's own
 * loop (or under an earlier Pi child) is rebuilt as a Pi v3 session file, so
 * the new child resumes with the full conversation in its context window.
 *
 * DSH is the durable source of truth. Every turn — DSH-native or Pi-driven —
 * lands in the session's event log (`user/message`, `assistant/message`,
 * `tool/call`, `tool/result`). Each `create`/`resume` rebuilds the Pi file
 * from that log, so the child always sees the complete history regardless of
 * which engine produced any given turn.
 *
 * Pi session files are JSONL, one entry per line:
 *
 *   {"type":"session","version":3,"id":"uuid","timestamp":"…","cwd":"…"}
 *   {"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"…","message":{…}}
 *
 * The v3 shape is what `pi --session <file>` loads natively (auto-migrated to
 * the current internal version on open). DSH message blocks map to Pi blocks
 * as follows:
 *
 *   dsh text          → pi text
 *   dsh reasoning     → pi thinking
 *   dsh tool-call     → pi toolCall  (arguments JSON string re-parsed)
 *   dsh image         → skipped (attachment refs need the attachment service)
 *   dsh tool-result   → pi toolResult (tool name recovered from the call log)
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  AssistantMessage,
  ContentBlock,
  TokenUsage,
  ToolResultMessage,
  UserMessage,
} from '@deepseek-ai/dsh-llm'

/** Pi v3 session file entry shapes (structural mirror, no pi dependency). */
export interface PiSessionHeader {
  type: 'session'
  version: 3
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
}

interface PiTextBlock { type: 'text'; text: string }
interface PiThinkingBlock { type: 'thinking'; thinking: string }
interface PiToolCallBlock { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }

/** Pi's token usage shape (the session reader requires it on assistant messages). */
export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

export interface PiMessage {
  role: 'user' | 'assistant' | 'toolResult'
  content: string | Array<PiTextBlock | PiThinkingBlock | PiToolCallBlock>
  /** assistant-only */
  provider?: string
  model?: string
  usage?: PiUsage
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  /** toolResult-only */
  toolCallId?: string
  toolName?: string
  isError?: boolean
  /** Unix epoch milliseconds (Pi's message timestamp unit). */
  timestamp?: number
}

export interface PiMessageEntry {
  type: 'message'
  id: string
  parentId: string | null
  timestamp: string
  message: PiMessage
}

export interface BuildPiSessionFileOptions {
  /** DSH session whose event log is the history source. */
  session: Session
  /** Working directory recorded on the Pi session header. */
  cwd: string
  /** Destination file path for the Pi session. */
  filePath: string
  /**
   * Byte budget for the rebuilt file.
   *
   * The rebuilt file is the child's context, and the provider refuses a
   * request whose context does not fit the model's window ("context window
   * exceeds limit"). A session whose log grew past the budget is rebuilt
   * with its oldest messages dropped, the way the native loop compacts.
   *
   * Defaults to {@link DEFAULT_CONTEXT_BUDGET_BYTES}.
   */
  contextBudgetBytes?: number
  /** Diagnostics sink. */
  logger?: (line: string) => void
}

/**
 * Default byte budget for the rebuilt Pi session file.
 *
 * The provider rejects the request well before this size — a session with a
 * 90 MB file fails with "context window exceeds limit", and one with 3 MB
 * still fits. The budget leaves room for the model's own context window and
 * for Pi's compaction, which runs on the rebuilt file afterwards.
 */
export const DEFAULT_CONTEXT_BUDGET_BYTES = 1_048_576

/** Map a DSH finish reason to the Pi stopReason vocabulary. */
function mapStopReason(reason: { kind: string } | undefined, hasToolCalls: boolean): PiMessage['stopReason'] {
  if (hasToolCalls) return 'toolUse'
  switch (reason?.kind) {
    case 'max-tokens': return 'length'
    case 'aborted': return 'aborted'
    case 'error': return 'error'
    default: return 'stop'
  }
}

/** Convert one DSH content block to Pi blocks; returns [] when skipped. */
function convertBlocks(blocks: readonly ContentBlock[], logger?: (line: string) => void): Array<PiTextBlock | PiThinkingBlock | PiToolCallBlock> {
  const out: Array<PiTextBlock | PiThinkingBlock | PiToolCallBlock> = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        out.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call': {
        let argumentsRecord: Record<string, unknown> = {}
        if (block.arguments !== '') {
          try {
            const parsed: unknown = JSON.parse(block.arguments)
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              argumentsRecord = parsed as Record<string, unknown>
            }
          } catch {
            argumentsRecord = { raw: block.arguments }
          }
        }
        out.push({ type: 'toolCall', id: String(block.id), name: block.name, arguments: argumentsRecord })
        break
      }
      case 'image':
        // Attachment refs resolve through the attachment service at run time;
        // the rebuild path has no such handle. Text history carries context;
        // images are dropped with a notice.
        logger?.(`[history] skipping image block (attachment ref)`)
        break
      default:
        break
    }
  }
  return out
}

/**
 * Convert a DSH user message to the Pi user message shape.
 *
 * Pi's `UserMessage.content` is `string | (TextContent | ImageContent)[]` —
 * thinking blocks are not valid there, so only text survives.
 */
function toPiUserMessage(message: UserMessage, timestamp: number, logger?: (line: string) => void): PiMessage {
  const blocks = convertBlocks(message.content, logger)
  const text = blocks
    .filter((block): block is PiTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return { role: 'user', content: text, timestamp }
}

/**
 * Convert a DSH token usage into Pi's usage shape.
 *
 * Pi's session reader needs the usage on an assistant message: without it the
 * context estimate has no token count and the resumed run cannot prepare its
 * request.
 */
function convertUsage(usage: TokenUsage | undefined): PiUsage {
  const input = usage?.inputTokens ?? 0
  const output = usage?.outputTokens ?? 0
  const cacheRead = usage?.cacheReadTokens ?? 0
  const cacheWrite = usage?.cacheWriteTokens ?? 0
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/** Convert a DSH assistant message to the Pi assistant message shape. */
function toPiAssistantMessage(
  event: SessionEvent<'assistant/message'>,
  finishReasons: ReadonlyMap<number, { kind: string }>,
  logger?: (line: string) => void,
): PiMessage | undefined {
  const message = event.data.message as AssistantMessage
  const blocks = convertBlocks(message.content, logger)
  if (blocks.length === 0) return undefined
  const hasToolCalls = blocks.some((block) => block.type === 'toolCall')
  const source = message.source as { kind?: string; provider?: string; model?: string } | undefined
  return {
    role: 'assistant',
    content: blocks,
    ...(source?.provider !== undefined ? { provider: source.provider } : {}),
    ...(source?.model !== undefined ? { model: source.model } : {}),
    usage: convertUsage(event.data.usage),
    stopReason: mapStopReason(finishReasons.get(event.data.turn), hasToolCalls),
    timestamp: event.time,
  }
}

/** Convert a DSH tool result to the Pi toolResult message shape. */
function toPiToolResultMessage(
  event: SessionEvent<'tool/result'>,
  toolNames: ReadonlyMap<string, string>,
  logger?: (line: string) => void,
): PiMessage {
  const message = event.data.message as ToolResultMessage
  const callId = String(message.toolCallId)
  const content = convertBlocks(message.content, logger)
  return {
    role: 'toolResult',
    content,
    toolCallId: callId,
    toolName: toolNames.get(callId) ?? 'unknown',
    isError: message.isError === true,
    timestamp: event.time,
  }
}

/** Deterministic 8-char hex entry id from the source event seq. */
function entryId(seq: number): string {
  return `e${seq.toString(16).padStart(7, '0')}`
}

/**
 * Derive a stable, UUID-shaped session id from the DSH session id.
 *
 * The rebuilt file must keep its identity across resumes: a fresh random id
 * on every rebuild would make Pi treat each handoff as a different session.
 */
function deriveSessionId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/**
 * Cut the rebuilt history down to the byte budget.
 *
 * The rebuilt file is the child's context, and the provider refuses a
 * request whose context does not fit the model's window. The oldest
 * messages are dropped, the way the native loop compacts.
 *
 * Two invariants survive the cut:
 *
 * - a tool result never outlives the tool call it answers. Pi rejects a
 *   session whose tool result names an unknown tool id, so a result whose
 *   call was dropped is dropped with it;
 * - the chain of `parentId` links stays intact: the first kept entry
 *   becomes the root of the kept chain.
 *
 * @param entries - the rebuilt entries, oldest first.
 * @param budget - the byte budget for the serialized entries.
 * @param logger - diagnostics sink.
 * @returns the kept entries.
 */
export function fitContextBudget(
  entries: readonly PiMessageEntry[],
  budget: number,
  logger?: (line: string) => void,
): PiMessageEntry[] {
  const sizes = entries.map((entry) => JSON.stringify(entry).length)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total <= budget) return [...entries]

  // The tool call each tool result answers, and the entry that announced it.
  const announcedAt = new Map<string, number>()
  entries.forEach((entry, index) => {
    const content = entry.message.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block.type === 'toolCall') announcedAt.set(block.id, index)
    }
  })

  // Drop from the oldest end until the rest fits.
  let start = 0
  let keptSize = total
  while (start < entries.length && keptSize > budget) {
    keptSize -= sizes[start]
    start += 1
  }

  // A tool result whose call was dropped is dropped with it: Pi refuses a
  // session whose tool result names an unknown tool id.
  const kept: PiMessageEntry[] = []
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index]
    const callId = entry.message.toolCallId
    if (callId !== undefined) {
      const announced = announcedAt.get(callId)
      if (announced === undefined || announced < start) continue
    }
    kept.push(entry)
  }

  // The kept chain starts at its own root: the parent of the first kept
  // entry was dropped.
  if (kept.length > 0) {
    kept[0] = { ...kept[0], parentId: null }
  }
  const dropped = entries.length - kept.length
  logger?.(`[history] dropped ${dropped} of ${entries.length} entries to fit ${budget} bytes (was ${total})`)
  return kept
}

/**
 * Rebuild a Pi v3 session file from a DSH session's event log.
 *
 * @returns the written file path (the `filePath` argument).
 */
export function buildPiSessionFile(options: BuildPiSessionFileOptions): string {
  const { session, cwd, filePath, logger } = options
  const budget = options.contextBudgetBytes ?? DEFAULT_CONTEXT_BUDGET_BYTES

  const toolNames = new Map<string, string>()
  const finishReasons = new Map<number, { kind: string }>()
  const entries: PiMessageEntry[] = []
  let parentId: string | null = null

  // Turn reasons are recorded by `turn/end`, which the log orders AFTER the
  // assistant message it describes. Collect them first, otherwise every
  // assistant message would fall back to the default stop reason.
  const events = session.snapshotEvents(session.inheritedEventCount)
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    finishReasons.set(event.data.turn, event.data.reason as { kind: string })
  }

  for (const event of events) {
    switch (event.type) {
      case 'tool/call':
        toolNames.set(String(event.data.callId), event.data.name)
        break
      case 'user/message': {
        const message = toPiUserMessage(event.data as UserMessage, event.time, logger)
        const id = entryId(event.seq)
        entries.push({ type: 'message', id, parentId, timestamp: new Date(event.time).toISOString(), message })
        parentId = id
        break
      }
      case 'assistant/message': {
        const message = toPiAssistantMessage(event, finishReasons, logger)
        if (message === undefined) break
        const id = entryId(event.seq)
        entries.push({ type: 'message', id, parentId, timestamp: new Date(event.time).toISOString(), message })
        parentId = id
        break
      }
      case 'tool/result': {
        const message = toPiToolResultMessage(event, toolNames, logger)
        const id = entryId(event.seq)
        entries.push({ type: 'message', id, parentId, timestamp: new Date(event.time).toISOString(), message })
        parentId = id
        break
      }
      default:
        break
    }
  }

  const kept = fitContextBudget(entries, budget, logger)

  const header: PiSessionHeader = {
    type: 'session',
    version: 3,
    id: deriveSessionId(String(session.id)),
    timestamp: new Date().toISOString(),
    cwd,
  }
  const lines = [JSON.stringify(header), ...kept.map((entry) => JSON.stringify(entry))]
  mkdirSync(dirname(filePath), { recursive: true })
  // Write through a temporary file so a crash mid-write cannot leave a
  // truncated session behind (Pi would silently parse the missing lines).
  const temporary = `${filePath}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(temporary, `${lines.join('\n')}\n`)
  renameSync(temporary, filePath)
  logger?.(`[history] wrote ${kept.length} message entries to ${filePath}`)
  return filePath
}
