/**
 * v2 session SSE: follow one official JSONL from an exclusive `afterSeq`
 * cursor, emit normalized timeline rows, and keep the connection alive with
 * comments. The log remains the source of truth; the stream has no replay
 * state of its own, so a reconnect with the last seen seq resumes exactly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RwApprovalSummary, RwSessionSseFrame } from '../protocol.ts'
import { PluginError } from './errors.ts'
import { normalizeTimeline } from './timeline.ts'

export const SESSION_EVENTS_POLL_MS = 250
export const SESSION_EVENTS_HEARTBEAT_MS = 15_000
export const SESSION_EVENTS_BATCH = 200

interface HandleLike {
  read(offset?: number, length?: number): Promise<{ events: readonly unknown[] }>
  close(): Promise<void>
}

interface PersistenceLike {
  open(id: string, access: 'read'): Promise<HandleLike>
  stat?(id: string): Promise<{ readonly eventCount?: number } | undefined>
}

/** Minimal sink so the route owns Node's res and tests can collect frames. */
export interface SessionEventSink {
  send(frame: RwSessionSseFrame): void
  comment?(text: string): void
  closed(): boolean
}

/** Pending-approval source; implemented by the v2 approval hub. */
export interface ApprovalSource {
  subscribe(sessionId: string, listener: (approval: RwApprovalSummary) => void): () => void
}

/** Parse the query string without trusting downstream decoding. */
export function sessionEventParams(url: string | undefined): { sessionId: string; afterSeq: number } {
  const query = new URL(url ?? '/', 'http://127.0.0.1').searchParams
  const sessionId = query.get('sessionId') ?? ''
  if (sessionId === '') throw new PluginError('bad-request', 'session/events requires sessionId')
  const raw = query.get('afterSeq')
  const afterSeq = raw === null || raw === '' ? -1 : Number(raw)
  if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw new PluginError('bad-request', 'afterSeq must be -1 or a non-negative integer')
  return { sessionId, afterSeq }
}

/** Sleep that resolves early when the stream is aborted. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(done, ms)
    timer.unref()
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Run one SSE session stream until the client disconnects or the profile
 * unloads. `afterSeq` is the last committed ordinary event seq the client
 * already rendered; `-1` starts from the first event.
 */
export async function streamSessionEvents(
  ctx: Context,
  options: {
    readonly sessionId: string
    readonly afterSeq: number
    readonly sink: SessionEventSink
    readonly signal: AbortSignal
    readonly approvals?: ApprovalSource
  },
): Promise<void> {
  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
  if (persistence === undefined) throw new PluginError('internal', 'the profile has no sessionPersistence service')
  let handle: HandleLike
  try {
    handle = await persistence.open(options.sessionId, 'read')
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name
    if (name === 'SessionNotFoundError' || name === 'SessionPersistenceNotFoundError') {
      throw new PluginError('session-not-found', `session "${options.sessionId}" does not exist`, { sessionId: options.sessionId })
    }
    throw error
  }
  const unsubscribe = options.approvals?.subscribe(options.sessionId, approval => {
    if (!options.sink.closed()) options.sink.send({ event: 'approval', data: approval })
  })
  let cursor = options.afterSeq
  let lastStatus = ''
  let lastHeartbeat = Date.now()
  try {
    const stored = await persistence.stat?.(options.sessionId).catch(() => undefined)
    let initialCount = stored?.eventCount
    if (initialCount === undefined) {
      // JSONL snapshots may omit eventCount; one read establishes the cursor.
      const all = await handle.read(0, Number.MAX_SAFE_INTEGER)
      initialCount = all.events.length
    }
    options.sink.send({ event: 'ready', data: { sessionId: options.sessionId, afterSeq: cursor, eventCount: initialCount } })
    let idlePolls = 0
    while (!options.signal.aborted && !options.sink.closed()) {
      const offset = cursor + 1
      const slice = await handle.read(offset, SESSION_EVENTS_BATCH)
      if (slice.events.length > 0) {
        // `afterSeq` is the last rendered event seq: never repeat a visible row.
        const entries = normalizeTimeline(slice.events as never).filter(entry => entry.seq > options.afterSeq)
        cursor = offset + slice.events.length - 1
        if (entries.length > 0) {
          const count = await persistence.stat?.(options.sessionId).then(value => value?.eventCount, () => undefined)
          options.sink.send({ event: 'timeline', data: { sessionId: options.sessionId, entries, afterSeq: cursor, eventCount: count ?? cursor + 1 } })
        }
        idlePolls = 0
      } else {
        idlePolls += 1
      }
      if (idlePolls > 0 && idlePolls % 8 === 0) {
        const status = sessionStatus(ctx, options.sessionId)
        const serialized = JSON.stringify(status)
        if (serialized !== lastStatus) {
          lastStatus = serialized
          options.sink.send({ event: 'status', data: status })
        }
      }
      if (Date.now() - lastHeartbeat >= SESSION_EVENTS_HEARTBEAT_MS) {
        lastHeartbeat = Date.now()
        options.sink.comment?.('ping')
      }
      await delay(SESSION_EVENTS_POLL_MS, options.signal)
    }
  } finally {
    unsubscribe?.()
    await handle.close().catch(() => {})
  }
}

interface AgentLike {
  readonly id?: unknown
  readonly status?: string
}

interface AgentsLike {
  get(id: string): AgentLike | undefined
  list(): readonly AgentLike[]
}

/** Status frame body; kept here so the SSE loop and `session/status` agree. */
export function sessionStatus(ctx: Context, sessionId: string, pending: readonly RwApprovalSummary[] = []): import('../protocol.ts').RwSessionStatusValue {
  const agents = ctx.get('agents') as AgentsLike | undefined
  const agent = agents?.get(sessionId)
  const status = typeof agent?.status === 'string' ? agent.status : undefined
  return {
    sessionId,
    agentAvailable: agent !== undefined,
    ...(status === undefined ? {} : { status }),
    running: status === 'running',
    pendingApprovals: pending,
  }
}
