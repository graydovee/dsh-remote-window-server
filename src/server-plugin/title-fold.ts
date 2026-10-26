/**
 * JSONL title/blank fold for cross-process session rows (protocol §16.8).
 *
 * The official list serves titles from the in-process projection cache; a
 * session written by another profile process therefore has no title here.
 * Folding the durable log tail is the v1 normal path (not an error fallback).
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionLogCache } from './session-log-cache.ts'

/** Minimal event shape read from the official JSONL log. */
interface LooseEvent {
  readonly type: string
  readonly time?: number
  readonly data?: { readonly title?: unknown }
}

/** Folded facts for one stored session. */
export interface FoldedFacts {
  readonly title?: string
  readonly titleSource: 'log' | 'fallback'
  readonly blank: boolean
  readonly updatedAt?: number
}

interface HandleLike {
  read(offset?: number, length?: number): Promise<{ events: readonly unknown[] }>
  close(): Promise<void>
}

interface PersistenceLike {
  open(id: string, access: 'read'): Promise<HandleLike>
}

/** Fold display facts from one complete event log. */
export function foldFacts(events: readonly unknown[]): FoldedFacts {
  let title: string | undefined
  let blank = true
  let updatedAt: number | undefined
  for (const raw of events) {
    const event = raw as LooseEvent
    if (typeof event.time === 'number' && (updatedAt === undefined || event.time > updatedAt)) updatedAt = event.time
    if (event.type === 'session/title') {
      const value = event.data?.title
      if (typeof value === 'string') title = value
    } else if (event.type === 'turn/start') {
      blank = false
    }
  }
  return {
    ...(title === undefined || title === '' ? {} : { title }),
    titleSource: title === undefined || title === '' ? 'fallback' : 'log',
    blank,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

/**
 * Memoized log folder: one read per session per artifact size, four in flight.
 * Read handles never take the write lease, so another process may keep writing.
 * Facts and the event count share `SessionLogCache` with `persist/open`.
 */
export class TitleFold {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(
    private readonly ctx: Context,
    private readonly cache: SessionLogCache = new SessionLogCache(),
  ) {}

  /** Fold one session, reusing the shared size-keyed result. */
  async facts(sessionId: string, sizeBytes: number | undefined): Promise<FoldedFacts | undefined> {
    if (sizeBytes !== undefined) {
      const cached = this.cache.get(sessionId, sizeBytes)
      if (cached?.facts !== undefined) return cached.facts
      try { this.cache.allowDecode(sessionId, sizeBytes) } catch (error) {
        console.error(`[dsh-remote-workspace-server] title fold for "${sessionId}" refused: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }
    const persistence = this.ctx.get('sessionPersistence') as PersistenceLike | undefined
    if (persistence === undefined) return undefined
    await this.acquire()
    try {
      const handle = await persistence.open(sessionId, 'read')
      try {
        const { events } = await handle.read(0)
        const facts = foldFacts(events)
        if (sizeBytes !== undefined) this.cache.rememberFacts(sessionId, sizeBytes, facts, events.length)
        return facts
      } finally {
        await handle.close().catch(() => {})
      }
    } catch (error) {
      console.error(`[dsh-remote-workspace-server] title fold for "${sessionId}" failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    } finally {
      this.release()
    }
  }

  /** Drop one cached fact (session event/disposal invalidation). */
  invalidate(sessionId: string): void {
    this.cache.invalidate(sessionId)
  }

  private async acquire(): Promise<void> {
    if (this.active < 4) { this.active += 1; return }
    await new Promise<void>(resolve => { this.waiting.push(resolve) })
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next !== undefined) next()
    else this.active -= 1
  }
}

/**
 * Resolve a session row's blank flag across live metadata, cold summary and the
 * JSONL fold.
 *
 * The official cold summary defaults `blank` to false when no projection cache
 * row exists (`summarizeCold`), so that value is not evidence for a session in
 * another process. Live summaries carry real projection metadata; cold rows
 * rely on the folded `turn/start` check.
 * @param metadataBlank - official sessionListMetadata.blank, when present.
 * @param live - whether the summary came from a live agent.
 * @param summaryBlank - the official summary's blank hint.
 * @param foldedBlank - the JSONL fold's blank verdict, when decoded.
 * @returns the row's blank flag.
 */
export function resolveBlank(
  metadataBlank: boolean | undefined,
  live: boolean,
  summaryBlank: boolean | undefined,
  foldedBlank: boolean | undefined,
): boolean {
  if (metadataBlank !== undefined) return metadataBlank
  if (live && summaryBlank !== undefined) return summaryBlank
  return foldedBlank ?? summaryBlank ?? true
}
