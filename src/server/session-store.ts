import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
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
  /** The registry's own identity, when the record carries one (used for best-effort deletes). */
  readonly id?: string
  readonly path: string
  readonly title: string
  readonly createdAt?: string
}

interface WorkspaceRegistryLike {
  list(): readonly WorkspaceRecordLike[]
  create(path: string, title?: string): Promise<WorkspaceRecordLike>
  /**
   * Delete one registration while retaining its directory and every session —
   * the official semantics this module relies on for `reg.delete` (A35).
   */
  delete?(id: string): Promise<unknown> | unknown
}

/**
 * The server's workspace index, persisted next to the profile
 * (`~/.dsh/remote-server/workspaces.json`).
 *
 * Three sections, because the official registry cannot carry all of them:
 *
 * - `local`   — workspaces for a profile that has **no** `workspaceRegistry`
 *               (the old array-of-records file, kept for compatibility).
 * - `overlay` — server-authoritative **title overrides** written by `reg.rename`
 *               (the official registry has no rename we can rely on, and a rebuilt
 *               registry must not lose the title — architecture A34).
 * - `deleted` — tombstones written by `reg.delete`. A registry that keeps
 *               re-materializing a path (e.g. a client that re-registers) must not
 *               resurrect a workspace the user deleted on another device;
 *               `reg.create` clears the tombstone for its path (contract §14.5).
 */
interface WorkspaceIndexDocument {
  readonly version: 1
  readonly local: readonly WorkspaceRecordLike[]
  readonly overlay: Record<string, { readonly title: string; readonly updatedAt: string }>
  readonly deleted: Record<string, { readonly deletedAt: string }>
}

/** Legal workspace ids: 16 lowercase hex, as `workspaceId()` produces. */
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{16}$/

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
  /** `reg.rename` title overrides, keyed by workspace id. */
  private readonly overlay = new Map<string, { title: string; updatedAt: string }>()
  /** `reg.delete` tombstones, keyed by workspace id. */
  private readonly deleted = new Map<string, { deletedAt: string }>()
  /**
   * Identity of the index file as last read or written.
   *
   * Two clients mean **two server processes** over one `workspaces.json`, so the
   * in-memory copy is only a cache: `stat` before every read tells us whether
   * another process wrote it (alpha60: a delete/rename on one connection never
   * reached the other until it restarted).
   */
  private indexStamp: { mtimeMs: number; size: number } | undefined
  /** Serializes this process's own index writes (read-modify-write must not interleave). */
  private indexWriteQueue: Promise<unknown> = Promise.resolve()

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

  /**
   * Validate a workspace id from the wire, with the contract's message prefix.
   * @param raw - the id as received.
   * @returns the branded id.
   */
  private assertWorkspaceId(raw: string): WorkspaceId {
    if (!WORKSPACE_ID_PATTERN.test(raw)) throw new Error(`invalid-workspace-id "${raw}"`)
    return asWorkspaceId(raw)
  }

  /**
   * Every workspace the server knows, after overrides and tombstones.
   *
   * Tombstoned entries are dropped here rather than at the call sites, so
   * `reg.list`, session routing and `reg.rename` all agree on what exists.
   */
  private async records(): Promise<readonly WorkspaceRecordLike[]> {
    await this.refreshIndex()
    const registry = this.registry()
    const base = registry !== undefined ? registry.list() : [...this.localWorkspaces.values()]
    const out: WorkspaceRecordLike[] = []
    for (const record of base) {
      const id = String(this.workspaceId(record.path))
      if (this.deleted.has(id)) continue
      const override = this.overlay.get(id)
      out.push(override === undefined ? record : { ...record, title: override.title })
    }
    return out
  }

  private async workspace(workspaceId: WorkspaceId): Promise<WorkspaceRecordLike> {
    const records = await this.records()
    const found = records.find(record => this.workspaceId(record.path) === workspaceId)
    if (found === undefined) throw new Error(`unknown remote workspace "${workspaceId}"`)
    return found
  }

  /**
   * The registry view of every workspace (`reg.list`).
   * @param includeActivity - also fold each workspace's latest session activity
   *   (`updatedAt`); reads session logs, so it is opt-in (contract §14.1).
   */
  async listWorkspaces(includeActivity = false): Promise<readonly RemoteWorkspaceSummary[]> {
    const sessions = await this.persistence().list()
    const records = await this.records()
    const summaries: RemoteWorkspaceSummary[] = []
    for (const record of records) {
      const id = this.workspaceId(record.path)
      const sessionCount = sessions.filter(snapshot => (snapshot.header as SessionHeaderLike).cwd === record.path).length
      let updatedAt: string | undefined
      if (includeActivity && sessionCount > 0) {
        // `titles()` folds one log per session (memoized by artifact size), which
        // is where the last-event time comes from; reuse it instead of a second
        // log format.
        const titles = await this.titles(id).catch(() => [])
        const times = titles.map(entry => entry.updatedAt).filter((time): time is number => typeof time === 'number')
        if (times.length > 0) updatedAt = new Date(Math.max(...times)).toISOString()
      }
      summaries.push({
        id,
        path: record.path,
        title: record.title,
        createdAt: record.createdAt ?? new Date(0).toISOString(),
        sessionCount,
        ...(updatedAt === undefined ? {} : { updatedAt }),
      })
    }
    return summaries
  }

  async createWorkspace(path: string, title?: string): Promise<RemoteWorkspaceSummary> {
    // Read-modify-write under the process's write queue, and against the newest
    // disk state: another server process may have registered or deleted something
    // since our last read (alpha60).
    return await this.runIndexWrite(async () => {
      const registry = this.registry()
      const record = registry === undefined
        ? (() => {
            const next = { path, title: title ?? path.split('/').filter(Boolean).at(-1) ?? path, createdAt: new Date().toISOString() }
            this.localWorkspaces.set(path, next)
            return next
          })()
        : await registry.create(path, title)
      const id = this.workspaceId(record.path)
      // Contract §14.5: registering a path again clears its deletion tombstone (and
      // its `sessionCount` comes back, because sessions are owned by `header.cwd`).
      const cleared = this.deleted.delete(String(id))
      if (registry === undefined || cleared) await this.saveIndex()
      return {
        id,
        path: record.path,
        title: record.title,
        createdAt: record.createdAt ?? new Date().toISOString(),
        sessionCount: 0,
      }
    })
  }

  /**
   * Rename one workspace: id and path never change, only the server-side title.
   *
   * Stored in this server's own index rather than the official registry, because
   * the registry's rename API is not part of the surface this module can rely on
   * and a rebuilt registry must not lose the title (architecture A34).
   * @param workspaceId - the 16-hex workspace id.
   * @param title - already-normalized non-empty title.
   */
  async renameWorkspace(workspaceId: WorkspaceId, title: string): Promise<{ id: WorkspaceId; title: string }> {
    const id = this.assertWorkspaceId(String(workspaceId))
    const normalized = title.trim()
    if (normalized === '') throw new Error('invalid-title')
    return await this.runIndexWrite(async () => {
      await this.workspace(id)
      this.overlay.set(String(id), { title: normalized, updatedAt: new Date().toISOString() })
      await this.saveIndex()
      return { id, title: normalized }
    })
  }

  /**
   * Remove one workspace **from the registry only** (architecture A35).
   *
   * Session logs under `~/.dsh/remote-server-sessions/**` are never touched — that
   * is what makes re-registering the same path restore its sessions. A tombstone
   * is persisted so another client cannot resurrect the entry by re-registering
   * the path before this server restarts; `reg.create` clears it deliberately.
   * @param workspaceId - the 16-hex workspace id.
   * @param force - delete even when the workspace still has sessions.
   */
  async removeWorkspace(workspaceId: WorkspaceId, force = false): Promise<{ removed: boolean; sessionCount: number }> {
    const id = this.assertWorkspaceId(String(workspaceId))
    return await this.runIndexWrite(async () => await this.removeWorkspaceLocked(id, force))
  }

  /** The body of {@link removeWorkspace}, already inside the write queue. */
  private async removeWorkspaceLocked(id: WorkspaceId, force: boolean): Promise<{ removed: boolean; sessionCount: number }> {
    const records = await this.records()
    const record = records.find(candidate => this.workspaceId(candidate.path) === id)
    // Idempotent: deleting an unknown (or already deleted) id is a success.
    if (record === undefined) return { removed: false, sessionCount: 0 }
    const sessionCount = (await this.persistence().list())
      .filter(snapshot => (snapshot.header as SessionHeaderLike).cwd === record.path)
      .length
    if (!force && sessionCount > 0) throw new Error(`workspace-not-empty ${sessionCount}`)
    // Best effort: drop the official registration when the registry exposes one.
    // The official `delete` keeps the directory and every session, and the
    // tombstone below is what actually decides membership for this server.
    if (record.id !== undefined) await Promise.resolve(this.registry()?.delete?.(record.id)).catch(() => {})
    this.overlay.delete(String(id))
    this.deleted.set(String(id), { deletedAt: new Date().toISOString() })
    await this.saveIndex()
    return { removed: true, sessionCount }
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

  /**
   * Re-read the workspace index **when the file changed on disk**.
   *
   * Two clients connected to the same server are two *processes*, both reading the
   * same `workspaces.json`. The in-memory copy is therefore a cache, not the
   * truth: alpha60 showed a workspace deleted on one connection still listed on
   * the other until that one restarted. A `stat` before every read keeps the hot
   * path cheap while making cross-process changes visible on the next call.
   *
   * A legacy file is a bare array of local records (the pre-v3 layout): it is
   * accepted and upgraded in memory, and the next save writes the versioned
   * document.
   */
  private async refreshIndex(): Promise<void> {
    if (this.localIndexPath === undefined) return
    const info = await stat(this.localIndexPath).catch(() => undefined)
    if (info === undefined) {
      // No file (first run, or another process removed it): forget the cache so a
      // stale copy can never outlive the file it came from.
      this.localWorkspaces.clear()
      this.overlay.clear()
      this.deleted.clear()
      this.indexStamp = undefined
      return
    }
    const stamp = { mtimeMs: info.mtimeMs, size: info.size }
    if (this.indexStamp !== undefined && this.indexStamp.mtimeMs === stamp.mtimeMs && this.indexStamp.size === stamp.size) return
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.localIndexPath, 'utf8'))
    } catch (error: unknown) {
      // A half-written file (another process died mid-write) must not poison the
      // cache: keep the last good state and retry on the next access.
      if ((error as { code?: string }).code === 'ENOENT') return
      console.error(`[dsh-remote-workspace] workspace index is unreadable, keeping the previous state: ${String((error as Error).message ?? error)}`)
      return
    }
    this.localWorkspaces.clear()
    this.overlay.clear()
    this.deleted.clear()
    const asRecord = (value: unknown): value is WorkspaceRecordLike =>
      value !== null && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string'
    if (Array.isArray(raw)) {
      for (const value of raw) if (asRecord(value)) this.localWorkspaces.set(value.path, value)
      this.indexStamp = stamp
      return
    }
    if (raw !== null && typeof raw === 'object') {
      const document = raw as Partial<WorkspaceIndexDocument>
      for (const value of document.local ?? []) if (asRecord(value)) this.localWorkspaces.set(value.path, value)
      for (const [id, entry] of Object.entries(document.overlay ?? {})) {
        if (typeof entry?.title === 'string' && entry.title !== '') {
          this.overlay.set(id, { title: entry.title, updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : new Date().toISOString() })
        }
      }
      for (const [id, entry] of Object.entries(document.deleted ?? {})) {
        this.deleted.set(id, { deletedAt: typeof entry?.deletedAt === 'string' ? entry.deletedAt : new Date().toISOString() })
      }
    }
    this.indexStamp = stamp
  }

  /**
   * Run one index mutation exclusively: after the previous one settled, and after
   * re-reading the newest disk state.
   *
   * Two requests inside one process could otherwise interleave their
   * read-modify-write and lose an entry; the queue is the in-process half of the
   * locking story (the cross-process half is the stamp check plus the atomic
   * rename in {@link saveIndex}).
   * @param mutate - the mutation to run against fresh state.
   */
  private async runIndexWrite<T>(mutate: () => Promise<T>): Promise<T> {
    const run = this.indexWriteQueue.then(async () => {
      await this.refreshIndex()
      return await mutate()
    }, async () => {
      await this.refreshIndex()
      return await mutate()
    })
    // The queue tail never rejects: one failed write must not poison the next.
    this.indexWriteQueue = run.then(() => undefined, () => undefined)
    return await run
  }

  /**
   * Persist the workspace index **atomically**.
   *
   * Written to `<file>.tmp-<pid>-<rand>` and renamed over the target, so a
   * concurrent reader in another process sees either the old file or the new one,
   * never a half-written JSON document.
   */
  private async saveIndex(): Promise<void> {
    if (this.localIndexPath === undefined) return
    const document: WorkspaceIndexDocument = {
      version: 1,
      local: [...this.localWorkspaces.values()],
      overlay: Object.fromEntries(this.overlay),
      deleted: Object.fromEntries(this.deleted),
    }
    await mkdir(dirname(this.localIndexPath), { recursive: true })
    const temporary = `${this.localIndexPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 })
    await rename(temporary, this.localIndexPath)
    // Record what we just wrote, so our own next read does not re-parse it.
    this.indexStamp = await stat(this.localIndexPath)
      .then(info => ({ mtimeMs: info.mtimeMs, size: info.size }))
      .catch(() => undefined)
  }
}
