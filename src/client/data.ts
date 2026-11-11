/**
 * Polling transport for the connection snapshot (protocol §16.14).
 *
 * The server profile cannot ask the client anything (P1 is client → server), so
 * the panel reads the cached snapshot over HTTP. Behaviour the doc fixes:
 *
 * - fetch every {@link CLIENT_TARGETS_POLL_MS} while the panel is mounted, plus
 *   immediately on `visibilitychange`/`focus` so a backgrounded tab is current
 *   the moment the user looks at it;
 * - a failed or unparsable read **keeps the previous render** and only flips the
 *   sync flag — an unreachable client must never look like "no connections";
 * - one instance per page: the panel subscribes, the module owns the timer.
 */
import { type RwClientTargetsValue } from '../protocol.ts'
import { CLIENT_TARGETS_POLL_MS, emptySnapshot, parseTargetsValue, targetsRequestPath } from './targets-model.ts'

/** How the last read went; `stale` keeps the previous list on screen. */
export type TargetsSync = 'loading' | 'ok' | 'stale'

/** What the panel renders. */
export interface TargetsFeedState {
  readonly snapshot: RwClientTargetsValue
  readonly sync: TargetsSync
  /** Whether at least one read completed (drives the loading vs empty choice). */
  readonly loaded: boolean
}

/** Minimal `fetch` seam (tests inject a fake). */
export type TargetsFetch = (input: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** The observable feed consumed by the panel. */
export interface TargetsFeed {
  subscribe(listener: () => void): () => void
  snapshot(): TargetsFeedState
  /** Start polling; call the returned disposer when the panel unmounts. */
  start(): () => void
  /** Force one read now (the panel's Refresh button). */
  refresh(): void
}

const LOADING: TargetsFeedState = { snapshot: emptySnapshot(), sync: 'loading', loaded: false }

/**
 * Create one feed.
 * @param options - transport injection for tests; production uses `globalThis`.
 * @returns the feed.
 */
export function createTargetsFeed(options: {
  readonly fetch?: TargetsFetch | undefined
  readonly path?: () => string
  readonly pollMs?: number
} = {}): TargetsFeed {
  let state: TargetsFeedState = LOADING
  const listeners = new Set<() => void>()
  let subscribers = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight = false
  let disposed = false

  const publish = (next: TargetsFeedState): void => {
    state = next
    for (const listener of listeners) listener()
  }

  const read = async (): Promise<void> => {
    if (inFlight || disposed) return
    inFlight = true
    try {
      const doFetch = options.fetch ?? defaultFetch()
      if (doFetch === undefined) {
        publish({ ...state, sync: 'stale' })
        return
      }
      const response = await doFetch(options.path?.() ?? targetsRequestPath())
      if (!response.ok) {
        publish({ ...state, sync: 'stale' })
        return
      }
      const parsed = parseTargetsValue(await response.json())
      if (parsed === undefined) {
        publish({ ...state, sync: 'stale' })
        return
      }
      publish({ snapshot: parsed, sync: 'ok', loaded: true })
    } catch {
      // Transport failure and malformed JSON are the same outcome for the panel:
      // keep the last list, flag the sync.
      publish({ ...state, sync: 'stale' })
    } finally {
      inFlight = false
    }
  }

  const attachWindowListeners = (): (() => void) => {
    const win = typeof window === 'undefined' ? undefined : window
    const doc = typeof document === 'undefined' ? undefined : document
    if (win === undefined || doc === undefined) return () => {}
    const onVisibility = (): void => {
      if (doc.visibilityState === 'visible') void read()
    }
    const onFocus = (): void => { void read() }
    // `visibilitychange` is dispatched at `document`; `focus` at `window`.
    doc.addEventListener('visibilitychange', onVisibility)
    win.addEventListener('focus', onFocus)
    return () => {
      doc.removeEventListener('visibilitychange', onVisibility)
      win.removeEventListener('focus', onFocus)
    }
  }

  let detachWindow: (() => void) | undefined

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    snapshot(): TargetsFeedState {
      return state
    },
    start(): () => void {
      subscribers += 1
      if (subscribers === 1) {
        disposed = false
        void read()
        timer = setInterval(() => { void read() }, options.pollMs ?? CLIENT_TARGETS_POLL_MS)
        detachWindow = attachWindowListeners()
      }
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        subscribers -= 1
        if (subscribers > 0) return
        disposed = true
        if (timer !== undefined) clearInterval(timer)
        timer = undefined
        detachWindow?.()
        detachWindow = undefined
      }
    },
    refresh(): void {
      void read()
    },
  }
}

/** `globalThis.fetch` when the page has one. */
function defaultFetch(): TargetsFetch | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  return async (input: string) => await (candidate as TargetsFetch)(input)
}

/** The page-wide feed; one timer regardless of how many components read it. */
export const targetsFeed: TargetsFeed = createTargetsFeed()
