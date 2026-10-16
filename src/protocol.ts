/**
 * Client/server protocol shared with dsh-remote-workspace.
 * Keep this file byte-for-byte aligned with the client copy.
 * Protocol revision: 2 (Remote Session RPCs; official execution RPCs remain v1).
 */

export type Brand<T, B extends string> = T & { readonly __brand: B }
export type WorkspaceId = Brand<string, 'RemoteWorkspaceId'>
export type RemoteSessionId = Brand<string, 'RemoteSessionId'>
export type RemoteHandleId = Brand<string, 'RemoteSessionHandleId'>

export const REMOTE_SESSION_PROTOCOL = 2 as const

export const REMOTE_METHODS = {
  hello: 'server.hello',
  listWorkspaces: 'reg.list',
  createWorkspace: 'reg.create',
  listSessions: 'persist.list',
  createSession: 'persist.create',
  openSession: 'persist.open',
  appendSession: 'persist.append',
  flushSession: 'persist.flush',
  closeSession: 'persist.close',
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
}

export interface RemoteWorkspaceSummary {
  id: WorkspaceId
  path: string
  title: string
  sessionCount: number
  createdAt: string
}

export interface RemoteSessionSummary {
  id: RemoteSessionId
  header: unknown
  sizeBytes?: number
  createdAt?: number
  cwd: string
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
}
