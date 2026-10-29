/**
 * v1 profile-plugin protocol shared by dsh-remote-window and
 * dsh-remote-window-server.
 *
 * Wire contract: doc/refactor-v1-protocol.md (frozen §16). Keep this file
 * byte-for-byte identical in both repositories.
 */

/** v1 client host ↔ profile server plugin protocol revision. */
export const REMOTE_WORKSPACE_PLUGIN_PROTOCOL = 1 as const

/** Plugin version this client build expects; the server package must match exactly. */
export const REMOTE_WORKSPACE_PLUGIN_VERSION = '0.1.0-alpha.3'

/** Base path of the P1 plugin API on the profile server. */
export const RW_ROUTE_PREFIX = '/dsh-remote-window-server' as const

/** Exact P1 routes (protocol §4.1 / §6 / §7 / §9). */
export const RW_PATHS = {
  handshake: `${RW_ROUTE_PREFIX}/api/handshake`,
  rpc: `${RW_ROUTE_PREFIX}/api/rpc`,
  events: `${RW_ROUTE_PREFIX}/api/events`,
  mux: `${RW_ROUTE_PREFIX}/api/mux`,
  bootstrap: `${RW_ROUTE_PREFIX}/embed/bootstrap.js`,
  embedCss: `${RW_ROUTE_PREFIX}/embed/embed.css`,
  sessionEvents: `${RW_ROUTE_PREFIX}/api/session/events`,
} as const

/** P1 request headers identifying the lease owner. */
export const RW_HEADERS = {
  client: 'x-dsh-rw-client',
  instance: 'x-dsh-rw-instance',
  protocol: 'x-dsh-rw-protocol',
} as const

/** P1 RPC method names (protocol §4.2 + §16). Frozen by protocol §16. */
export const RW_METHODS = {
  heartbeat: 'profile/heartbeat',
  release: 'profile/release',
  status: 'profile/status',
  cancelAll: 'profile/cancel-all',
  workspaceList: 'workspace/list',
  workspaceCreate: 'workspace/create',
  workspaceRename: 'workspace/rename',
  workspaceDelete: 'workspace/delete',
  workspaceReorder: 'workspace/reorder',
  sessionList: 'session/list',
  sessionCreate: 'session/create',
  sessionPrepareServer: 'session/prepare-server',
  sessionRename: 'session/rename',
  sessionFork: 'session/fork',
  sessionPin: 'session/pin',
  sessionArchive: 'session/archive',
  sessionCancel: 'session/cancel',
  sessionReorder: 'session/reorder',
  persistList: 'persist/list',
  persistStat: 'persist/stat',
  persistCreate: 'persist/create',
  persistOpen: 'persist/open',
  persistRead: 'persist/read',
  persistAppend: 'persist/append',
  persistFlush: 'persist/flush',
  persistClose: 'persist/close',
  persistLocate: 'persist/locate',
  executorGet: 'executor/get',
  executorAssign: 'executor/assign',
  executorPlanSwitch: 'executor/plan-switch',
  executorSwitch: 'executor/switch',
  executorRelease: 'executor/release',
  registryStatus: 'registry/status',
  registryRefresh: 'registry/refresh',
  fsList: 'fs/list',
  sessionTimeline: 'session/timeline',
  sessionPrompt: 'session/prompt',
  sessionCommands: 'session/commands',
  sessionCommand: 'session/command',
  sessionModelCatalog: 'session/modelCatalog',
  sessionSelectModel: 'session/selectModel',
  sessionApproval: 'session/approval',
  sessionStatus: 'session/status',
} as const

export type RwMethod = (typeof RW_METHODS)[keyof typeof RW_METHODS]

/** Stable error codes (protocol §12 + §16.12). */
export const RW_ERROR_CODES = [
  'bad-request', 'unauthorized', 'forbidden', 'lease-mismatch', 'plugin-missing',
  'plugin-protocol-mismatch', 'plugin-version-mismatch', 'profile-mismatch',
  'profile-foreign-client', 'profile-in-use', 'profile-start-timeout', 'profile-start-failed',
  'bootstrap-timeout', 'registry-stale', 'registry-unavailable', 'registry-reload-failed',
  'registry-write-guard-unavailable', 'workspace-path-invalid', 'workspace-unknown',
  'workspace-not-empty', 'session-not-found', 'session/writer-held', 'session/agent-busy', 'session/archived-pin',
  'session/archive-activity', 'executor-held', 'executor-mode-conflict', 'executor-assign-failed',
  'executor-switch-confirm-required', 'executor-switch-busy', 'handle-not-found',
  'persist-read-only', 'persist-create-exists', 'fs-error', 'tunnel-unavailable',
  'upstream-timeout', 'target-not-connected', 'timeout', 'internal',
  'profile-restart-preview-failed', 'profile-locked', 'mode-switch/preview-failed',
  'mode-switch/other-turns-cancelled-required', 'mode-switch/cancel-failed',
  'mode-switch/preview-stale', 'agent-compose-failed', 'session-reveal-timeout',
  'shutdown-flush-timeout', 'session-create-failed', 'title-fold-failed', 'agent-unavailable',
] as const

export type RwErrorCode = (typeof RW_ERROR_CODES)[number]

/** Uniform JSON envelope (protocol §2.1). */
export type RwEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: RwErrorCode | string; readonly message: string; readonly details?: unknown } }

/** Probe/server capabilities (protocol §2.3 + §16.4). */
export interface RwServerCapabilities {
  readonly workspaceApi: 1
  readonly sessionApi: 1
  readonly persistRpc: 1
  readonly executor: 1
  readonly eventsSse: 1
  readonly muxWs: 1
  readonly sessionTimeline?: 1
  readonly sessionEvents?: 1
  readonly agentControl?: 1
  readonly embed: { readonly storagePrefix: string; readonly mode: 'reload' | 'client-half' }
  readonly registryWriteGuard: 'prototype' | 'none'
  readonly registryReload: 'loader-disable-enable' | 'none'
}

/** Durable lease document (protocol §3.4). */
export interface RwProfileLease {
  readonly version: 1
  readonly profile: string
  readonly clientId: string
  readonly instanceId: string
  readonly pid: number
  readonly port: number
  readonly startedAt: string
  readonly heartbeatAt: string
  readonly tokenFingerprint: string
}

export interface RwHandshakeRequest {
  readonly protocol: number
  readonly pluginVersion: string
  readonly clientId: string
  readonly instanceId: string
  readonly profile: string
  readonly capabilities?: readonly string[]
}

export interface RwHandshakeResponse {
  readonly protocol: typeof REMOTE_WORKSPACE_PLUGIN_PROTOCOL
  readonly pluginVersion: string
  readonly dshVersion: string
  readonly profile: string
  readonly clientId: string
  readonly lease: { readonly instanceId: string; readonly expiresAt: string }
  readonly staleTakeover: boolean
  readonly registry: { readonly initialized: boolean; readonly revision: string; readonly epoch: string }
  readonly capabilities: RwServerCapabilities
  readonly activeAgents: readonly RwActiveAgent[]
}

export interface RwActiveAgent {
  readonly sessionId: string
  readonly running: boolean
  readonly status: string
}

export interface RwRpcRequest {
  readonly protocol: number
  readonly method: string
  readonly params?: unknown
}

export interface RwWorkspaceRow {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionIds: readonly string[]
}

export interface RwWorkspaceListValue {
  readonly registry: { readonly revision: string; readonly epoch: string; readonly initialized: boolean }
  readonly workspaces: readonly RwWorkspaceRow[]
  readonly pinnedSessionIds: readonly string[]
  readonly archivedSessionIds: readonly string[]
}

export interface RwSessionRow {
  readonly sessionId: string
  readonly title?: string
  /** Execution end used by the row's next turn; absent record defaults to server. */
  readonly executor: 'server' | 'local'
  readonly titleSource?: 'live' | 'projection' | 'log' | 'fallback'
  readonly blank: boolean
  readonly running: boolean
  readonly agentAvailable: boolean
  readonly cwd?: string
  readonly updatedAt: number
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
  readonly formatStatus?: 'current' | 'migration-required'
  readonly pinned: boolean
  readonly archived: boolean
  readonly workspaceId?: string
}

export interface RwSessionListValue {
  readonly registry: { readonly revision: string; readonly epoch: string }
  readonly sessions: readonly RwSessionRow[]
}

export type RwExecutorMode = 'server' | 'local'

export interface RwExecutorRecord {
  readonly version: 1
  readonly sessionId: string
  readonly mode: RwExecutorMode
  readonly updatedAt: string
  readonly owner?: {
    readonly clientId: string
    readonly instanceId: string
    readonly heartbeatAt: string
  }
  readonly switchedBy?: 'user' | 'default' | 'handoff'
}

export interface RwExecutorSwitchPlan {
  readonly currentMode: RwExecutorMode
  readonly to: RwExecutorMode
  readonly restartRequired: boolean
  readonly activeTurns: readonly RwActiveAgent[]
  readonly requiresConfirmation: boolean
  readonly targetTurnRunning: boolean
}

/** Persisted session snapshot forwarded by `persist/list`. */
export interface RwPersistSnapshot {
  readonly header: unknown
  readonly revision?: string
  readonly formatStatus?: 'current' | 'migration-required'
  readonly eventCount?: number
  readonly sizeBytes?: number
}

/** SSE frames (protocol §6). */
export type RwSseFrame =
  | { readonly event: 'hello'; readonly data: unknown }
  | { readonly event: 'change'; readonly data: { readonly kind: 'workspace' | 'session' | 'executor'; readonly reason: 'local' | 'external'; readonly revision?: string; readonly workspaceId?: string; readonly sessionId?: string } }
  | { readonly event: 'error'; readonly data: { readonly code: string; readonly message: string } }

/** Embed bootstrap configuration written before the official app bundle (protocol §9.1). */
export interface RwEmbedConfig {
  readonly protocol: typeof REMOTE_WORKSPACE_PLUGIN_PROTOCOL
  readonly storagePrefix: string
  readonly injectedAt: string
}

/** One directory entry returned by the P1 `fs/list` browser (protocol §4.3). */
export interface RwFsDirEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'other'
}

/** `fs/list` request; `path` omitted means the server user's home. */
export interface RwListDirRequest {
  readonly path?: string
}

/** One blocking directory page for the client's add-workspace browser. */
export interface RwListDirResult {
  readonly home: string
  readonly path: string
  readonly parent: string | null
  readonly entries: readonly RwFsDirEntry[]
}


// ─────────────────────────────────────────────────────────────────────────────
// v2 self-drawn conversation data plane (additive to v1 methods above).
// ─────────────────────────────────────────────────────────────────────────────

/** One normalized conversation item; unknown log events are preserved as `unknown`. */
export type RwTimelineEntry =
  | { readonly kind: 'user'; readonly entryId: string; readonly seq: number; readonly time: number; readonly text: string; readonly messageId?: string }
  | { readonly kind: 'assistant'; readonly entryId: string; readonly seq: number; readonly time: number; readonly text: string; readonly interrupted?: true }
  | { readonly kind: 'reasoning'; readonly entryId: string; readonly seq: number; readonly time: number; readonly text: string }
  | { readonly kind: 'tool-call'; readonly entryId: string; readonly seq: number; readonly time: number; readonly callId: string; readonly name: string; readonly arguments: string }
  | { readonly kind: 'tool-result'; readonly entryId: string; readonly seq: number; readonly time: number; readonly callId: string; readonly isError: boolean; readonly text: string; readonly truncated?: true; readonly totalBytes?: number; readonly error?: { readonly name?: string; readonly code?: string; readonly reason?: string } }
  | { readonly kind: 'turn'; readonly entryId: string; readonly seq: number; readonly time: number; readonly phase: 'start' | 'end'; readonly turn: number; readonly reason?: string }
  | { readonly kind: 'error'; readonly entryId: string; readonly seq: number; readonly time: number; readonly message: string; readonly code?: string }
  | { readonly kind: 'approval'; readonly entryId: string; readonly seq: number; readonly time: number; readonly approvalId: string; readonly state: 'asked' | 'decided'; readonly toolName?: string; readonly reason?: string; readonly outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
  | { readonly kind: 'unknown'; readonly entryId: string; readonly seq: number; readonly time: number; readonly type: string; readonly ignorable: boolean }

/** `session/timeline`: one backward page of normalized entries. */
export interface RwTimelineRequest {
  readonly sessionId: string
  /** Exclusive upper cursor; omitted means end of log. */
  readonly beforeSeq?: number
  readonly limit?: number
}

/** One chronological page; `nextBeforeSeq` is the cursor for the next older page. */
export interface RwTimelineValue {
  readonly sessionId: string
  readonly entries: readonly RwTimelineEntry[]
  readonly eventCount: number
  readonly beforeSeq: number
  readonly nextBeforeSeq: number | null
  /** Alias used by the P3 host (`afterSeq` = exclusive upper cursor). */
  readonly afterSeq?: number
  readonly nextAfterSeq?: number | null
}

/** Pending or historical approval summary exposed to the self-drawn client. */
export interface RwApprovalSummary {
  readonly approvalId: string
  readonly sessionId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly displayReason?: Record<string, string>
  readonly requestedAt: number
}

/** `session/prompt`: deliver one user turn (or steering message) to the managed agent. */
export interface RwPromptAttachment {
  /** Browser display name; the server sanitizes it before storage. */
  readonly name: string
  /** Declared media type; the attachment store verifies the bytes. */
  readonly mediaType: string
  /** Canonical base64 bytes; the host route bounds the request body to 1 MiB. */
  readonly data: string
}

export interface RwPromptRequest {
  readonly sessionId: string
  readonly text: string
  readonly mode?: 'followup' | 'steer'
  readonly requestId?: string
  /** Images/files admitted by the server attachment store and sent with the turn. */
  readonly attachments?: readonly RwPromptAttachment[]
}

export interface RwCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: unknown
}

export interface RwCommandListValue {
  readonly sessionId: string
  readonly commands: readonly RwCommandDescriptor[]
}

export interface RwCommandRequest {
  readonly sessionId: string
  readonly line: string
}

export interface RwCommandValue {
  readonly sessionId: string
  readonly executed: boolean
  readonly commandId?: string
  readonly result?: unknown
}

/** `session/prompt` acceptance; the turn itself is observed through `session/events`. */
export interface RwPromptValue {
  readonly accepted: true
  readonly sessionId: string
}

/** `session/approval`: answer one pending approval request. */
export interface RwApprovalRequest {
  readonly sessionId: string
  readonly approvalId: string
  readonly decision: 'allowed-once' | 'rejected' | 'cancelled' | 'allow' | 'deny'
}

export interface RwApprovalValue {
  readonly accepted: true
  readonly approvalId: string
  readonly decision: 'allowed-once' | 'rejected' | 'cancelled'
}

/** `session/status`: live agent/approval state for one session. */
export interface RwSessionStatusValue {
  readonly sessionId: string
  readonly agentAvailable: boolean
  readonly status?: string
  readonly running: boolean
  readonly pendingApprovals: readonly RwApprovalSummary[]
  /** Additive QA diagnostic: whether the QA approval gate marker is active. */
  readonly approvalGate?: 'qa' | 'off'
}

/** SSE frames on `RW_PATHS.sessionEvents` (named `event:` + JSON data). */
export type RwSessionSseFrame =
  | { readonly event: 'ready'; readonly data: { readonly sessionId: string; readonly afterSeq: number; readonly eventCount: number } }
  | { readonly event: 'timeline'; readonly data: { readonly sessionId: string; readonly entries: readonly RwTimelineEntry[]; readonly afterSeq: number; readonly eventCount: number } }
  | { readonly event: 'status'; readonly data: RwSessionStatusValue }
  | { readonly event: 'approval'; readonly data: RwApprovalSummary }
  | { readonly event: 'error'; readonly data: { readonly code: string; readonly message: string } }
