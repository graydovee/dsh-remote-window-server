/**
 * Client connection snapshot (protocol §16.14).
 *
 * The client host is the only authority for the connection list; this module is
 * the server profile's in-memory copy of the last published snapshot. It never
 * touches disk: a profile restart, a lease release or a plugin reload simply
 * starts empty and the client republishes on its next tick.
 *
 * Two rules make the copy safe to expose to the server profile's browser:
 *
 * - **Whitelist, never passthrough.** A row is rebuilt from the fields this
 *   module knows; anything else in the published JSON is dropped, and rows that
 *   fail a required field (id, kind, phase) are dropped whole instead of being
 *   shown half-invalid.
 * - **Re-scrub on arrival.** The client already scrubs, but this process is the
 *   one that shows the text, so `scrubSecrets` runs again before anything is
 *   retained (AGENTS.md: errors, logs and payloads are scrubbed on both ends).
 */
import {
  type RwClientTarget,
  type RwClientTargetPhase,
  type RwClientTargetsValue,
} from '../protocol.ts'
import { PluginError, scrubSecrets } from './errors.ts'

/** Hard row ceiling; a longer list is truncated, never rejected. */
export const CLIENT_TARGETS_MAX_ROWS = 64

/** Longest accepted target id (target ids are opaque, client-minted strings). */
export const CLIENT_TARGET_ID_MAX = 200

/** Longest accepted user-visible label. */
export const CLIENT_TARGET_LABEL_MAX = 200

/** Longest accepted host / WSL distribution name. */
export const CLIENT_TARGET_HOST_MAX = 255

/** Longest accepted username. */
export const CLIENT_TARGET_USERNAME_MAX = 128

/** Phases the browser knows how to render; anything else is not a connection state. */
export const CLIENT_TARGET_PHASES: readonly RwClientTargetPhase[] = [
  'connecting', 'ready', 'degraded', 'failed', 'stopped', 'disconnected',
]

/** Outcome of one `client/targets` publication. */
export interface ClientTargetsAcceptResult {
  /** False when the value lost the monotonic `updatedAt` race. */
  readonly accepted: boolean
  /** Snapshot stamp now retained (the previous one when the value was dropped). */
  readonly updatedAt: number
  /** Retained row count. */
  readonly count: number
}

/** The empty snapshot the route serves before the client publishes anything. */
export function emptyClientTargets(): RwClientTargetsValue {
  return { clientId: '', updatedAt: 0, targets: [] }
}

/** Trimmed string within a byte-agnostic length budget, or undefined. */
function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) return undefined
  return scrubSecrets(trimmed)
}

/** Integer inside an inclusive range, or undefined. */
function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
  return value >= min && value <= max ? value : undefined
}

/** One whitelisted row, or undefined when a required field is unusable. */
function normalizeRow(value: unknown): RwClientTarget | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const targetId = boundedString(row['targetId'], CLIENT_TARGET_ID_MAX)
  if (targetId === undefined) return undefined
  const kind = row['kind'] === 'ssh' || row['kind'] === 'wsl' ? row['kind'] : undefined
  if (kind === undefined) return undefined
  const phase = CLIENT_TARGET_PHASES.find(entry => entry === row['phase'])
  if (phase === undefined) return undefined
  // A row without a usable label still has to be clickable, so it falls back to
  // its id rather than vanishing from the list.
  const label = boundedString(row['label'], CLIENT_TARGET_LABEL_MAX) ?? targetId
  const host = boundedString(row['host'], CLIENT_TARGET_HOST_MAX)
  const username = boundedString(row['username'], CLIENT_TARGET_USERNAME_MAX)
  const port = row['port'] === undefined ? undefined : boundedInteger(row['port'], 0, 65_535)
  return {
    targetId,
    label,
    kind,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(username === undefined ? {} : { username }),
    phase,
    ...(row['active'] === true ? { active: true as const } : {}),
  }
}

/**
 * Whitelist and bound one published snapshot.
 *
 * @param value - raw `client/targets` params.
 * @returns the normalized snapshot (rows deduplicated by id, truncated to 64).
 * @throws PluginError `bad-request` when the envelope itself is unusable.
 */
export function normalizeClientTargets(value: unknown): RwClientTargetsValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginError('bad-request', 'client/targets requires an object body')
  }
  const input = value as Record<string, unknown>
  const clientId = boundedString(input['clientId'], CLIENT_TARGET_ID_MAX)
  if (clientId === undefined) throw new PluginError('bad-request', 'client/targets requires a non-empty clientId')
  const updatedAt = boundedInteger(input['updatedAt'], 0, Number.MAX_SAFE_INTEGER)
  if (updatedAt === undefined) throw new PluginError('bad-request', 'client/targets requires an integer updatedAt')
  if (!Array.isArray(input['targets'])) throw new PluginError('bad-request', 'client/targets requires a targets array')
  const seen = new Set<string>()
  const targets: RwClientTarget[] = []
  for (const raw of input['targets']) {
    if (targets.length >= CLIENT_TARGETS_MAX_ROWS) break
    const row = normalizeRow(raw)
    if (row === undefined || seen.has(row.targetId)) continue
    seen.add(row.targetId)
    targets.push(row)
  }
  const activeTargetId = boundedString(input['activeTargetId'], CLIENT_TARGET_ID_MAX)
  return {
    clientId,
    updatedAt,
    ...(activeTargetId === undefined ? {} : { activeTargetId }),
    targets,
  }
}

/**
 * The server profile's in-memory copy of the client's connection list.
 *
 * `updatedAt` is monotonic: a snapshot that is not strictly newer than the
 * retained one is dropped, so a delayed publish can never resurrect a stale
 * list or an old `activeTargetId`.
 */
export class ClientTargetsSnapshot {
  private current: RwClientTargetsValue | undefined

  /** The snapshot the browser should render (empty before the first publish). */
  read(): RwClientTargetsValue {
    return this.current ?? emptyClientTargets()
  }

  /** Retained stamp, for diagnostics and the dispatch reply. */
  get updatedAt(): number {
    return this.current?.updatedAt ?? 0
  }

  /** Whether any publication has been retained (diagnostics/tests). */
  get present(): boolean {
    return this.current !== undefined
  }

  /**
   * Validate, authenticate and retain one published snapshot.
   * @param value - raw `client/targets` params.
   * @param options - `leaseClientId`: the active lease owner, when known.
   * @returns whether the value won the `updatedAt` race, plus the retained state.
   * @throws PluginError `bad-request` when the envelope is unusable,
   *   `lease-mismatch` when it claims another client than the lease.
   */
  accept(value: unknown, options: { readonly leaseClientId?: string | undefined } = {}): ClientTargetsAcceptResult {
    const next = normalizeClientTargets(value)
    this.assertLeaseOwner(next, options.leaseClientId)
    if (this.current !== undefined && next.updatedAt <= this.current.updatedAt) {
      return { accepted: false, updatedAt: this.current.updatedAt, count: this.current.targets.length }
    }
    this.current = next
    return { accepted: true, updatedAt: next.updatedAt, count: next.targets.length }
  }

  /**
   * Authenticate one publication against the active lease.
   *
   * The RPC already checked the `x-dsh-rw-*` headers; this guards the body from
   * claiming a different client than the lease owner (protocol §16.14, §2.2).
   * @param value - normalized snapshot.
   * @param leaseClientId - the active lease's client id, when known.
   * @throws PluginError `lease-mismatch`.
   */
  assertLeaseOwner(value: RwClientTargetsValue, leaseClientId: string | undefined): void {
    if (leaseClientId === undefined || leaseClientId === value.clientId) return
    throw new PluginError('lease-mismatch', 'the published clientId does not match the active profile lease', {
      leaseClientId,
      publishedClientId: value.clientId,
    })
  }

  /** Drop the retained snapshot (lease release / explicit reset). */
  clear(): void {
    this.current = undefined
  }
}
