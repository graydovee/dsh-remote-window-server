/**
 * P1 persist bridge over the official session persistence (protocol §16.7).
 *
 * The plugin owns only in-memory handle ids; log format, contiguity, flock and
 * durability stay with the official JSONL backend. Write opens additionally
 * check the executor record so a local-mode writer cannot race a server agent.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { PluginError } from './errors.ts'
import type { ExecutorOwner, ExecutorStore } from './executor.ts'
import type { RwExecutorRecord } from '../protocol.ts'
import { foldFacts } from './title-fold.ts'
import { SessionLogCache } from './session-log-cache.ts'

interface HandleLike {
  readonly id: string
  readonly header: Record<string, unknown>
  readonly inheritedEventCount: unknown
  readonly access: 'read' | 'write'
  read(offset?: number, length?: number): Promise<{ events: readonly unknown[]; eventState: unknown }>
  append(events: readonly unknown[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

interface PersistenceLike {
  create(header: Record<string, unknown>, options?: { inheritedEventCount?: number }): Promise<HandleLike>
  open(id: string, access: 'read' | 'write'): Promise<HandleLike>
  list(options?: unknown): Promise<readonly { readonly header: Record<string, unknown>; readonly eventCount?: number; readonly sizeBytes?: number }[]>
  stat(id: string): Promise<{ readonly header: Record<string, unknown>; readonly eventCount?: number; readonly sizeBytes?: number } | undefined>
  flush(): Promise<void>
}

interface RegistryLike {
  list(): readonly { readonly id: string; readonly path: string }[]
}

interface AgentsLike {
  get(id: string): unknown
}

interface OwnerProvider {
  (): ExecutorOwner | undefined
}

interface SessionHandleRecord {
  readonly handle: HandleLike
  readonly sessionId: string
  readonly access: 'read' | 'write'
}

const OWNER_TTL_MS = 20_000

export { EVENT_COUNT_DECODE_MAX_BYTES, EVENT_COUNT_DECODE_WARN_BYTES } from './session-log-cache.ts'

/** One executor error for the write-open guard table (protocol §16.5). */
function modeConflict(mode: 'server' | 'local', extra: Record<string, unknown> = {}): never {
  throw new PluginError('executor-mode-conflict', `session executor is "${mode}"; switch the executor before opening it for write`, { mode, ...extra })
}

/** Map one official persistence failure onto the stable P1 vocabulary. */
export function mapPersistenceError(error: unknown): never {
  const name = (error as { name?: string } | undefined)?.name
  if (name === 'SessionAlreadyExistsError') throw new PluginError('persist-create-exists', 'a session with this id already exists', { sessionId: (error as { sessionId?: unknown }).sessionId })
  if (name === 'SessionAlreadyOwnedError') throw new PluginError('session/writer-held', (error as Error).message, { sessionId: (error as { sessionId?: unknown }).sessionId })
  if (name === 'SessionPersistenceNotFoundError') throw new PluginError('session-not-found', (error as Error).message)
  if (name === 'SessionHandleClosedError') throw new PluginError('handle-not-found', 'the session handle is closed')
  if (name === 'SessionReadOnlyError') throw new PluginError('persist-read-only', 'this handle is read-only')
  // The official seam rejects a non-contiguous batch with a plain Error whose
  // message carries "append seq mismatch"; it is a caller bug, not a retryable
  // transport failure, so it maps onto bad-request (no new protocol code).
  if (error instanceof Error && /append seq mismatch/i.test(error.message)) {
    throw new PluginError('bad-request', error.message, { reason: 'seq-mismatch' })
  }
  throw error
}

/** In-memory handle table plus the P1 persist methods. */
export class PersistBridge {
  private readonly handles = new Map<string, SessionHandleRecord>()

  constructor(
    private readonly ctx: Context,
    private readonly executor: ExecutorStore,
    private readonly ownerOf: OwnerProvider,
    private readonly cache: SessionLogCache = new SessionLogCache(),
  ) {}

  private persistence(): PersistenceLike {
    const persistence = this.ctx.get('sessionPersistence') as PersistenceLike | undefined
    if (persistence === undefined) throw new PluginError('internal', 'the profile has no sessionPersistence service')
    return persistence
  }

  private workspacePath(path: string): boolean {
    const registry = this.ctx.get('workspaceRegistry') as RegistryLike | undefined
    return registry?.list().some(workspace => workspace.path === path) === true
  }

  private require(handleId: string): SessionHandleRecord {
    const record = this.handles.get(handleId)
    if (record === undefined) throw new PluginError('handle-not-found', `unknown persist handle "${handleId}"`)
    return record
  }

  /** `persist/create`: validate remoteCwd, create through the official backend, record executor local. */
  async create(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const header = params['header']
    const remoteCwd = params['remoteCwd']
    if (typeof remoteCwd !== 'string' || !remoteCwd.startsWith('/')) throw new PluginError('bad-request', 'persist/create requires an absolute remoteCwd')
    if (!this.workspacePath(remoteCwd)) throw new PluginError('workspace-path-invalid', `remoteCwd is not an official workspace path: ${remoteCwd}`, { remoteCwd })
    if (header === null || typeof header !== 'object' || Array.isArray(header)) throw new PluginError('bad-request', 'persist/create requires a header object')
    const inherited = params['inheritedEventCount']
    const inheritedEventCount = typeof inherited === 'number' && Number.isSafeInteger(inherited) && inherited >= 0 ? inherited : undefined
    const executorValue = params['executor']
    const sessionId = typeof (header as Record<string, unknown>)['id'] === 'string' ? String((header as Record<string, unknown>)['id']) : ''
    try {
      const handle = await this.persistence().create(
        { ...header as Record<string, unknown>, cwd: remoteCwd },
        inheritedEventCount === undefined ? undefined : { inheritedEventCount },
      )
      const workspace = (this.ctx.get('workspaceRegistry') as { list(): readonly { readonly path: string; attachSession(id: string): Promise<void> }[] } | undefined)
        ?.list().find(candidate => candidate.path === remoteCwd)
      try { await workspace?.attachSession(sessionId) } catch (error) {
        await handle.close().catch(() => {})
        throw new PluginError('internal', `session "${sessionId}" was created but could not attach to workspace: ${error instanceof Error ? error.message : String(error)}`)
      }
      const handleId = randomUUID()
      this.handles.set(handleId, { handle, sessionId, access: 'write' })
      if (executorValue === 'local') await this.executor.assign(sessionId, 'local', this.ownerOf(), 'handoff')
      return {
        handleId,
        header: { ...handle.header, cwd: remoteCwd },
        nextSeq: inheritedEventCount ?? 0,
      }
    } catch (error) { mapPersistenceError(error) }
  }

  /**
   * Exact event count for a handle.
   *
   * The shipped JSONL `stat`/`list` snapshots carry `sizeBytes` but no cheap
   * `eventCount`, so the count comes from one official `read(0)` decode. The
   * backend memoizes that decode per artifact revision; body reads stay paged.
   */
  private async eventCountOf(
    sessionId: string,
    handle: HandleLike,
    snapshotEventCount: number | undefined,
    sizeBytes: number | undefined,
  ): Promise<number> {
    if (typeof snapshotEventCount === 'number' && Number.isSafeInteger(snapshotEventCount)) return snapshotEventCount
    if (sizeBytes !== undefined) {
      const cached = this.cache.get(sessionId, sizeBytes)
      if (cached?.eventCount !== undefined) return cached.eventCount
      this.cache.allowDecode(sessionId, sizeBytes)
    }
    const { events } = await handle.read(0)
    if (sizeBytes !== undefined) this.cache.rememberCount(sessionId, sizeBytes, events.length, foldFacts(events))
    return events.length
  }

  /** `persist/open`: read opens freely; write opens pass the executor guard first. */
  async open(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
    const access = params['access'] === 'write' ? 'write' : params['access'] === 'read' ? 'read' : undefined
    if (sessionId === '' || access === undefined) throw new PluginError('bad-request', 'persist/open requires sessionId and access')
    if (access === 'write') await this.guardWriteOpen(sessionId)
    try {
      const handle = await this.persistence().open(sessionId, access)
      const stored = await this.persistence().stat(sessionId).catch(() => undefined)
      const eventCount = await this.eventCountOf(sessionId, handle, stored?.eventCount, stored?.sizeBytes)
      const handleId = randomUUID()
      this.handles.set(handleId, { handle, sessionId, access })
      return {
        handleId,
        header: handle.header,
        inheritedEventCount: Number(handle.inheritedEventCount),
        eventCount,
      }
    } catch (error) { mapPersistenceError(error) }
  }

  /** `persist/read` with offset/length paging and nextOffset. */
  async read(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const record = this.require(typeof params['handleId'] === 'string' ? params['handleId'] : '')
    const offset = typeof params['offset'] === 'number' && Number.isSafeInteger(params['offset']) && params['offset'] >= 0 ? params['offset'] : 0
    const length = typeof params['length'] === 'number' && Number.isSafeInteger(params['length']) && params['length'] >= 0 ? params['length'] : undefined
    try {
      const result = await record.handle.read(offset, length)
      return { events: result.events, eventState: result.eventState, nextOffset: offset + result.events.length }
    } catch (error) {
      mapPersistenceError(error)
      const name = (error as { name?: string } | undefined)?.name
      if (name === 'SessionHandleClosedError') throw new PluginError('handle-not-found', 'the session handle is closed')
      throw error
    }
  }

  async append(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const record = this.require(typeof params['handleId'] === 'string' ? params['handleId'] : '')
    if (record.access !== 'write') throw new PluginError('persist-read-only', 'this handle is read-only')
    const events = Array.isArray(params['events']) ? params['events'] : undefined
    if (events === undefined) throw new PluginError('bad-request', 'persist/append requires events')
    try { await record.handle.append(events) } catch (error) { mapPersistenceError(error) }
    return {}
  }

  async flush(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (params['handleId'] === undefined) {
      try { await this.persistence().flush() } catch (error) { mapPersistenceError(error) }
      return {}
    }
    const record = this.require(String(params['handleId']))
    try { await record.handle.flush() } catch (error) { mapPersistenceError(error) }
    return {}
  }

  async close(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const handleId = typeof params['handleId'] === 'string' ? params['handleId'] : ''
    const record = this.require(handleId)
    this.handles.delete(handleId)
    try { await record.handle.close() } catch (error) { mapPersistenceError(error) }
    return {}
  }

  /** Close every handle held by this process (plugin unload). */
  async dispose(): Promise<void> {
    const records = [...this.handles.values()]
    this.handles.clear()
    await Promise.allSettled(records.map(record => record.handle.close()))
  }

  /** Executor write-open guard table (protocol §16.5). */
  private async guardWriteOpen(sessionId: string): Promise<void> {
    const record: RwExecutorRecord | null = await this.executor.get(sessionId)
    const owner = this.ownerOf()
    if (record === null) {
      const live = (this.ctx.get('agents') as AgentsLike | undefined)?.get(sessionId)
      if (live !== undefined) modeConflict('server', { liveAgent: true })
      await this.executor.assign(sessionId, 'local', owner, 'handoff')
      return
    }
    if (record.mode === 'server') modeConflict('server')
    const claim = record.owner
    if (claim === undefined) throw new PluginError('executor-held', 'the local executor has no owner; run executor/assign to take it over', { sessionId })
    const sameInstance = owner !== undefined && claim.clientId === owner.clientId && claim.instanceId === owner.instanceId
    if (sameInstance) return
    const age = Date.now() - Date.parse(claim.heartbeatAt)
    if (!Number.isFinite(age) || age > OWNER_TTL_MS) {
      throw new PluginError('executor-held', 'the previous local executor lease expired; run executor/assign to take it over', { ownerClientId: claim.clientId, heartbeatAt: claim.heartbeatAt })
    }
    throw new PluginError('executor-held', 'this session is being written by another local executor', { ownerClientId: claim.clientId, heartbeatAt: claim.heartbeatAt })
  }
}
