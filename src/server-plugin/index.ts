/**
 * dsh-remote-workspace-server v1 profile plugin (Phase A skeleton).
 *
 * Runs inside a per-client profile's `dsh web` process and exposes the P1
 * client-host API (handshake/lease/RPC/SSE/mux) plus the embed injection.
 * All official services are consumed through `ctx.get()` so this package keeps
 * a single external boundary: the DSH runtime that installed it.
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import {
  REMOTE_WORKSPACE_PLUGIN_PROTOCOL,
  REMOTE_WORKSPACE_PLUGIN_VERSION,
  RW_HEADERS,
  RW_METHODS,
  RW_PATHS,
  type RwActiveAgent,
  type RwEnvelope,
  type RwHandshakeResponse,
  type RwProfileLease,
  type RwRpcRequest,
  type RwServerCapabilities,
  type RwWorkspaceListValue,
  type RwWorkspaceRow,
} from '../protocol.ts'
import { BOOTSTRAP_SCRIPT, EMBED_CSS } from './embed.ts'
import { PluginError, errorValue, httpStatusFor, scrubSecrets } from './errors.ts'
import { ProfileLease } from './lease.ts'
import { RegistryGuard } from './registry-guard.ts'
import { TitleFold, resolveBlank } from './title-fold.ts'
import { SessionLogCache } from './session-log-cache.ts'
import { ManagedAgents } from './managed.ts'
import { ExecutorStore } from './executor.ts'
import { serveMux } from './mux.ts'
import { readTimeline } from './timeline.ts'
import { sessionEventParams, streamSessionEvents } from './events.ts'
import { ApprovalHub, approveSession, cancelSession, executeSessionCommand, listSessionCommands, promptSession, sessionStatusValue } from './agent-control.ts'
import { installQaApprovalGate, readQaApprovalTool } from './qa-approval.ts'
import { listDirectory } from './fs-api.ts'
import { executorModeOf } from './session-row.ts'
import { renameStoredSession } from './session-rename.ts'
import { PersistBridge } from './persist.ts'

/** Cordis row name. */
export const name = 'dsh-remote-workspace-server'

/** The web carrier is the only required service; everything else is optional and probed. */
// `sessionController` is deliberately NOT a static inject: it depends on
// workspaceRegistry, so registry/refresh (loader disable/enable of the
// workspace row) would unload this plugin and permanently lose its routes.
// Resolve it lazily in dispatch and fall back to the durable log rename.
export const inject = ['webServer', 'connection', 'fs', 'subprocess', 'sandbox', 'sessionPersistence']

/** The pinned DSH runtime this package was verified against. */
export const DSH_VERIFIED_RUNTIME = '0.2.1-rc.3'

/** Optional profile overrides; the plugin has no required config and exports no Config schema. */
export interface PluginOptions {
  /** Profile name; defaults to ctx.profileContext.name. */
  profile?: string
  /** clientId; defaults to the profile-name suffix. */
  clientId?: string
  /** Override for the profile directory (tests). */
  profileDir?: string
  /** Override for `$DSH_HOME` (tests). */
  home?: string
  /** Override for the workspace registry file (tests). */
  registryFile?: string
  /** Lease heartbeat cadence. */
  leaseHeartbeatMs?: number
}

/** Structural slices of official services this plugin consumes. */
interface WebServerLike {
  port?: number
  protocol?: string
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
  registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void> }): () => void
  tapIndex(transform: (html: string) => string): () => void
}

interface ConnectionLike {
  admit(request: IncomingMessage): { peer: unknown } | { rejection: number }
}

interface RegistryLike {
  list(): WorkspaceLike[]
  create(path: string, title?: string): Promise<WorkspaceLike>
  delete(id: string): Promise<boolean>
  insertBefore(id: string, beforeId?: string): Promise<readonly string[]>
  initializeDefault(resolve: () => Promise<string>): Promise<WorkspaceLike | undefined>
  pinSession(id: string): Promise<void>
  unpinSession(id: string): Promise<void>
  archiveSession(id: string, options?: { stopActivity?: boolean }): Promise<void>
  unarchiveSession(id: string): Promise<void>
  readonly pinnedSessionIds: readonly string[]
  readonly archivedSessionIds: readonly string[]
}

interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionIds: readonly string[]
  attachSession(id: string): Promise<void>
}

interface PersistenceLike {
  flush(options?: unknown): Promise<void>
}

interface AgentLike {
  readonly id: string
  readonly status: string
  whenIdle(): Promise<void>
}

interface AgentsLike {
  list(): AgentLike[]
}

interface SessionSummaryLike {
  readonly sessionId: string
  readonly title?: string
  readonly blank?: boolean
  readonly running?: boolean
  readonly agentAvailable?: boolean
  readonly cwd?: string
  readonly updatedAt?: number
  readonly parentSessionId?: string
  readonly origin?: 'subagent'
  readonly formatStatus?: 'current' | 'migration-required'
  readonly projections?: { readonly values?: { readonly title?: string | null; readonly sessionListMetadata?: { readonly blank?: boolean; readonly lastPromptAt?: number | null } } }
}

interface PersistenceSnapshotLike {
  readonly header: Record<string, unknown>
  readonly sizeBytes?: number
  readonly eventCount?: number
  readonly formatStatus?: 'current' | 'migration-required'
  readonly revision?: unknown
}

interface SessionControllerLike {
  cancel(request: { sessionId: string }): unknown
  list?(request: unknown, signal: AbortSignal): Promise<{ readonly items: readonly SessionSummaryLike[] }>
  create?(request: Record<string, unknown>): Promise<{ readonly sessionId: string; readonly agentPreset?: string }>
  rename?(request: Record<string, unknown>): Promise<{ readonly title: string; readonly seq: number }>
  fork?(request: Record<string, unknown>): Promise<{ readonly sessionId: string }>
  modelCatalog?(): Promise<unknown>
  selectModel?(request: Record<string, unknown>): Promise<unknown>
}

interface PersistenceLike {
  flush(options?: unknown): Promise<void>
  list?(options?: unknown): Promise<readonly PersistenceSnapshotLike[]>
  stat?(id: string): Promise<PersistenceSnapshotLike | undefined>
}

interface LoaderEntryLike {
  readonly options: { readonly id: string; readonly name: string; readonly disabled?: boolean | null }
  readonly fiber?: { readonly state: number }
  update(options: { disabled?: boolean }): Promise<void>
}

interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
  await(): Promise<void>
}

interface ProfileContextLike {
  readonly name: string
  readonly dir: string
  readonly home: string
}

interface PluginPaths {
  readonly profile: string
  readonly clientId: string
  readonly profileDir: string
  readonly home: string
  readonly registryFile: string
  readonly leaseFile: string
  readonly lockDir: string
}

/** Runtime state shared by the routes and the (later) registry guard. */
export interface PluginState {
  readonly paths: PluginPaths
  readonly pluginVersion: string
  readonly titleFold: TitleFold
  managed?: ManagedAgents
  executor?: ExecutorStore
  persist?: PersistBridge
  guardProbe?: () => Promise<void>
  guardReady?: Promise<void>
  registerGuard?: () => { revision: string; loadedRevision: string; epoch: string; stale: boolean; capability: 'prototype' | 'none'; reload: 'loader-disable-enable' | 'none' }
  refreshRegistry?: () => Promise<{ revision: string; serviceReplaced: boolean }>
  approvals?: ApprovalHub
  approvalGate?: 'qa' | 'off'
  sessionController?: SessionControllerLike
}

/** Read the package version from the installed package root. */
function readPluginVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url)
    const value = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown }
    return typeof value.version === 'string' ? value.version : REMOTE_WORKSPACE_PLUGIN_VERSION
  } catch {
    return REMOTE_WORKSPACE_PLUGIN_VERSION
  }
}

/** SHA-256 revision of the workspace registry file, or `absent`. */
async function registryRevision(file: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
}

/** Read and validate a JSON body under the 1 MiB contract. */
async function readJson(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > limit) throw new PluginError('bad-request', 'request body exceeds 1 MiB')
    chunks.push(bytes)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new PluginError('bad-request', 'request body is not JSON')
  }
}

/** Send one JSON envelope. */
function sendJson(res: ServerResponse, status: number, value: RwEnvelope<unknown>): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sendOk(res: ServerResponse, value: unknown): void {
  sendJson(res, 200, { ok: true, value })
}

function sendError(res: ServerResponse, error: unknown): void {
  const value = errorValue(error)
  sendJson(res, httpStatusFor(value.code), { ok: false, error: value as never })
}


function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Resolve all paths from config/profileContext. */
function resolvePaths(ctx: Context, config: PluginOptions): PluginPaths | undefined {
  const profileContext = ctx.get('profileContext') as ProfileContextLike | undefined
  const profile = config.profile ?? profileContext?.name
  if (profile === undefined || profile === '') return undefined
  const home = config.home ?? profileContext?.home ?? process.env['DSH_HOME'] ?? join(process.env['HOME'] ?? process.cwd(), '.dsh')
  const profileDir = config.profileDir ?? profileContext?.dir ?? join(home, 'profiles', profile)
  const suffix = profile.startsWith('graydovee-remote-workspace-') ? profile.slice('graydovee-remote-workspace-'.length) : profile
  const clientId = config.clientId ?? suffix
  return {
    profile,
    clientId,
    profileDir,
    home,
    registryFile: config.registryFile ?? join(home, 'storages', 'workspace.json'),
    leaseFile: join(profileDir, '.dsh-rw', 'lease.json'),
    lockDir: join(home, 'remote-workspace', 'locks'),
  }
}

function capabilities(state: PluginState): RwServerCapabilities {
  const guard = state.registerGuard?.()
  return {
    workspaceApi: 1,
    sessionApi: 1,
    persistRpc: 1,
    executor: 1,
    eventsSse: 1,
    muxWs: 1,
    embed: { storagePrefix: `dshrw:${state.paths.profile}:`, mode: 'reload' },
    registryWriteGuard: guard?.capability ?? 'none',
    registryReload: guard?.reload ?? 'none',
  }
}

function activeAgents(ctx: Context): RwActiveAgent[] {
  const agents = ctx.get('agents') as AgentsLike | undefined
  if (agents === undefined) return []
  return agents.list().map(agent => ({ sessionId: String(agent.id), running: agent.status === 'running', status: agent.status }))
}

function workspaceRow(workspace: WorkspaceLike): RwWorkspaceRow {
  return {
    workspaceId: String(workspace.id),
    path: workspace.path,
    title: workspace.title,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    sessionIds: [...workspace.sessionIds],
  }
}

async function workspaceList(ctx: Context, state: PluginState): Promise<RwWorkspaceListValue> {
  const registry = ctx.get('workspaceRegistry') as RegistryLike | undefined
  if (registry === undefined) throw new PluginError('registry-unavailable', 'the profile has no workspaceRegistry service')
  await state.guardProbe?.()
  const guard = state.registerGuard?.()
  return {
    registry: {
      revision: guard?.revision ?? await registryRevision(state.paths.registryFile),
      epoch: guard?.epoch ?? '0',
      initialized: registry.list().length > 0,
    },
    workspaces: registry.list().map(workspaceRow),
    pinnedSessionIds: [...registry.pinnedSessionIds],
    archivedSessionIds: [...registry.archivedSessionIds],
  }
}

/** Cancel every live agent, wait for turn tails, then flush the official log. */
async function cancelAll(ctx: Context): Promise<{ canceled: string[] }> {
  const agents = ctx.get('agents') as AgentsLike | undefined
  const controller = ctx.get('sessionController') as SessionControllerLike | undefined
  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
  const canceled: string[] = []
  const idle: Promise<void>[] = []
  for (const agent of agents?.list() ?? []) {
    try {
      controller?.cancel({ sessionId: String(agent.id) })
      canceled.push(String(agent.id))
      idle.push(agent.whenIdle())
    } catch (error) {
      console.error(`[dsh-remote-workspace-server] cancel ${String(agent.id)} failed: ${scrubSecrets(error instanceof Error ? error.message : String(error))}`)
    }
  }
  const settled = await Promise.race([
    Promise.allSettled(idle),
    new Promise<'timeout'>(resolve => { const timer = setTimeout(() => { resolve('timeout') }, 3_000); timer.unref() }),
  ])
  const flush = persistence?.flush()
  const flushed = await Promise.race([
    Promise.resolve(flush).then(() => true, () => false),
    new Promise<boolean>(resolve => { const timer = setTimeout(() => { resolve(false) }, 3_000); timer.unref() }),
  ])
  if (settled === 'timeout' || flushed === false) {
    throw new PluginError('shutdown-flush-timeout', 'turn tail or session log flush did not settle within 3 s', { sessions: canceled, waitedMs: 3_000 })
  }
  return { canceled }
}

/** Register the handshake/lease/RPC/SSE/mux routes and embed injection. */
function installRoutes(ctx: Context, config: PluginOptions, state: PluginState, lease: ProfileLease): void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) throw new Error('dsh-remote-workspace-server requires ctx.webServer')
  const admit = (req: IncomingMessage): boolean => {
    const connection = ctx.get('connection') as ConnectionLike | undefined
    if (connection === undefined) return false
    const admission = connection.admit(req)
    return !('rejection' in admission)
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: RW_PATHS.handshake,
    handler: async (req, res) => {
      if (!admit(req)) { sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: 'authentication required' } }); return }
      try {
        const body = await readJson(req) as Record<string, unknown>
        sendOk(res, await handshakeResponse(ctx, state, lease, body))
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-rw: handshake route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: RW_PATHS.rpc,
    handler: async (req, res) => {
      if (!admit(req)) { sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: 'authentication required' } }); return }
      try {
        if (!lease.matches(header(req, RW_HEADERS.client), header(req, RW_HEADERS.instance))) {
          throw new PluginError('lease-mismatch', 'the request headers do not match the active profile lease')
        }
        const body = await readJson(req) as RwRpcRequest
        if (body === null || typeof body !== 'object' || typeof body.method !== 'string') throw new PluginError('bad-request', 'expected { protocol, method, params }')
        if (Number(body.protocol) !== REMOTE_WORKSPACE_PLUGIN_PROTOCOL) throw new PluginError('plugin-protocol-mismatch', `unsupported plugin protocol ${String(body.protocol)}; this server speaks ${REMOTE_WORKSPACE_PLUGIN_PROTOCOL}`, { serverProtocol: REMOTE_WORKSPACE_PLUGIN_PROTOCOL })
        sendOk(res, await dispatch(ctx, state, lease, body.method, body.params))
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-rw: rpc route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: RW_PATHS.bootstrap,
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(BOOTSTRAP_SCRIPT)
    },
  }), 'dsh-rw: bootstrap route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: RW_PATHS.embedCss,
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
      res.end(EMBED_CSS)
    },
  }), 'dsh-rw: embed css route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: RW_PATHS.events,
    handler: async (req, res) => {
      if (!admit(req)) { res.writeHead(401); res.end('unauthorized'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
      const hello = {
        protocol: REMOTE_WORKSPACE_PLUGIN_PROTOCOL,
        profile: state.paths.profile,
        instance: lease.current?.instanceId,
        registry: { revision: state.registerGuard?.()?.revision ?? await registryRevision(state.paths.registryFile), epoch: state.registerGuard?.()?.epoch ?? '0', initialized: true },
        capabilities: capabilities(state),
      }
      res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`)
      const ping = setInterval(() => { res.write(': ping\n\n') }, 15_000)
      ping.unref()
      req.on('close', () => clearInterval(ping))
    },
  }), 'dsh-rw: events route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: RW_PATHS.sessionEvents,
    handler: async (req, res) => {
      if (!admit(req)) { res.writeHead(401); res.end('unauthorized'); return }
      try {
        const client = header(req, RW_HEADERS.client)
        const instance = header(req, RW_HEADERS.instance)
        // EventSource cannot set custom headers; cookie admission is enough in
        // that case. Host-side streaming sends the lease headers and is checked.
        if ((client !== undefined || instance !== undefined) && !lease.matches(client, instance)) {
          throw new PluginError('lease-mismatch', 'the session-events headers do not match the active profile lease')
        }
        const params = sessionEventParams(req.url)
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
        res.flushHeaders?.()
        const abort = new AbortController()
        req.on('close', () => abort.abort())
        const sink = {
          send: (frame: { event: string; data: unknown }): void => {
            if (!res.writableEnded) res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)
          },
          comment: (text: string): void => { if (!res.writableEnded) res.write(`: ${text}\n\n`) },
          closed: (): boolean => res.writableEnded || abort.signal.aborted,
        }
        try {
          await streamSessionEvents(ctx, {
            sessionId: params.sessionId,
            afterSeq: params.afterSeq,
            sink,
            signal: abort.signal,
            ...(state.approvals === undefined ? {} : { approvals: state.approvals }),
          })
        } catch (error) {
          const value = errorValue(error)
          if (!res.writableEnded) res.write(`event: error\ndata: ${JSON.stringify(value)}\n\n`)
        }
        if (!res.writableEnded) res.end()
      } catch (error) { sendError(res, error) }
    },
  }), 'dsh-rw: session events route')

  ctx.effect(() => webServer.registerUpgrade({
    path: RW_PATHS.mux,
    handler: (req, socket) => {
      if (!admit(req) || !lease.matches(header(req, RW_HEADERS.client), header(req, RW_HEADERS.instance))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      serveMux(ctx, lease, req, socket, Buffer.alloc(0))
    },
  }), 'dsh-rw: mux upgrade')

  ctx.effect(() => webServer.tapIndex(html => {
    if (html.includes('__DSH_RW_EMBED__')) return html
    const embed = {
      protocol: REMOTE_WORKSPACE_PLUGIN_PROTOCOL,
      storagePrefix: `dshrw:${state.paths.profile}:`,
      embedCssPath: RW_PATHS.embedCss.slice(1),
    }
    // Relative URLs resolve under the portal prefix (and under the origin root when served directly);
    // an absolute /dsh-remote-workspace-server/... path would escape the portal mount.
    const injection = `<script>window.__DSH_RW_EMBED__=${JSON.stringify(embed)}</script><script src="${RW_PATHS.bootstrap.slice(1)}"></script>`
    return html.replace('<head>', `<head>${injection}`)
  }), 'dsh-rw: embed index injection')
}

/** Validate handshake fields before claiming the lease. */
function validateHandshake(state: PluginState, body: Record<string, unknown>): void {
  if (Number(body['protocol']) !== REMOTE_WORKSPACE_PLUGIN_PROTOCOL) {
    throw new PluginError('plugin-protocol-mismatch', `unsupported plugin protocol ${String(body['protocol'])}; this server speaks ${REMOTE_WORKSPACE_PLUGIN_PROTOCOL}`, { clientProtocol: body['protocol'], serverProtocol: REMOTE_WORKSPACE_PLUGIN_PROTOCOL })
  }
  const clientId = typeof body['clientId'] === 'string' ? body['clientId'] : ''
  const instanceId = typeof body['instanceId'] === 'string' ? body['instanceId'] : ''
  const profile = typeof body['profile'] === 'string' ? body['profile'] : ''
  const pluginVersion = typeof body['pluginVersion'] === 'string' ? body['pluginVersion'] : ''
  if (clientId === '' || instanceId === '' || profile === '') throw new PluginError('bad-request', 'handshake requires clientId, instanceId and profile')
  if (profile !== state.paths.profile) throw new PluginError('profile-mismatch', `this profile is "${state.paths.profile}", not "${profile}"`)
  if (clientId !== state.paths.clientId) throw new PluginError('profile-foreign-client', `profile "${state.paths.profile}" belongs to client "${state.paths.clientId}"`)
  if (pluginVersion !== state.pluginVersion) {
    throw new PluginError('plugin-version-mismatch', `server plugin ${state.pluginVersion} does not match client plugin ${pluginVersion}; reinstall the server plugin`, { clientVersion: pluginVersion, serverVersion: state.pluginVersion })
  }
}

async function handshakeResponse(ctx: Context, state: PluginState, lease: ProfileLease, body: Record<string, unknown>): Promise<RwHandshakeResponse> {
  validateHandshake(state, body)
  const token = typeof body['tokenFingerprint'] === 'string' ? body['tokenFingerprint'] : ''
  const decision = await lease.claim({
    clientId: String(body['clientId']),
    instanceId: String(body['instanceId']),
    port: (ctx.get('webServer') as WebServerLike | undefined)?.port ?? 0,
    tokenFingerprint: createHash('sha256').update(token).digest('hex').slice(0, 16),
  })
  if (decision.kind === 'foreign-client') throw new PluginError('profile-foreign-client', `this profile belongs to client "${decision.ownerClientId}"`)
  if (decision.kind === 'in-use') {
    throw new PluginError('profile-in-use', 'this profile is being driven by another client instance', {
      ownerInstanceId: decision.owner.instanceId,
      ownerPid: decision.owner.pid,
      startedAt: decision.owner.startedAt,
    })
  }
  await Promise.race([state.guardReady, new Promise<void>(resolve => { const timer = setTimeout(resolve, 1_000); timer.unref() })])
  await state.guardProbe?.()
  const guard = state.registerGuard?.()
  return {
    protocol: REMOTE_WORKSPACE_PLUGIN_PROTOCOL,
    pluginVersion: state.pluginVersion,
    dshVersion: DSH_VERIFIED_RUNTIME,
    profile: state.paths.profile,
    clientId: state.paths.clientId,
    lease: { instanceId: decision.lease.instanceId, expiresAt: new Date(Date.parse(decision.lease.heartbeatAt) + 20_000).toISOString() },
    staleTakeover: decision.staleTakeover,
    registry: { initialized: true, revision: guard?.revision ?? await registryRevision(state.paths.registryFile), epoch: guard?.epoch ?? '0' },
    capabilities: capabilities(state),
    activeAgents: activeAgents(ctx),
  }
}


function workspaceRegistry(ctx: Context): RegistryLike {
  const registry = ctx.get('workspaceRegistry') as RegistryLike | undefined
  if (registry === undefined) throw new PluginError('registry-unavailable', 'the profile has no workspaceRegistry service')
  return registry
}

function workspaceEntity(ctx: Context, workspaceId: string): WorkspaceLike {
  const found = workspaceRegistry(ctx).list().find(workspace => String(workspace.id) === workspaceId)
  if (found === undefined) throw new PluginError('workspace-unknown', `unknown workspace "${workspaceId}"`, { workspaceId })
  return found
}

async function workspaceCreate(ctx: Context, params: Record<string, unknown>): Promise<RwWorkspaceRow> {
  const path = typeof params['path'] === 'string' ? params['path'] : ''
  if (!path.startsWith('/')) throw new PluginError('workspace-path-invalid', 'workspace path must be an absolute server path', { path })
  try {
    return workspaceRow(await workspaceRegistry(ctx).create(path, typeof params['title'] === 'string' ? params['title'] : undefined))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new PluginError('workspace-path-invalid', `workspace path is not an existing directory: ${path}`, { path })
    throw error
  }
}

async function workspaceRename(ctx: Context, params: Record<string, unknown>): Promise<RwWorkspaceRow> {
  const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : ''
  const title = typeof params['title'] === 'string' ? params['title'].trim() : ''
  if (title === '') throw new PluginError('bad-request', 'workspace title must not be empty')
  const workspace = workspaceEntity(ctx, workspaceId)
  await (workspace as WorkspaceLike & { setTitle(title: string): Promise<void> }).setTitle(title)
  return workspaceRow(workspaceEntity(ctx, workspaceId))
}

async function workspaceDelete(ctx: Context, params: Record<string, unknown>): Promise<{ deleted: boolean }> {
  const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : ''
  const workspace = workspaceEntity(ctx, workspaceId)
  if (params['force'] !== true && workspace.sessionIds.length > 0) {
    throw new PluginError('workspace-not-empty', `workspace "${workspaceId}" still has ${workspace.sessionIds.length} sessions`, { sessionCount: workspace.sessionIds.length, sessionIds: workspace.sessionIds })
  }
  return { deleted: await workspaceRegistry(ctx).delete(workspaceId) }
}

async function workspaceReorder(ctx: Context, params: Record<string, unknown>): Promise<{ order: readonly string[] }> {
  const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : ''
  const before = typeof params['beforeWorkspaceId'] === 'string' ? params['beforeWorkspaceId'] : undefined
  return { order: await workspaceRegistry(ctx).insertBefore(workspaceId, before) }
}

function mapArchiveError(error: unknown): never {
  if ((error as { name?: string } | undefined)?.name === 'WorkspaceActiveSessionError') {
    throw new PluginError('session/archive-activity', (error as Error).message, { activity: (error as { activity?: unknown }).activity })
  }
  throw error
}

async function sessionList(ctx: Context, state: PluginState, params: Record<string, unknown>): Promise<unknown> {
  await state.guardProbe?.()
  const registry = workspaceRegistry(ctx)
  const workspaces = registry.list()
  const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined
  const pinned = new Set(registry.pinnedSessionIds.map(String))
  const archived = new Set(registry.archivedSessionIds.map(String))
  const workspaceOf = new Map<string, string>()
  for (const workspace of workspaces) for (const id of workspace.sessionIds) workspaceOf.set(String(id), String(workspace.id))
  const controller = ctx.get('sessionController') as SessionControllerLike | undefined
  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
  const summaries: SessionSummaryLike[] = []
  if (controller?.list !== undefined) {
    try {
      summaries.push(...(await controller.list({}, AbortSignal.timeout(10_000))).items)
    } catch (error) {
      console.error(`[dsh-remote-workspace-server] sessionController.list failed, falling back to persistence: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (summaries.length === 0 && persistence?.list !== undefined) {
    for (const snapshot of await persistence.list()) {
      const header = snapshot.header as { id?: unknown; cwd?: unknown; createdAt?: unknown }
      if (typeof header.id !== 'string') continue
      summaries.push({ sessionId: header.id, cwd: typeof header.cwd === 'string' ? header.cwd : undefined })
    }
  }
  const roleOrder = workspaceId === undefined ? undefined : workspaces.find(workspace => String(workspace.id) === workspaceId)?.sessionIds.map(String)
  const sessions = []
  for (const summary of summaries) {
    const id = String(summary.sessionId)
    if (workspaceId !== undefined && workspaceOf.get(id) !== workspaceId) continue
    const stored = await persistence?.stat?.(id).catch(() => undefined)
    const sizeBytes = stored?.sizeBytes
    const projectionTitle = summary.projections?.values?.title
    const liveTitle = summary.agentAvailable === true ? summary.title : undefined
    let title = liveTitle ?? (typeof projectionTitle === 'string' && projectionTitle !== '' ? projectionTitle : undefined)
    let titleSource: 'live' | 'projection' | 'log' | 'fallback' = liveTitle !== undefined ? 'live' : title !== undefined ? 'projection' : 'fallback'
    const metadataBlank = summary.projections?.values?.sessionListMetadata?.blank
    const live = summary.agentAvailable === true
    let blank = resolveBlank(metadataBlank, live, summary.blank, undefined)
    let updatedAt = summary.updatedAt ?? 0
    // Cold summaries default `blank` to false when no projection cache row
    // exists; fold the log whenever blank is not authoritative (or the cheap
    // title/activity hints are missing).
    if (title === undefined || updatedAt <= 0 || (metadataBlank === undefined && !live)) {
      const folded = await state.titleFold.facts(id, sizeBytes)
      if (title === undefined && folded?.title !== undefined) { title = folded.title; titleSource = 'log' }
      blank = resolveBlank(metadataBlank, live, summary.blank, folded?.blank)
      if (updatedAt <= 0 && folded?.updatedAt !== undefined) updatedAt = folded.updatedAt
    }
    const headerCreatedAt = typeof stored?.header?.['createdAt'] === 'number' ? stored.header['createdAt'] as number : 0
    if (updatedAt <= 0) updatedAt = headerCreatedAt
    sessions.push({
      sessionId: id,
      executor: executorModeOf(await state.executor?.get(id)),
      ...(title === undefined ? {} : { title, titleSource }),
      blank,
      running: summary.running === true,
      agentAvailable: summary.agentAvailable === true,
      ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
      updatedAt,
      ...(summary.parentSessionId === undefined ? {} : { parentSessionId: summary.parentSessionId }),
      ...(summary.origin === undefined ? {} : { origin: summary.origin }),
      ...(summary.formatStatus === undefined ? {} : { formatStatus: summary.formatStatus }),
      pinned: pinned.has(id),
      archived: archived.has(id),
      ...(workspaceOf.get(id) === undefined ? {} : { workspaceId: workspaceOf.get(id) }),
    })
  }
  if (roleOrder !== undefined) {
    const rank = new Map(roleOrder.map((id, index) => [id, index]))
    sessions.sort((left, right) => (rank.get(left.sessionId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.sessionId) ?? Number.MAX_SAFE_INTEGER))
  } else {
    sessions.sort((left, right) => right.updatedAt - left.updatedAt)
  }
  const guard = state.registerGuard?.()
  return { registry: { revision: guard?.revision ?? await registryRevision(state.paths.registryFile), epoch: guard?.epoch ?? '0' }, sessions }
}

async function persistList(ctx: Context): Promise<unknown> {
  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
  if (persistence?.list === undefined) throw new PluginError('internal', 'sessionPersistence.list is unavailable')
  const snapshots = await persistence.list()
  return { snapshots: snapshots.map(snapshot => ({
    header: snapshot.header,
    ...(snapshot.sizeBytes === undefined ? {} : { sizeBytes: snapshot.sizeBytes }),
    ...(snapshot.eventCount === undefined ? {} : { eventCount: snapshot.eventCount }),
    ...(snapshot.formatStatus === undefined ? {} : { formatStatus: snapshot.formatStatus }),
    ...(snapshot.revision === undefined ? {} : { revision: String(snapshot.revision) }),
  })) }
}

async function persistLocate(ctx: Context, params: Record<string, unknown>): Promise<unknown> {
  const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
  const snapshot = await persistence?.stat?.(sessionId)
  if (snapshot === undefined) return null
  const cwd = snapshot.header['cwd']
  if (typeof cwd !== 'string') return null
  const workspace = workspaceRegistry(ctx).list().find(candidate => candidate.path === cwd)
  return { remoteCwd: cwd, ...(workspace === undefined ? {} : { workspaceId: String(workspace.id) }) }
}

function leaseOwner(lease: ProfileLease): { clientId: string; instanceId: string; heartbeatAt: string } | undefined {
  const current = lease.current
  return current === undefined ? undefined : { clientId: current.clientId, instanceId: current.instanceId, heartbeatAt: current.heartbeatAt }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function dispatch(ctx: Context, state: PluginState, lease: ProfileLease, method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case RW_METHODS.heartbeat: {
      const value = await lease.heartbeat()
      const guard = state.registerGuard?.()
      return { expiresAt: value.expiresAt, registry: { revision: guard?.revision ?? await registryRevision(state.paths.registryFile), stale: guard?.stale ?? false, epoch: guard?.epoch ?? '0' } }
    }
    case RW_METHODS.release:
      await lease.release()
      return {}
    case RW_METHODS.status: {
      const guard = state.registerGuard?.()
      return {
        lease: lease.current,
        registry: { revision: guard?.revision ?? await registryRevision(state.paths.registryFile), loadedRevision: guard?.loadedRevision ?? await registryRevision(state.paths.registryFile), stale: guard?.stale ?? false, epoch: guard?.epoch ?? '0' },
        activeAgents: activeAgents(ctx),
      }
    }
    case RW_METHODS.cancelAll:
      return await cancelAll(ctx)
    case RW_METHODS.workspaceList:
      return await workspaceList(ctx, state)
    case RW_METHODS.registryStatus: {
      await state.guardProbe?.()
      const guard = state.registerGuard?.()
      return { revision: guard?.revision ?? await registryRevision(state.paths.registryFile), loadedRevision: guard?.loadedRevision ?? await registryRevision(state.paths.registryFile), stale: guard?.stale ?? false, epoch: guard?.epoch ?? '0' }
    }
    case RW_METHODS.registryRefresh:
      if (state.refreshRegistry === undefined) throw new PluginError('registry-reload-failed', 'in-process registry reload is unavailable in this build')
      return await state.refreshRegistry()
    case RW_METHODS.workspaceCreate:
      return await workspaceCreate(ctx, asRecord(params))
    case RW_METHODS.workspaceRename:
      return await workspaceRename(ctx, asRecord(params))
    case RW_METHODS.workspaceDelete:
      return await workspaceDelete(ctx, asRecord(params))
    case RW_METHODS.workspaceReorder:
      return await workspaceReorder(ctx, asRecord(params))
    case RW_METHODS.sessionList:
      return await sessionList(ctx, state, asRecord(params))
    case RW_METHODS.sessionPrepareServer: {
      const sessionId = asRecord(params)['sessionId']
      if (typeof sessionId !== 'string') throw new PluginError('bad-request', 'session/prepare-server requires sessionId')
      if (state.managed === undefined) throw new PluginError('agent-compose-failed', 'managed agents are unavailable in this build')
      return await state.managed.prepare(sessionId)
    }
    case RW_METHODS.sessionCreate: {
      const input = asRecord(params)
      const executor = input['executor'] === 'local' ? 'local' : 'server'
      const workspaceId = typeof input['workspaceId'] === 'string' ? input['workspaceId'] : undefined
      const workspace = workspaceId === undefined ? undefined : workspaceRegistry(ctx).list().find(candidate => String(candidate.id) === workspaceId)
      if (workspaceId !== undefined && workspace === undefined) throw new PluginError('workspace-unknown', `unknown workspace "${workspaceId}"`, { workspaceId })
      const cwd = workspace?.path ?? (typeof input['cwd'] === 'string' ? input['cwd'] : undefined)
      if (cwd === undefined || !cwd.startsWith('/')) throw new PluginError('bad-request', 'session/create requires workspaceId or an absolute cwd')
      const minted = typeof input['sessionId'] === 'string' && input['sessionId'] !== '' ? input['sessionId'] : `session-${randomUUID()}`
      if (executor === 'local') {
        if (workspace === undefined) throw new PluginError('bad-request', 'local session/create requires workspaceId')
        if (state.executor === undefined) throw new PluginError('internal', 'executor store is unavailable')
        await state.executor.assign(minted, 'local', leaseOwner(lease), 'handoff')
        return { sessionId: minted, executor: 'local' }
      }
      if (state.managed === undefined) throw new PluginError('agent-compose-failed', 'managed agents are unavailable in this build')
      const created = await state.managed.createServerBlank(minted, cwd, typeof input['agentPreset'] === 'string' ? input['agentPreset'] : undefined)
      try {
        if (workspace !== undefined) await workspace.attachSession(minted)
      } catch (error) {
        await state.managed.dispose(minted)
        throw new PluginError('internal', `blank session was created but could not attach to workspace "${String(workspace?.id)}": ${error instanceof Error ? error.message : String(error)}`)
      }
      if (state.executor !== undefined) await state.executor.assign(minted, 'server', undefined, 'default')
      return { sessionId: minted, executor: 'server', ...created }
    }
    case RW_METHODS.sessionRename: {
      const controller = ctx.get('sessionController') as SessionControllerLike | undefined
      // Prefer the official service; profiles without its row (or a partial
      // composition) still get a durable log append, which is exactly what the
      // official rename does for a cold session.
      if (controller?.rename !== undefined) return await controller.rename(asRecord(params))
      return await renameStoredSession(ctx, asRecord(params))
    }
    case RW_METHODS.sessionFork: {
      const controller = ctx.get('sessionController') as SessionControllerLike | undefined
      if (controller?.fork === undefined) throw new PluginError('internal', 'sessionController.fork is unavailable')
      return await controller.fork(asRecord(params))
    }
    case RW_METHODS.sessionCancel: {
      const controller = ctx.get('sessionController') as SessionControllerLike | undefined
      const input = asRecord(params)
      const sessionId = input['sessionId']
      if (typeof sessionId !== 'string') throw new PluginError('bad-request', 'session/cancel requires sessionId')
      if (controller?.cancel !== undefined) {
        controller.cancel({ sessionId })
        return { canceled: true }
      }
      return await cancelSession(ctx, state.managed, input)
    }
    case RW_METHODS.sessionPin:
    case RW_METHODS.sessionArchive: {
      const input = asRecord(params)
      const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : ''
      const registry = workspaceRegistry(ctx)
      if (method === RW_METHODS.sessionPin) {
        try {
          if (input['pinned'] === true) await registry.pinSession(sessionId)
          else await registry.unpinSession(sessionId)
        } catch (error) {
          if ((error as { name?: string } | undefined)?.name === 'WorkspaceArchivedSessionPinError') {
            throw new PluginError('session/archived-pin', (error as Error).message, { sessionId })
          }
          if ((error as { name?: string } | undefined)?.name === 'WorkspaceUnknownSessionError') {
            throw new PluginError('session-not-found', (error as Error).message, { sessionId })
          }
          throw error
        }
        return { pinned: [...registry.pinnedSessionIds] }
      }
      try {
        if (input['archived'] === true) await registry.archiveSession(sessionId, { stopActivity: input['stopActivity'] === true })
        else await registry.unarchiveSession(sessionId)
      } catch (error) { mapArchiveError(error) }
      return { archived: [...registry.archivedSessionIds] }
    }
    case RW_METHODS.sessionReorder: {
      const input = asRecord(params)
      const workspace = workspaceEntity(ctx, typeof input['workspaceId'] === 'string' ? input['workspaceId'] : '')
      const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : ''
      const before = typeof input['beforeSessionId'] === 'string' ? input['beforeSessionId'] : undefined
      await (workspace as WorkspaceLike & { insertSessionBefore(id: string, beforeId?: string): Promise<void> }).insertSessionBefore(sessionId, before)
      return { order: [...workspaceEntity(ctx, typeof input['workspaceId'] === 'string' ? input['workspaceId'] : '').sessionIds] }
    }
    case RW_METHODS.persistList:
      return await persistList(ctx)
    case RW_METHODS.persistStat: {
      const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
      const sessionId = asRecord(params)['sessionId']
      if (typeof sessionId !== 'string') throw new PluginError('bad-request', 'persist/stat requires sessionId')
      const snapshot = await persistence?.stat?.(sessionId)
      return snapshot === undefined ? null : { header: snapshot.header, ...(snapshot.sizeBytes === undefined ? {} : { sizeBytes: snapshot.sizeBytes }), ...(snapshot.eventCount === undefined ? {} : { eventCount: snapshot.eventCount }) }
    }
    case RW_METHODS.persistLocate:
      return await persistLocate(ctx, asRecord(params))
    case RW_METHODS.fsList:
      return await listDirectory(ctx, asRecord(params))
    case RW_METHODS.sessionTimeline:
      return await readTimeline(ctx, asRecord(params))
    case RW_METHODS.sessionPrompt:
      return await promptSession(ctx, state.managed, asRecord(params))
    case RW_METHODS.sessionCommands:
      return await listSessionCommands(ctx, state.managed, asRecord(params))
    case RW_METHODS.sessionCommand:
      return await executeSessionCommand(ctx, state.managed, asRecord(params))
    case RW_METHODS.sessionModelCatalog: {
      const controller = state.sessionController ?? ctx.get('sessionController') as SessionControllerLike | undefined
      if (controller?.modelCatalog === undefined) throw new PluginError('agent-unavailable', 'the profile has no sessionController model catalog')
      return await controller.modelCatalog()
    }
    case RW_METHODS.sessionSelectModel: {
      const body = asRecord(params)
      const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : ''
      const provider = typeof body['provider'] === 'string' ? body['provider'] : ''
      const model = typeof body['model'] === 'string' ? body['model'] : ''
      if (sessionId === '' || provider === '' || model === '') throw new PluginError('bad-request', 'session/selectModel requires sessionId, provider and model')
      const controller = state.sessionController ?? ctx.get('sessionController') as SessionControllerLike | undefined
      if (controller?.selectModel === undefined) throw new PluginError('agent-unavailable', 'the profile has no sessionController model selector')
      return await controller.selectModel({ sessionId, provider, model, ...(body['reasoningEffort'] === undefined ? {} : { reasoningEffort: body['reasoningEffort'] }) })
    }
    case RW_METHODS.sessionApproval:
      if (state.approvals === undefined) throw new PluginError('internal', 'the approval hub is unavailable')
      return approveSession(state.approvals, asRecord(params))
    case RW_METHODS.sessionStatus:
      if (state.approvals === undefined) throw new PluginError('internal', 'the approval hub is unavailable')
      return await sessionStatusValue(ctx, state.approvals, asRecord(params), state.approvalGate)
    case RW_METHODS.persistCreate: {
      if (state.persist === undefined) throw new PluginError('internal', 'persist bridge is unavailable')
      return await state.persist.create(asRecord(params))
    }
    case RW_METHODS.persistOpen: {
      if (state.persist === undefined) throw new PluginError('internal', 'persist bridge is unavailable')
      return await state.persist.open(asRecord(params))
    }
    case RW_METHODS.persistRead: {
      if (state.persist === undefined) throw new PluginError('internal', 'persist bridge is unavailable')
      return await state.persist.read(asRecord(params))
    }
    case RW_METHODS.persistAppend: {
      if (state.persist === undefined) throw new PluginError('internal', 'persist bridge is unavailable')
      return await state.persist.append(asRecord(params))
    }
    case RW_METHODS.persistFlush: {
      if (state.persist === undefined) throw new PluginError('internal', 'persist bridge is unavailable')
      return await state.persist.flush(asRecord(params))
    }
    case RW_METHODS.persistClose: {
      if (state.persist === undefined) throw new PluginError('internal', 'persist bridge is unavailable')
      return await state.persist.close(asRecord(params))
    }
    case RW_METHODS.executorGet: {
      const sessionId = asRecord(params)['sessionId']
      if (typeof sessionId !== 'string' || state.executor === undefined) return null
      return await state.executor.get(sessionId)
    }
    case RW_METHODS.executorAssign: {
      const input = asRecord(params)
      const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : ''
      const mode = input['mode'] === 'local' || input['mode'] === 'server' ? input['mode'] : undefined
      if (sessionId === '' || mode === undefined || state.executor === undefined) throw new PluginError('bad-request', 'executor/assign requires sessionId and mode')
      const owner = mode === 'local' ? leaseOwner(lease) : undefined
      return await state.executor.assign(sessionId, mode, owner, (input['switchedBy'] === 'user' || input['switchedBy'] === 'default' || input['switchedBy'] === 'handoff') ? input['switchedBy'] : 'user')
    }
    case RW_METHODS.executorRelease: {
      const sessionId = asRecord(params)['sessionId']
      if (typeof sessionId !== 'string' || state.executor === undefined) throw new PluginError('bad-request', 'executor/release requires sessionId')
      return await state.executor.assign(sessionId, 'server', undefined, 'user')
    }
    case RW_METHODS.executorPlanSwitch: {
      const input = asRecord(params)
      const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : ''
      const to = input['to'] === 'local' || input['to'] === 'server' ? input['to'] : undefined
      if (sessionId === '' || to === undefined) throw new PluginError('bad-request', 'executor/plan-switch requires sessionId and to')
      const agents = (ctx.get('agents') as AgentsLike | undefined)?.list() ?? []
      const activeTurns = agents.filter(agent => agent.status === 'running').map(agent => ({ sessionId: String(agent.id), running: true, status: agent.status ?? 'running' }))
      const record = await state.executor?.get(sessionId)
      return {
        currentMode: record?.mode ?? 'server',
        to,
        restartRequired: to === 'local' ? state.managed?.unmanaged(sessionId) === true : false,
        activeTurns,
        requiresConfirmation: activeTurns.some(agent => agent.sessionId !== sessionId),
        targetTurnRunning: activeTurns.some(agent => agent.sessionId === sessionId),
      }
    }
    case RW_METHODS.executorSwitch: {
      const input = asRecord(params)
      const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : ''
      const to = input['to'] === 'local' || input['to'] === 'server' ? input['to'] : undefined
      if (sessionId === '' || to === undefined || state.managed === undefined || state.executor === undefined) throw new PluginError('bad-request', 'executor/switch requires sessionId and to')
      if (to === 'local' && input['confirmOtherTurns'] !== true) {
        const running = ((ctx.get('agents') as AgentsLike | undefined)?.list() ?? []).filter(agent => agent.status === 'running' && String(agent.id) !== sessionId)
        if (running.length > 0) throw new PluginError('executor-switch-confirm-required', 'other sessions are running; confirm before switching', { activeTurns: running.map(agent => ({ sessionId: String(agent.id), running: true, status: agent.status ?? 'running' })) })
      }
      if (to === 'server') {
        await state.executor.assign(sessionId, 'server', undefined, 'user')
        return { mode: 'server', restartRequired: false }
      }
      const result = await state.managed.releaseForSwitch(sessionId, 'local')
      return { mode: 'local', restartRequired: result.restartRequired }
    }
    default:
      throw new PluginError('internal', `method ${method} is not implemented in this Phase A skeleton`, { method })
  }
}

/** Mount the v1 profile plugin. */
export function apply(ctx: Context, config: PluginOptions = {}): void {
  const paths = resolvePaths(ctx, config)
  if (paths === undefined) {
    console.error('[dsh-remote-workspace-server] no profile context; the v1 plugin must run inside a dsh profile')
    return
  }
  const lease = new ProfileLease(paths.leaseFile, paths.profile, config.leaseHeartbeatMs ?? 5_000)
  const guardReady = Promise.withResolvers<void>()
  const guardReadyTimer = setTimeout(() => { guardReady.resolve() }, 2_000)
  guardReadyTimer.unref()
  const executor = new ExecutorStore(join(paths.home, 'remote-workspace', 'state', 'executors'))
  const approvals = new ApprovalHub()
  // QA-only marker: no file in a normal deployment, so the gate is a no-op.
  // The hub lives for the plugin fiber; each agent-scoped listener only drops
  // its own registration on agent disposal.
  ctx.effect(() => () => approvals.dispose(), 'dsh-rw: approval hub lifetime')
  const qaApprovalTool = readQaApprovalTool(join(paths.home, 'remote-workspace', paths.clientId, 'qa-approval-tool'))
  const managed = new ManagedAgents(ctx, async (sessionId, next) => { await executor.assign(sessionId, next, leaseOwner(lease), 'user') }, {
    approvals,
    approvalPreempt: qaApprovalTool !== undefined,
  })
  const sessionLogCache = new SessionLogCache()
  const persist = new PersistBridge(ctx, executor, () => leaseOwner(lease), sessionLogCache)
  const markerPath = join(paths.home, 'remote-workspace', paths.clientId, 'qa-approval-tool')
  console.error(`[dsh-remote-workspace-server] approval gate: ${qaApprovalTool === undefined ? 'off' : `qa(${qaApprovalTool})`} marker=${markerPath}`)
  const state: PluginState = { paths, pluginVersion: readPluginVersion(), titleFold: new TitleFold(ctx, sessionLogCache), managed, executor, persist, approvals, approvalGate: qaApprovalTool === undefined ? 'off' : 'qa', guardReady: guardReady.promise }
  ctx.effect(() => installQaApprovalGate(ctx, qaApprovalTool), 'dsh-rw: QA approval gate')
  ctx.effect(() => () => lease.dispose(), 'dsh-rw: lease heartbeat')
  ctx.effect(() => () => { void managed.disposeAll() }, 'dsh-rw: managed agents')
  ctx.effect(() => () => { void persist.dispose() }, 'dsh-rw: persist handles')
  // The guard needs the official registry; install it when the service exists
  // and reinstall after the loader replaces it (registry/refresh).
  // One stable guard instance survives loader disable/enable: the service
  // instance is replaced by `registry/refresh`, but the guard's loadedRevision
  // and epoch must stay authoritative (a fresh guard would reset the epoch and
  // race the post-refresh write).
  let guard: RegistryGuard | undefined
  ctx.effect(() => () => guard?.dispose(), 'dsh-rw: registry guard lifetime')
  ;(ctx as unknown as { inject(deps: string[], cb: (scope: Context) => void): unknown }).inject(['sessionController'], (scope) => {
    state.sessionController = (scope as Context).get('sessionController') as SessionControllerLike | undefined
  })
  ;(ctx as unknown as { inject(deps: string[], cb: (scope: Context) => void): unknown }).inject(['workspaceRegistry'], () => {
    guard ??= new RegistryGuard(ctx, paths.registryFile, join(paths.lockDir, 'registry'))
    const current = guard
    state.registerGuard = () => current.status()
    state.refreshRegistry = async () => await current.refresh()
    state.guardProbe = async () => await current.probe()
    state.guardReady = current.install().catch(error => { console.error(`[dsh-remote-workspace-server] registry guard install failed: ${error instanceof Error ? error.message : String(error)}`) }).finally(() => guardReady.resolve())
  })
  installRoutes(ctx, config, state, lease)
}
