/**
 * v2 conversation timeline: read the official JSONL through
 * `sessionPersistence.open(id,'read')` and normalize it for the self-drawn
 * client. Unknown plugin events are preserved as `unknown`; a log this server
 * cannot fully interpret must never make the timeline unrenderable.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RwTimelineEntry, RwTimelineValue } from '../protocol.ts'
import { PluginError } from './errors.ts'

/** Event slicing limits for one backward page. */
export const TIMELINE_DEFAULT_LIMIT = 50
export const TIMELINE_MAX_LIMIT = 200
/** Per-entry text ceilings; tool output is commonly larger than a UI card. */
export const TIMELINE_MAX_TEXT_CHARS = 16_384
export const TIMELINE_MAX_ARGUMENT_CHARS = 8_192

interface HandleLike {
  read(offset?: number, length?: number): Promise<{ events: readonly unknown[] }>
  close(): Promise<void>
}

interface PersistenceLike {
  open(id: string, access: 'read'): Promise<HandleLike>
  stat?(id: string): Promise<{ readonly eventCount?: number } | undefined>
}

interface EventLike {
  readonly type?: unknown
  readonly seq?: unknown
  readonly time?: unknown
  readonly data?: unknown
  readonly ignorable?: unknown
}

type MutableEntry = { -readonly [K in keyof RwTimelineEntry]: RwTimelineEntry[K] }

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function bounded(text: string, max: number): { text: string; truncated: boolean; totalBytes: number } {
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (text.length <= max) return { text, truncated: false, totalBytes }
  return { text: `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`, truncated: true, totalBytes }
}

function blockText(content: unknown): { text: string; reasoning: string } {
  if (!Array.isArray(content)) return { text: '', reasoning: '' }
  let text = ''
  let reasoning = ''
  for (const block of content) {
    const value = asRecord(block)
    if (value['type'] === 'text' && typeof value['text'] === 'string') text += value['text']
    else if (value['type'] === 'reasoning' && typeof value['text'] === 'string') reasoning += value['text']
  }
  return { text, reasoning }
}

/** Stable across pages/connections: event seq + kind (+ stable sub-kind). */
function entryId(seq: number, kind: string, suffix = ''): string {
  return `${seq}:${kind}${suffix === '' ? '' : `:${suffix}`}`
}

/**
 * Normalize one event into zero or more timeline rows. This is pure and
 * tolerant: an event type unknown to this build becomes one `unknown` row
 * instead of failing the page.
 */
export function normalizeEvent(event: EventLike): RwTimelineEntry[] {
  const seq = asNumber(event.seq, 0)
  const time = asNumber(event.time, 0)
  const data = asRecord(event.data)
  const type = typeof event.type === 'string' ? event.type : 'unknown'
  const make = (kind: RwTimelineEntry['kind'], suffix = ''): { entryId: string; seq: number; time: number; kind: RwTimelineEntry['kind'] } => ({ entryId: entryId(seq, kind, suffix), seq, time, kind })
  switch (type) {
    case 'user/message': {
      // Human prompts are source kind 'user'; injected runtime context,
      // approval notices and other synthetic user-role messages are not chat.
      const source = asRecord(data['source'])
      if (source['kind'] !== 'user') return []
      const body = blockText(data['content'])
      const row = { ...make('user', ''), text: body.text, ...(typeof data['id'] === 'string' ? { messageId: data['id'] } : {}) }
      return [row as RwTimelineEntry]
    }
    case 'assistant/message': {
      const message = asRecord(data['message'])
      const body = blockText(message['content'])
      const rows: RwTimelineEntry[] = []
      if (body.reasoning !== '') rows.push({ ...make('reasoning'), text: bounded(body.reasoning, TIMELINE_MAX_TEXT_CHARS).text } as RwTimelineEntry)
      rows.push({ ...make('assistant', ''), text: bounded(body.text, TIMELINE_MAX_TEXT_CHARS).text, ...(data['interrupted'] === true ? { interrupted: true as const } : {}) } as RwTimelineEntry)
      return rows
    }
    case 'tool/call': {
      const args = typeof data['arguments'] === 'string' ? data['arguments'] : ''
      return [{ ...make('tool-call', ''), callId: String(data['callId'] ?? ''), name: String(data['name'] ?? ''), arguments: bounded(args, TIMELINE_MAX_ARGUMENT_CHARS).text } as RwTimelineEntry]
    }
    case 'tool/result': {
      const message = asRecord(data['message'])
      const body = blockText(message['content'])
      const limited = bounded(body.text, TIMELINE_MAX_TEXT_CHARS)
      const error = asRecord(data['error'])
      return [{
        ...make('tool-result', ''),
        callId: String(message['toolCallId'] ?? ''),
        isError: message['isError'] === true || Object.keys(error).length > 0,
        text: limited.text,
        ...(limited.truncated ? { truncated: true as const, totalBytes: limited.totalBytes } : {}),
        ...(Object.keys(error).length === 0 ? {} : { error: {
          ...(typeof error['name'] === 'string' ? { name: error['name'] } : {}),
          ...(typeof error['code'] === 'string' ? { code: error['code'] } : {}),
          ...(typeof error['reason'] === 'string' ? { reason: error['reason'] } : {}),
        } }),
      } as RwTimelineEntry]
    }
    case 'turn/start':
      return [{ ...make('turn', 'start'), phase: 'start', turn: asNumber(data['turn'], 0) } as RwTimelineEntry]
    case 'turn/end': {
      const reason = data['reason']
      return [{ ...make('turn', 'end'), phase: 'end', turn: asNumber(data['turn'], 0), ...(reason === undefined ? {} : { reason: typeof reason === 'string' ? reason : JSON.stringify(reason) }) } as RwTimelineEntry]
    }
    case 'assistant/attempt': {
      const stream = Array.isArray(data['stream']) ? data['stream'] : []
      let failure: Record<string, unknown> = {}
      for (const record of stream) {
        const chunk = asRecord(asRecord(record)['chunk'])
        if (chunk['type'] !== 'finish') continue
        const reason = asRecord(chunk['reason'])
        if (reason['kind'] === 'error' || reason['kind'] === 'aborted') failure = asRecord(reason['failure'])
      }
      return [{ ...make('error'), message: typeof failure['message'] === 'string' ? failure['message'] : 'assistant attempt failed', ...(typeof failure['code'] === 'string' ? { code: failure['code'] } : {}) } as RwTimelineEntry]
    }
    case 'approval/asked':
      return [{ ...make('approval', 'asked'), approvalId: String(data['id'] ?? ''), state: 'asked', toolName: String(data['toolName'] ?? ''), ...(typeof data['reason'] === 'string' ? { reason: data['reason'] } : {}) } as RwTimelineEntry]
    case 'approval/decided':
      return [{ ...make('approval', 'decided'), approvalId: String(data['id'] ?? ''), state: 'decided', ...(typeof data['outcome'] === 'string' ? { outcome: data['outcome'] } : {}) } as RwTimelineEntry]
    case 'agent/inbox/spliced':
    case 'model/selection':
    case 'plan/mode':
    case 'working-directory/change':
    case 'workspace/changes':
    case 'session/title-llm-request':
    case 'step/start':
    case 'step/end':
    case 'system/message':
    case 'developer/message':
    case 'request/header':
    case 'request/context':
    case 'session/end-seed':
    case 'session/title':
    case 'agent-preset/selected':
    case 'permission/preset':
    case 'sandbox/mode':
    case 'approval/policy':
      return []
    default:
      return [{ ...make('unknown', ''), type, ignorable: event.ignorable === true } as RwTimelineEntry]
  }
}

/** Normalize an ascending event slice. */
export function normalizeTimeline(events: readonly EventLike[]): RwTimelineEntry[] {
  const rows: RwTimelineEntry[] = []
  for (const event of events) rows.push(...normalizeEvent(event))
  return rows
}

/** Open errors get the stable not-found vocabulary. */
function openError(sessionId: string, error: unknown): never {
  const name = (error as { name?: string } | undefined)?.name
  if (name === 'SessionNotFoundError' || name === 'SessionPersistenceNotFoundError') {
    throw new PluginError('session-not-found', `session "${sessionId}" does not exist`, { sessionId })
  }
  throw error
}

/** Read one raw event slice from an already-open handle. */
async function slice(handle: HandleLike, offset: number, length: number): Promise<readonly EventLike[]> {
  if (length <= 0) return []
  return await (await handle.read(offset, length)).events as readonly EventLike[]
}

/** Walk backward until `limit` visible entries are collected (or seq 0). */
async function backwardEntries(handle: HandleLike, upper: number, limit: number): Promise<RwTimelineEntry[]> {
  let cursor = upper
  let collected: RwTimelineEntry[] = []
  while (cursor > 0 && collected.length < limit) {
    const start = Math.max(0, cursor - 64)
    const rows = normalizeTimeline(await slice(handle, start, cursor - start))
    collected = [...rows, ...collected]
    cursor = start
  }
  return collected.slice(-limit)
}

/** Walk forward until `limit` visible entries are collected (or end of log). */
async function forwardEntries(handle: HandleLike, lower: number, upper: number, limit: number): Promise<RwTimelineEntry[]> {
  let cursor = lower
  let collected: RwTimelineEntry[] = []
  while (cursor < upper && collected.length < limit) {
    const events = await slice(handle, cursor, Math.min(64, upper - cursor))
    collected.push(...normalizeTimeline(events))
    cursor += events.length
    if (events.length === 0) break
  }
  return collected.slice(0, limit)
}

/**
 * Read one page of normalized entries. `beforeSeq` (exclusive upper cursor)
 * returns the newest older page; `afterSeq` (exclusive lower cursor) returns
 * the oldest newer page. Paging counts normalized entries, so ignored log
 * events never consume the caller's limit. `nextBeforeSeq`/`nextAfterSeq`
 * are the oldest/newest returned entry seqs.
 */
export async function readTimeline(ctx: Context, params: Record<string, unknown>): Promise<RwTimelineValue> {
  const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
  if (sessionId === '') throw new PluginError('bad-request', 'session/timeline requires sessionId')
  const limitRaw = typeof params['limit'] === 'number' ? params['limit'] : TIMELINE_DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(TIMELINE_MAX_LIMIT, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : TIMELINE_DEFAULT_LIMIT))
  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
  if (persistence === undefined) throw new PluginError('internal', 'the profile has no sessionPersistence service')
  let handle: HandleLike
  try { handle = await persistence.open(sessionId, 'read') } catch (error) { openError(sessionId, error) }
  try {
    const stored = await persistence.stat?.(sessionId).catch(() => undefined)
    let eventCount = stored?.eventCount
    if (eventCount === undefined) eventCount = (await handle.read(0, Number.MAX_SAFE_INTEGER)).events.length
    const afterRaw = params['afterSeq']
    const beforeRaw = params['beforeSeq']
    if (typeof afterRaw === 'number' && Number.isSafeInteger(afterRaw) && afterRaw >= 0) {
      const lower = Math.min(afterRaw, eventCount)
      const entries = await forwardEntries(handle, lower, eventCount, limit)
      return {
        sessionId, entries, eventCount,
        beforeSeq: eventCount,
        nextBeforeSeq: entries[0]?.seq ?? null,
        afterSeq: afterRaw,
        nextAfterSeq: entries.at(-1)?.seq ?? null,
      }
    }
    const requested = typeof beforeRaw === 'number' && Number.isSafeInteger(beforeRaw) ? beforeRaw : eventCount
    const upper = Math.max(0, Math.min(eventCount, requested))
    const entries = await backwardEntries(handle, upper, limit)
    return {
      sessionId, entries, eventCount,
      beforeSeq: upper,
      nextBeforeSeq: entries[0]?.seq ?? null,
      afterSeq: -1,
      nextAfterSeq: entries.at(-1)?.seq ?? null,
    }
  } finally { await handle.close().catch(() => {}) }
}
