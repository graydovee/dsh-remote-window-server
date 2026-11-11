/**
 * Pure view-model helpers for the server profile's connection list.
 *
 * Everything here is DOM-free so the wire contract, the row selection and the
 * row copy can be asserted in Node (`tests/client-connections-section.test.ts`)
 * without a browser or React. The React panel composes these functions; the
 * polling transport lives in `data.ts`.
 */
import {
  RW_EMBED_TARGET_PARAM,
  type RwClientTarget,
  type RwClientTargetPhase,
  type RwClientTargetsValue,
} from '../protocol.ts'
import type { LocaleKey } from './locales.ts'
import { t } from './locales.ts'

/** Profile-relative route serving the published snapshot (protocol §16.14). */
export const CLIENT_TARGETS_ROUTE = 'dsh-remote-workspace-server/api/client/targets'

/** Poll cadence of the list while the panel is mounted. */
export const CLIENT_TARGETS_POLL_MS = 2_000

/** Empty value served before the client publishes anything. */
export function emptySnapshot(): RwClientTargetsValue {
  return { clientId: '', updatedAt: 0, targets: [] }
}

/**
 * The URL the panel fetches.
 *
 * Relative on purpose: the embedded page is served through the client host's
 * portal, so a leading slash would escape the mount and a bare path stays on the
 * profile's own origin (`<mount>/dsh-remote-workspace-server/api/client/targets`).
 * @returns the relative request path.
 */
export function targetsRequestPath(): string {
  return CLIENT_TARGETS_ROUTE
}

/** Whether a value is a usable target id string. */
function isTargetId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Narrow one row, dropping anything this version cannot render.
 * @param value - one `targets[]` entry.
 * @returns the row, or undefined when required fields are missing.
 */
function parseTargetRow(value: unknown): RwClientTarget | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (!isTargetId(row['targetId'])) return undefined
  if (row['kind'] !== 'ssh' && row['kind'] !== 'wsl') return undefined
  const phase = row['phase']
  if (!isPhase(phase)) return undefined
  const label = typeof row['label'] === 'string' && row['label'] !== '' ? row['label'] : row['targetId']
  return {
    targetId: row['targetId'],
    label,
    kind: row['kind'],
    ...(typeof row['host'] === 'string' && row['host'] !== '' ? { host: row['host'] } : {}),
    ...(typeof row['port'] === 'number' && Number.isSafeInteger(row['port']) ? { port: row['port'] } : {}),
    ...(typeof row['username'] === 'string' && row['username'] !== '' ? { username: row['username'] } : {}),
    phase,
    ...(row['active'] === true ? { active: true as const } : {}),
  }
}

/** Whether a value is one of the phases the panel knows. */
function isPhase(value: unknown): value is RwClientTargetPhase {
  return value === 'connecting' || value === 'ready' || value === 'degraded'
    || value === 'failed' || value === 'stopped' || value === 'disconnected'
}

/**
 * Parse one `GET api/client/targets` body.
 *
 * Accepts the P1 envelope (`{ ok, value }`) and a bare value, so a proxy or a
 * test fixture cannot change the shape of what the panel can read.
 * @param payload - parsed JSON (or anything).
 * @returns the snapshot, or undefined when the payload is unusable.
 */
export function parseTargetsValue(payload: unknown): RwClientTargetsValue | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const envelope = payload as Record<string, unknown>
  const source = envelope['ok'] === true && envelope['value'] !== undefined
    ? envelope['value']
    : payload
  if (source === null || typeof source !== 'object') return undefined
  const value = source as Record<string, unknown>
  if (!Array.isArray(value['targets'])) return undefined
  const updatedAt = typeof value['updatedAt'] === 'number' && Number.isFinite(value['updatedAt'])
    ? value['updatedAt']
    : 0
  const targets: RwClientTarget[] = []
  for (const raw of value['targets']) {
    const row = parseTargetRow(raw)
    if (row !== undefined) targets.push(row)
  }
  return {
    clientId: typeof value['clientId'] === 'string' ? value['clientId'] : '',
    updatedAt,
    ...(isTargetId(value['activeTargetId']) ? { activeTargetId: value['activeTargetId'] } : {}),
    targets,
  }
}

/**
 * Read one query parameter from a search string.
 * @param search - `location.search` (leading `?` optional).
 * @param name - parameter name.
 * @returns the decoded value, or undefined when absent/empty.
 */
export function readSearchParam(search: string, name: string): string | undefined {
  const params = new URLSearchParams(search)
  const value = params.get(name)
  return value === null || value === '' ? undefined : value
}

/**
 * The row the panel highlights.
 *
 * The frame's own `dshRwTarget` wins (it names the target this document shows,
 * even when the snapshot is momentarily stale); the snapshot's `activeTargetId`
 * is the fallback the server can still offer without the query string.
 * @param snapshot - published snapshot.
 * @param search - `location.search`.
 * @returns the target id to highlight, or undefined.
 */
export function selectActiveTargetId(snapshot: RwClientTargetsValue, search: string): string | undefined {
  return readSearchParam(search, RW_EMBED_TARGET_PARAM) ?? snapshot.activeTargetId
}

/**
 * The endpoint line of one row.
 *
 * SSH shows `user@host:port` (whichever parts the client published); a WSL
 * target has no reachable host name, so it shows its distribution instead.
 * @param target - one published row.
 * @returns the localized endpoint line.
 */
export function formatEndpoint(target: RwClientTarget): string {
  if (target.kind === 'wsl') {
    return target.host === undefined
      ? t('connections.endpoint.wsl')
      : t('connections.endpoint.wslDistro', { distro: target.host })
  }
  const parts = { username: target.username, host: target.host, port: target.port }
  if (target.username !== undefined && target.host !== undefined && target.port !== undefined) {
    return t('connections.endpoint', parts)
  }
  if (target.host !== undefined) {
    return target.port === undefined ? target.host : t('connections.endpoint.hostOnly', { host: target.host, port: target.port })
  }
  return target.username ?? ''
}

/** Localized phase copy. */
export function phaseLabel(phase: RwClientTargetPhase): string {
  return t(PHASE_LABEL_KEYS[phase])
}

/** Phase → dictionary key. */
export const PHASE_LABEL_KEYS: Record<RwClientTargetPhase, LocaleKey> = {
  connecting: 'remote.phase.connecting',
  ready: 'remote.phase.ready',
  degraded: 'remote.phase.degraded',
  failed: 'remote.phase.failed',
  stopped: 'remote.phase.stopped',
  disconnected: 'remote.phase.disconnected',
}
