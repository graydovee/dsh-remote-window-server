/**
 * Shared per-artifact facts cache for the plugin's two log decodes.
 *
 * `persist/open` needs an exact event count and `session/list` needs folded
 * title/blank facts. Both read the same official JSONL artifact, so they share
 * one `(sessionId, sizeBytes)` entry: whichever path decodes first stores both
 * values and the other path reuses them. The official backend's own revision
 * memo is an internal accelerator, not a contract guarantee.
 */
import { PluginError } from './errors.ts'
import type { FoldedFacts } from './title-fold.ts'

/** Warn once per artifact above this size when one decode is needed. */
export const EVENT_COUNT_DECODE_WARN_BYTES = 8 * 1024 * 1024

/** Hard ceiling: refuse to decode above this size instead of risking an OOM. */
export const EVENT_COUNT_DECODE_MAX_BYTES = 128 * 1024 * 1024

/** Bound the per-artifact memo table. */
const CACHE_LIMIT = 512

interface Entry {
  readonly sizeBytes: number
  eventCount?: number
  facts?: FoldedFacts
}

/** Bounded `(sessionId, sizeBytes)` → `{eventCount, foldedFacts}` memo. */
export class SessionLogCache {
  private readonly entries = new Map<string, Entry>()
  private readonly warned = new Set<string>()

  private key(sessionId: string, sizeBytes: number): string {
    return `${sessionId}\0${sizeBytes}`
  }

  /** Read the entry for one artifact identity. */
  get(sessionId: string, sizeBytes: number): Entry | undefined {
    return this.entries.get(this.key(sessionId, sizeBytes))
  }

  /**
   * Apply the size policy before one decode: warn once above the soft limit,
   * refuse above the hard ceiling.
   */
  allowDecode(sessionId: string, sizeBytes: number): void {
    if (sizeBytes > EVENT_COUNT_DECODE_MAX_BYTES) {
      throw new PluginError('internal', `session "${sessionId}" log is ${sizeBytes} bytes; refusing to decode its facts above the ${EVENT_COUNT_DECODE_MAX_BYTES} byte safety ceiling`, { sessionId, sizeBytes, ceilingBytes: EVENT_COUNT_DECODE_MAX_BYTES })
    }
    if (sizeBytes <= EVENT_COUNT_DECODE_WARN_BYTES) return
    const key = this.key(sessionId, sizeBytes)
    if (this.warned.has(key)) return
    this.warned.add(key)
    console.error(`[dsh-remote-workspace-server] session "${sessionId}" log is ${sizeBytes} bytes; decoding it once for exact session facts (subsequent opens reuse this cache and the official revision memo)`)
  }

  /** Store facts decoded by a title fold (and the event count it observed). */
  rememberFacts(sessionId: string, sizeBytes: number, facts: FoldedFacts, eventCount: number): void {
    this.update(sessionId, sizeBytes, { facts, eventCount })
  }

  /** Store both values decoded for an event count. */
  rememberCount(sessionId: string, sizeBytes: number, eventCount: number, facts: FoldedFacts): void {
    this.update(sessionId, sizeBytes, { eventCount, facts })
  }

  /** Drop every entry of one session (session event/disposal invalidation). */
  invalidate(sessionId: string): void {
    const prefix = `${sessionId}\0`
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key)
    for (const key of [...this.warned]) if (key.startsWith(prefix)) this.warned.delete(key)
  }

  private update(sessionId: string, sizeBytes: number, fields: { eventCount?: number; facts?: FoldedFacts }): void {
    const key = this.key(sessionId, sizeBytes)
    const existing = this.entries.get(key)
    this.entries.delete(key)
    this.entries.set(key, {
      sizeBytes,
      ...(existing?.eventCount === undefined && fields.eventCount === undefined ? {} : { eventCount: fields.eventCount ?? existing?.eventCount }),
      ...(existing?.facts === undefined && fields.facts === undefined ? {} : { facts: fields.facts ?? existing?.facts }),
    })
    if (this.entries.size > CACHE_LIMIT) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }
}
