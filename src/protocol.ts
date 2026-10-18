/**
 * Client/server protocol shared with dsh-remote-workspace.
 * Keep this file byte-for-byte aligned with the client copy.
 * Protocol revision: 3 (Remote Session RPCs; official execution RPCs remain v1).
 *
 * Revision 3 adds the server-authoritative workspace registry RPCs
 * (`reg.rename`, `reg.delete`, `reg.list` activity) — see `doc/api-contract.md` §14.
 */

export type Brand<T, B extends string> = T & { readonly __brand: B }
export type WorkspaceId = Brand<string, 'RemoteWorkspaceId'>
export type RemoteSessionId = Brand<string, 'RemoteSessionId'>
export type RemoteHandleId = Brand<string, 'RemoteSessionHandleId'>

export const REMOTE_SESSION_PROTOCOL = 3 as const

export const REMOTE_METHODS = {
  hello: 'server.hello',
  listWorkspaces: 'reg.list',
  createWorkspace: 'reg.create',
  renameWorkspace: 'reg.rename',
  deleteWorkspace: 'reg.delete',
  listSessions: 'persist.list',
  listTitles: 'persist.titles',
  renameSession: 'persist.rename',
  createSession: 'persist.create',
  openSession: 'persist.open',
  appendSession: 'persist.append',
  flushSession: 'persist.flush',
  closeSession: 'persist.close',
  locateSession: 'persist.locate',
} as const

export interface ServerHelloRequest {
  protocol: typeof REMOTE_SESSION_PROTOCOL
  clientVersion: string
}

export interface ServerHelloResponse {
  protocol: typeof REMOTE_SESSION_PROTOCOL
  serverId: string
  installationId: string
  version: string
  workspacesRoot: string
  /** Real home directory of the remote server process (used by the directory browser). */
  home?: string
}

/** `reg.list` request: activity is opt-in because it reads session logs. */
export interface WorkspaceListRequest {
  /** When true the reply carries `updatedAt` (folded from session logs, memoized by size). */
  includeActivity?: boolean
}

/** Rename one workspace (id and path never change). */
export interface WorkspaceRenameRequest {
  id: WorkspaceId
  title: string
}

export interface WorkspaceRenameResponse {
  id: WorkspaceId
  title: string
}

/**
 * Remove one workspace **from the registry only**.
 *
 * `force` deletes the entry even when it still has sessions; the session logs
 * under `~/.dsh/remote-server-sessions/**` are never touched, so re-creating the
 * same path restores its `sessionCount`.
 */
export interface WorkspaceDeleteRequest {
  id: WorkspaceId
  force?: boolean
}

export interface WorkspaceDeleteResponse {
  /** False when the id was not in the registry (idempotent delete). */
  removed: boolean
  sessionCount: number
}

export interface SessionLocateRequest {
  sessionId: RemoteSessionId
}

export interface SessionLocateResponse {
  /** The owning workspace, or null when the server has no such session. */
  workspaceId: WorkspaceId | null
}

export interface RemoteWorkspaceSummary {
  id: WorkspaceId
  path: string
  title: string
  sessionCount: number
  createdAt: string
  /** Latest session-log event time in this workspace; only with `includeActivity`. */
  updatedAt?: string
}

export interface RemoteSessionSummary {
  id: RemoteSessionId
  header: unknown
  sizeBytes?: number
  createdAt?: number
  cwd: string
}

/** One stored session's display facts: the log's title and its last activity. */
export interface RemoteSessionTitle {
  id: RemoteSessionId
  /** Latest `session/title` text; empty when the log carries no title event. */
  title: string
  /** Time of the log's last event (epoch ms); absent for an empty log. */
  updatedAt?: number
}

export interface SessionTitlesRequest {
  workspaceId: WorkspaceId
}

/** Rename one stored session by appending a user `session/title` event. */
export interface SessionRenameRequest {
  workspaceId: WorkspaceId
  sessionId: RemoteSessionId
  /** Already normalized by the caller (the official title normalizer). */
  title: string
}

export interface SessionRenameResponse {
  title: string
}

export interface SessionOpenRequest {
  workspaceId: WorkspaceId
  sessionId: RemoteSessionId
  mode: 'read' | 'write'
}

export interface SessionHandleResponse {
  handleId: RemoteHandleId
  header: unknown
  events?: readonly unknown[]
  /**
   * Fork-inherited prefix length stored with the log.
   *
   * A forked session's header is `isSeeded`, and the official backend *requires*
   * the count when it stores one (`seeded session header requires an inherited
   * event count`); a resume of a seeded log needs it back for the same reason
   * the header carries it.
   */
  inheritedEventCount?: number
}
