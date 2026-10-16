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

function asWorkspaceId(value: string): WorkspaceId {
  return value as WorkspaceId
}

function asHandleId(value: string): RemoteHandleId {
  return value as RemoteHandleId
}

function asSessionId(value: string): RemoteSessionId {
  return value as RemoteSessionId
}

/**
 * Server-side adapter around the official persistence and workspace services.
 * It owns no file format and no lock files: write ownership is provided by the
 * official JSONL backend's SessionHandle lease.
 */
export class RemoteSessionStore {
  private readonly handles = new Map<RemoteHandleId, SessionHandle>()
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

  async createSession(workspaceId: WorkspaceId, header: SessionHeader): Promise<{ handleId: RemoteHandleId; header: SessionHeader }> {
    const workspace = await this.workspace(workspaceId)
    const handle = await this.persistence().create({ ...header, cwd: workspace.path })
    const handleId = asHandleId(randomUUID())
    this.handles.set(handleId, handle)
    return { handleId, header: handle.header }
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
    return { handleId, header: handle.header, events: result.events }
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
