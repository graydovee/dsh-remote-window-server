import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type {
  RemoteHandleId,
  RemoteSessionId,
  RemoteSessionSummary,
  RemoteSessionTitle,
  RemoteWorkspaceSummary,
  WorkspaceId,
} from '../protocol.ts'

interface WorkspaceRecordLike {
  readonly path: string
  readonly title: string
  readonly createdAt?: string
}

interface WorkspaceRegistryLike {
  list(): readonly WorkspaceRecordLike[]
  create(path: string, title?: string): Promise<WorkspaceRecordLike>
}

interface SessionHeaderLike extends SessionHeader {
  readonly cwd?: string
}

interface SessionPersistenceLike extends SessionPersistence {
  create(header: SessionHeader, options?: { signal?: AbortSignal; inheritedEventCount?: number }): Promise<SessionHandle>
  open(id: SessionId, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<SessionHandle>
}

/** Parallel artifact reads per titles call; keeps a large workspace responsive. */
const TITLE_READ_CONCURRENCY = 4

function asWorkspaceId(value: string): WorkspaceId {
  return value as WorkspaceId
}

function asHandleId(value: string): RemoteHandleId {
  return value as RemoteHandleId
}

function asSessionId(value: string): RemoteSessionId {
  return value as RemoteSessionId
}

/** One log record as this module reads it: type, time, opaque data. */
interface LooseEvent {
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

/** One session's folded title facts, cached against the artifact's size. */
interface TitleCacheEntry {
  readonly sizeBytes: number | undefined
  readonly title: string
  readonly updatedAt: number | undefined
}

/**
 * Server-side adapter around the official persistence and workspace services.
 * It owns no file format and no lock files: write ownership is provided by the
 * official JSONL backend's SessionHandle lease.
 */
export class RemoteSessionStore {
  private readonly handles = new Map<RemoteHandleId, SessionHandle>()
  /** Folded titles by session id, invalidated by the artifact's reported size. */
  private readonly titleCache = new Map<string, TitleCacheEntry>()
  private readonly localWorkspaces = new Map<string, WorkspaceRecordLike>()
  private loadedLocalIndex = false

  constructor(
    private readonly ctx: Context,
    readonly serverId: string,
    readonly installationId: string,
    private readonly localIndexPath?: string,
  ) {}

  private persistence(): SessionPersistenceLike {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('remote session server requires sessionPersistence')
    return persistence as SessionPersistenceLike
  }

  private registry(): WorkspaceRegistryLike | undefined {
    return this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  }

  /** Stable workspace identity; the physical JSONL layout remains official-owned. */
  workspaceId(path: string): WorkspaceId {
    return asWorkspaceId(createHash('sha256').update(`${this.serverId}\0${path}`).digest('hex').slice(0, 16))
  }

  private async records(): Promise<readonly WorkspaceRecordLike[]> {
    const registry = this.registry()
    if (registry !== undefined) return registry.list()
    await this.loadLocalIndex()
    return [...this.localWorkspaces.values()]
  }

  private async workspace(workspaceId: WorkspaceId): Promise<WorkspaceRecordLike> {
    const records = await this.records()
    const found = records.find(record => this.workspaceId(record.path) === workspaceId)
    if (found === undefined) throw new Error(`unknown remote workspace "${workspaceId}"`)
    return found
  }

  async listWorkspaces(): Promise<readonly RemoteWorkspaceSummary[]> {
    const sessions = await this.persistence().list()
    const records = await this.records()
    return records.map(record => ({
      id: this.workspaceId(record.path),
      path: record.path,
      title: record.title,
      createdAt: record.createdAt ?? new Date(0).toISOString(),
      sessionCount: sessions.filter(snapshot => (snapshot.header as SessionHeaderLike).cwd === record.path).length,
    }))
  }

  async createWorkspace(path: string, title?: string): Promise<RemoteWorkspaceSummary> {
    const registry = this.registry()
    if (registry === undefined) await this.loadLocalIndex()
    const record = registry === undefined
      ? (() => {
          const next = { path, title: title ?? path.split('/').filter(Boolean).at(-1) ?? path, createdAt: new Date().toISOString() }
          this.localWorkspaces.set(path, next)
          void this.saveLocalIndex()
          return next
        })()
      : await registry.create(path, title)
    return {
      id: this.workspaceId(record.path),
      path: record.path,
      title: record.title,
      createdAt: record.createdAt ?? new Date().toISOString(),
      sessionCount: 0,
    }
  }

  async listSessions(workspaceId: WorkspaceId): Promise<readonly RemoteSessionSummary[]> {
    const workspace = await this.workspace(workspaceId)
    const snapshots = await this.persistence().list()
    return snapshots
      .filter(snapshot => (snapshot.header as SessionHeaderLike).cwd === workspace.path)
      .map(snapshot => ({
        id: asSessionId(String(snapshot.header.id)),
        header: snapshot.header,
        ...(snapshot.sizeBytes === undefined ? {} : { sizeBytes: snapshot.sizeBytes }),
        createdAt: snapshot.header.createdAt,
        cwd: workspace.path,
      }))
  }

  /**
   * Titles and last activity for one workspace's stored sessions.
   *
   * The title is a `session/title` event in the log (log-only, latest wins —
   * the official projection folds it the same way), and the *client* dsh is what
   * produces it: this server profile has no title plugin. Reading is therefore
   * the only way to learn it, and it is cached against the artifact's
   * `sizeBytes`, so an unchanged log is never read twice.
   *
   * Reads take a `read` handle: no write ownership is claimed, so this can run
   * while a client is writing the same session.
   */
  async titles(workspaceId: WorkspaceId): Promise<readonly RemoteSessionTitle[]> {
    const workspace = await this.workspace(workspaceId)
    const snapshots = await this.persistence().list()
    const mine = snapshots.filter(snapshot => (snapshot.header as SessionHeaderLike).cwd === workspace.path)
    const results = new Array<RemoteSessionTitle>(mine.length)
    let cursor = 0
    // Bounded fan-out: each task opens and reads one artifact.
    const worker = async (): Promise<void> => {
      for (let index = cursor++; index < mine.length; index = cursor++) {
        const snapshot = mine[index]
        if (snapshot === undefined) continue
        results[index] = await this.titleOf(
          asSessionId(String(snapshot.header.id)),
          snapshot.sizeBytes,
        ).catch(() => ({ id: asSessionId(String(snapshot.header.id)), title: '' }))
      }
    }
    await Promise.all(Array.from({ length: Math.min(TITLE_READ_CONCURRENCY, mine.length) }, worker))
    return results
  }

  /**
   * Rename one stored session **without opening it anywhere**.
   *
   * The official rename is a single `session/title` append with `source:
   * {kind:'user'}` (log-only, latest wins); it needs a *live* session only
   * because the shell's title service is session-scoped. On the remote plane the
   * log is ours to append to, so this takes a write handle, reads the current
   * length for the next contiguous `seq`, appends the one event, flushes it
   * durable, and releases the handle — no session is opened, no agent is
   * created, and nothing is revealed. The caller normalizes the text with the
   * official normalizer before it gets here.
   *
   * A write handle is a lease: if another device is writing this session the
   * open fails and the rename is refused rather than racing that writer.
   */
  async rename(workspaceId: WorkspaceId, sessionId: RemoteSessionId, title: string): Promise<{ title: string }> {
    // Resolve the workspace first: a session of another workspace must not be
    // reachable through this call.
    const workspace = await this.workspace(workspaceId)
    const handle = await this.persistence().open(sessionId as unknown as SessionId, 'write')
    try {
      if ((handle.header as SessionHeaderLike).cwd !== workspace.path) {
        throw new Error(`session "${sessionId}" does not belong to workspace "${workspaceId}"`)
      }
      const { events } = await handle.read()
      const next = events.length
      await handle.append([{
        type: 'session/title',
        seq: next,
        time: Date.now(),
        data: { title, messageSeqs: [], source: { kind: 'user' } },
      } as never])
      await handle.flush()
      // The folded title is cached against the artifact size, which this append
      // just changed; drop it so the next read re-folds instead of racing.
      this.titleCache.delete(String(sessionId))
      return { title }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /** Fold one session's title from its log, reusing the cached entry when unchanged. */
  private async titleOf(id: RemoteSessionId, sizeBytes: number | undefined): Promise<RemoteSessionTitle> {
    const cached = this.titleCache.get(String(id))
    if (cached !== undefined && sizeBytes !== undefined && cached.sizeBytes === sizeBytes) {
      return {
        id,
        title: cached.title,
        ...(cached.updatedAt === undefined ? {} : { updatedAt: cached.updatedAt }),
      }
    }
    const handle = await this.persistence().open(id as unknown as SessionId, 'read')
    try {
      const { events } = await handle.read()
      // `session/title` is a projection event contributed by the title plugin,
      // which this server profile does not mount — so its type is not in the
      // official union here, while the *client* dsh still writes it into this
      // log. Read the log loosely rather than widening the official type.
      const log = events as unknown as readonly LooseEvent[]
      const titleEvent = log.findLast(event => event.type === 'session/title')
      const data = titleEvent?.data as { title?: unknown } | undefined
      const title = typeof data?.title === 'string' ? data.title : ''
      const last = log[log.length - 1]
      const updatedAt = last === undefined ? undefined : last.time
      this.titleCache.set(String(id), { sizeBytes, title, updatedAt })
      return { id, title, ...(updatedAt === undefined ? {} : { updatedAt }) }
    } catch (error) {
      // A session whose log cannot be read still has to be listed: the list is
      // the panel's, and one unreadable artifact must not hide the rest.
      if (error instanceof Error && /not.?found/i.test(error.message)) return { id, title: '' }
      throw error
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /**
   * Which workspace owns one stored session, or undefined when the server has
   * no such session. The routing persistence on the client needs this to open
   * a session by id without knowing its workspace up front.
   */
  async locateSession(sessionId: RemoteSessionId): Promise<WorkspaceId | undefined> {
    const snapshots = await this.persistence().list()
    const found = snapshots.find(snapshot => String(snapshot.header.id) === String(sessionId))
    if (found === undefined) return undefined
    const cwd = (found.header as SessionHeaderLike).cwd
    if (cwd === undefined) return undefined
    const records = await this.records()
    const record = records.find(candidate => candidate.path === cwd)
    return record === undefined ? undefined : this.workspaceId(record.path)
  }

  async createSession(
    workspaceId: WorkspaceId,
    header: SessionHeader,
    inheritedEventCount?: number,
  ): Promise<{ handleId: RemoteHandleId; header: SessionHeader; inheritedEventCount?: number }> {
    const workspace = await this.workspace(workspaceId)
    // A seeded header (a fork) cannot be stored without the inherited prefix
    // length; the official backend refuses it. Pass it through when given.
    const handle = await this.persistence().create(
      { ...header, cwd: workspace.path },
      inheritedEventCount === undefined ? undefined : { inheritedEventCount: inheritedEventCount as never },
    )
    const handleId = asHandleId(randomUUID())
    this.handles.set(handleId, handle)
    return {
      handleId,
      header: handle.header,
      inheritedEventCount: Number(handle.inheritedEventCount),
    }
  }

  async openSession(workspaceId: WorkspaceId, sessionId: RemoteSessionId, mode: 'read' | 'write') {
    const workspace = await this.workspace(workspaceId)
    const handle = await this.persistence().open(sessionId as unknown as SessionId, mode)
    if ((handle.header as SessionHeaderLike).cwd !== workspace.path) {
      await handle.close()
      throw new Error(`session "${sessionId}" does not belong to workspace "${workspaceId}"`)
    }
    const handleId = asHandleId(randomUUID())
    this.handles.set(handleId, handle)
    const result = await handle.read()
    return {
      handleId,
      header: handle.header,
      events: result.events,
      inheritedEventCount: Number(handle.inheritedEventCount),
    }
  }

  async append(handleId: RemoteHandleId, events: readonly SessionEvent[]): Promise<void> {
    const handle = this.requireHandle(handleId)
    await handle.append(events)
  }

  async flush(handleId: RemoteHandleId): Promise<void> {
    await this.requireHandle(handleId).flush()
  }

  async close(handleId: RemoteHandleId): Promise<void> {
    const handle = this.handles.get(handleId)
    if (handle === undefined) return
    this.handles.delete(handleId)
    await handle.close()
  }

  async dispose(): Promise<void> {
    const handles = [...this.handles.entries()]
    this.handles.clear()
    await Promise.allSettled(handles.map(([, handle]) => handle.close()))
  }

  private requireHandle(handleId: RemoteHandleId): SessionHandle {
    const handle = this.handles.get(handleId)
    if (handle === undefined) throw new Error(`unknown remote session handle "${handleId}"`)
    return handle
  }

  private async loadLocalIndex(): Promise<void> {
    if (this.loadedLocalIndex || this.localIndexPath === undefined) return
    this.loadedLocalIndex = true
    try {
      const raw = JSON.parse(await readFile(this.localIndexPath, 'utf8')) as unknown
      if (!Array.isArray(raw)) return
      for (const value of raw) {
        if (value !== null && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string') {
          const record = value as WorkspaceRecordLike
          this.localWorkspaces.set(record.path, record)
        }
      }
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
    }
  }

  private async saveLocalIndex(): Promise<void> {
    if (this.localIndexPath === undefined) return
    await mkdir(dirname(this.localIndexPath), { recursive: true })
    await writeFile(this.localIndexPath, JSON.stringify([...this.localWorkspaces.values()]) + '\n', { mode: 0o600 })
  }
}
