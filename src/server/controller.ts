/**
 * The remote execution-world server.
 *
 * It answers the official SSH helper's method set (see
 * `packages/ssh/ssh/src/helper.ts`, MIT, DeepSeek Harness) over this plugin's
 * multiplexed channel, translating every method into calls on the providers
 * already mounted in the remote profile (`ctx.fs`, `ctx.subprocess`,
 * `ctx.sandbox`) instead of building its own. That is the point of running a
 * *profile* on the remote rather than uploading a helper: the execution world is
 * the same official provider set, so the local client reuses the official SSH
 * providers unchanged.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import { SshRpcPeer, SSH_PROTOCOL_VERSION } from '@deepseek-ai/dsh-ssh/protocol'
import {
  editResultSchema,
  editSchema,
  entriesSchema,
  environmentSchema,
  helloSchema,
  intentSchema,
  policySchema,
  processIdSchema,
  targetSchema,
  textStreamIdSchema,
  writeResultSchema,
} from '@deepseek-ai/dsh-ssh/schemas'
import { DEFAULT_MAX_FRAME_BYTES } from '../frame/codec.ts'
import { FrameMux, streamTransport } from '../frame/mux.ts'
import { capabilityMatches } from '../frame/psk.ts'
import { RemoteProcesses, terminalSignalSchema, type Channel, type ProcessStream } from './processes.ts'
import { RemoteSessionStore } from './session-store.ts'
import { REMOTE_SESSION_PROTOCOL, type RemoteHandleId, type RemoteSessionId, type WorkspaceId } from '../protocol.ts'

/** The official helper's whole-text and read ceilings, re-applied on this side. */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024

/** Concurrent text iterators owned by one server. */
export const MAX_TEXT_STREAMS = 128

/** Ordinary in-flight requests; management methods have reserved capacity in `SshRpcPeer`. */
const MAX_PENDING = 128

/** How long a prepared reservation may wait for `process.start`. */
const PREPARATION_MS = 30_000

const object = z.object({}).strict()
/** Admit a wire target as a filesystem identity; spelling is re-canonicalized remotely. */
const asTarget = (raw: unknown): FsTarget => targetSchema.parse(raw) as FsTarget
/** The same admission as a request field, so every parsed target is already branded. */
const targetField = targetSchema.transform((value): FsTarget => value as FsTarget)
/** Guarded-write intents carry the observed version the remote provider compares. */
const intentField = intentSchema.transform((value): FsWriteIntent => value as FsWriteIntent)
/** The observed version an edit expects, branded for the provider. */
const versionField = z.object({ version: z.string() }).strict().transform((value): { version: FsVersion } => value as { version: FsVersion })
const processIdRequest = z.object({ id: processIdSchema }).strict()
const streamIdRequest = z.object({ id: textStreamIdSchema }).strict()
const pathRequest = z.object({ path: z.string(), cwd: z.string().startsWith('/').optional() }).strict()
const targetRequest = z.object({ target: targetField }).strict()
const writeRequest = z.object({
  target: targetField,
  content: z.string(),
  expected: intentField.optional(),
  policy: policySchema,
}).strict()
const editRequest = z.object({
  target: targetField,
  edit: editSchema,
  expected: versionField.optional(),
  policy: policySchema,
}).strict()
const readBytesRequest = z.object({ target: targetField, maxBytes: z.number().int().positive() }).strict()
const readRangeRequest = z.object({
  target: targetField,
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
}).strict()
const executableRequest = z.object({ command: z.string(), env: environmentSchema.optional() }).strict()
const sandboxRequest = z.object({ argv: z.array(z.string()).min(1), policy: policySchema }).strict()
const resizeRequest = z.object({ id: processIdSchema, cols: z.number().int().positive(), rows: z.number().int().positive() }).strict()
const terminalOperation = z.object({ id: processIdSchema, value: z.string().optional() }).strict()
const helloRequest = z.object({
  protocol: z.literal(SSH_PROTOCOL_VERSION),
  workspace: z.string().startsWith('/'),
  leaseMs: z.number().int().min(3000).max(600_000),
  bootstrapPath: z.string().startsWith('/').optional(),
}).strict()
const endpointSchema = z.object({ path: z.string(), capability: z.string().regex(/^[0-9a-f]{64}$/) }).strict()
const remoteHelloRequest = z.object({ protocol: z.literal(REMOTE_SESSION_PROTOCOL), clientVersion: z.string().min(1) }).strict()
const workspaceId = z.string().length(16).transform(value => value as WorkspaceId)
const sessionId = z.string().min(1).transform(value => value as RemoteSessionId)
const handleId = z.string().min(1).transform(value => value as RemoteHandleId)
const remoteWorkspaceRequest = z.object({ workspaceId }).strict()
const remoteCreateWorkspaceRequest = z.object({ path: z.string().startsWith('/'), title: z.string().min(1).optional() }).strict()
const remoteSessionListRequest = z.object({ workspaceId }).strict()
const remoteSessionCreateRequest = z.object({ workspaceId, header: z.record(z.string(), z.unknown()) }).strict()
const remoteSessionOpenRequest = z.object({ workspaceId, sessionId, mode: z.enum(['read', 'write']) }).strict()
const remoteSessionAppendRequest = z.object({ handleId: handleId, events: z.array(z.record(z.string(), z.unknown())) }).strict()
const remoteSessionHandleRequest = z.object({ handleId }).strict()

/** Options for one remote execution-world server. */
export interface RemoteServerOptions {
  /** The remote profile's service context. */
  readonly ctx: Context
  /** Protocol input (the transport's readable half). */
  readonly input: Readable
  /** Protocol output (the transport's writable half). */
  readonly output: Writable
  /** Host-visible workspace spelling used when the client does not name one. */
  readonly workspace: string
  /** Server-side request lease; refreshed by `heartbeat`. */
  readonly leaseMs?: number
  /** Maximum prepared or running process handles. */
  readonly maxProcesses?: number
  /** Installed entry whose digest the client verifies; defaults to this module. */
  readonly entryPath?: string
  /** Called after a `close` request has been answered, so a dedicated host can exit. */
  readonly onClose?: () => void
  /** Optional official persistence adapter for Remote Session RPCs. */
  readonly sessionStore?: RemoteSessionStore
  /** Stable identity advertised by the server plugin. */
  readonly serverId?: string
  readonly installationId?: string
  readonly version?: string
}

/** Server half of the remote-workspace channel. */
export class RemoteExecutionServer {
  private readonly mux: FrameMux
  private readonly peer: SshRpcPeer
  private readonly streams = new Map<string, ProcessStream>()
  private readonly iterators = new Map<string, { iterator: AsyncIterator<string>; controller: AbortController }>()
  private readonly lifetime = new AbortController()
  private processes: RemoteProcesses | undefined
  private lease: NodeJS.Timeout | undefined
  /** Holds the host process open while this server is serving. */
  private keepAlive: NodeJS.Timeout | undefined
  private leaseMs: number
  private root = ''
  private initialized = false
  private cleanup: Promise<void> | undefined
  private workspace: string
  private hostDigest: string | undefined

  constructor(private readonly options: RemoteServerOptions) {
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      throw new Error('the remote workspace server requires a POSIX host')
    }
    this.workspace = options.workspace
    this.leaseMs = options.leaseMs ?? 30_000
    // The host bootstrapper unrefs stdin and every timer it owns, so an idle
    // event loop would end a dedicated server profile mid-session. This server
    // owns its process lifetime instead.
    this.keepAlive = setInterval(() => {}, 1 << 30)
    this.mux = new FrameMux({
      transport: streamTransport(options.input, options.output),
      role: 'server',
      accept: endpoint => this.accept(endpoint),
      label: 'remote-workspace-server',
    })
    this.peer = new SshRpcPeer(
      this.mux.jsonInput(),
      this.mux.jsonOutput(),
      DEFAULT_MAX_FRAME_BYTES,
      MAX_PENDING,
      (method, params, signal) => this.dispatch(method, params, signal),
    )
  }

  /** Resolve once the server root exists; every method awaits it. */
  get ready(): Promise<void> {
    return this.started
  }

  private readonly started: Promise<void> = (async (): Promise<void> => {
    this.root = await mkdtemp(join(tmpdir(), 'dsh-remote-'))
    this.processes = new RemoteProcesses(
      this.options.ctx,
      this.root,
      {
        create: (name, path, capability) => this.createStream(name, path, capability),
        close: (stream) => this.closeStream(stream),
      },
      this.options.maxProcesses ?? 128,
      PREPARATION_MS,
    )
  })()

  /**
   * Attach one published endpoint to its logical stream.
   * @param endpoint - untrusted `{path, capability}` from the client.
   * @returns the directional binding for that stream, or `undefined` for a refusal.
   */
  private accept(endpoint: unknown): { inbound: PassThrough; outbound: PassThrough } | undefined {
    const parsed = endpointSchema.safeParse(endpoint)
    if (!parsed.success) return undefined
    const stream = this.streams.get(parsed.data.path)
    if (stream === undefined) return undefined
    if (!capabilityMatches(stream.capability, parsed.data.capability)) return undefined
    this.streams.delete(parsed.data.path)
    return { inbound: stream.inbound, outbound: stream.outbound }
  }

  private createStream(name: Channel, path: string, capability: string): ProcessStream {
    const stream: ProcessStream = { name, path, capability, inbound: new PassThrough(), outbound: new PassThrough() }
    stream.inbound.on('error', () => {})
    stream.outbound.on('error', () => {})
    this.streams.set(path, stream)
    return stream
  }

  private closeStream(stream: ProcessStream): void {
    this.streams.delete(stream.path)
    if (!stream.inbound.destroyed) stream.inbound.destroy()
    if (!stream.outbound.destroyed) stream.outbound.destroy()
  }

  /** Release every stream, process and text iterator, then close the channel. */
  dispose(): Promise<void> {
    this.cleanup ??= this.release().finally(() => {
      // The keep-alive is released only here, after the channel is closed: a
      // `close` request must still be answered while its handler runs.
      if (this.keepAlive !== undefined) clearInterval(this.keepAlive)
      this.peer.close()
      this.mux.close()
    })
    return this.cleanup
  }

  /**
   * Release owned resources while keeping the channel able to answer.
   *
   * A `close` request must be *answered* — the peer that asked for it is still
   * listening — so the handler releases first and lets the transport close
   * afterwards, either through the client or through the dedicated host's exit.
   */
  private release(): Promise<void> {
    return (async () => {
      if (this.lease !== undefined) clearTimeout(this.lease)
      this.lifetime.abort(new Error('remote workspace server is closing'))
      for (const record of this.iterators.values()) record.controller.abort(this.lifetime.signal.reason)
      await Promise.allSettled([...this.iterators.values()].map(async record => record.iterator.return?.()))
      this.iterators.clear()
      for (const stream of [...this.streams.values()]) this.closeStream(stream)
      await this.started.catch(() => {})
      try {
        await this.processes?.close()
      } finally {
        await this.options.sessionStore?.dispose()
        await rm(this.root, { recursive: true, force: true })
      }
    })()
  }

  private touchLease(): void {
    if (this.lease !== undefined) clearTimeout(this.lease)
    this.lease = setTimeout(() => { void this.dispose().catch(() => {}) }, this.leaseMs)
    this.lease.unref()
  }

  /** Resolve a policy's workspace root on this host before the provider sees it. */
  private async resolvePolicy(
    raw: unknown,
    signal: AbortSignal,
  ): Promise<{ mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string; sessionId?: string }> {
    const parsed = policySchema.parse(raw)
    const target = await this.options.ctx.fs.resolve(parsed.workspaceRoot, { signal })
    return { ...parsed, workspaceRoot: this.options.ctx.fs.processPath(target) }
  }

  private async dispatch(method: string, raw: unknown, requestSignal: AbortSignal): Promise<unknown> {
    if (process.env.DSH_RW_DEBUG) console.error('[srv] dispatch', method)
    const { ctx } = this.options
    const signal = AbortSignal.any([requestSignal, this.lifetime.signal])
    if (method === 'hello') {
      const input = helloRequest.parse(raw)
      await this.started
      // The remote server is a persistent singleton (ZCode parity: no idle
      // exit), so a *second* realm connection — e.g. the agent loop escalating
      // the sandbox policy and re-running the SSH handshake — must be served
      // the same hello, not rejected: the official helper sends one hello per
      // connection and cannot recover past this point.
      if (!this.initialized) {
        const resolved = await ctx.fs.resolve(input.workspace, { signal })
        this.workspace = ctx.fs.processPath(resolved)
        this.leaseMs = input.leaseMs
        this.initialized = true
      }
      const entryPath = this.options.entryPath ?? fileURLToPath(import.meta.url)
      this.hostDigest = createHash('sha256').update(await readFile(entryPath)).digest('hex')
      this.touchLease()
      return helloSchema.parse({
        protocol: SSH_PROTOCOL_VERSION,
        hash: this.hostDigest,
        platform: process.platform,
        nodeVersion: process.version,
        node: process.execPath,
        root: this.root,
        workspace: this.workspace,
        ...(input.bootstrapPath === undefined
          ? {}
          : { bootstrapHash: createHash('sha256').update(await readFile(input.bootstrapPath)).digest('hex') }),
      })
    }
    if (method === 'server.hello') {
      const input = remoteHelloRequest.parse(raw)
      if (input.protocol !== REMOTE_SESSION_PROTOCOL) throw new Error(`unsupported remote session protocol ${input.protocol}`)
      await this.started
      this.initialized = true
      this.touchLease()
      return {
        protocol: REMOTE_SESSION_PROTOCOL,
        serverId: this.options.serverId ?? 'ephemeral',
        installationId: this.options.installationId ?? 'stdio',
        version: this.options.version ?? '0.4.0-dev',
        workspacesRoot: this.workspace,
      }
    }
    await this.started
    if (!this.initialized || this.cleanup !== undefined) throw new Error('remote workspace server is not accepting operations')
    const processes = this.processes as RemoteProcesses
    if (method === 'heartbeat') {
      object.parse(raw)
      this.touchLease()
      return null
    }
    if (method === 'close') {
      if (process.env.DSH_RW_DEBUG) console.error('[srv] close handler enter')
      object.parse(raw)
      await this.release()
      // The result frame is written as soon as this handler resolves, so the
      // dedicated host's exit is deferred until after it has flushed.
      if (process.env.DSH_RW_DEBUG) console.error('[srv] close released, replying')
      this.options.onClose?.()
      return null
    }
    const sessions = this.options.sessionStore
    if (method === 'reg.list') {
      if (sessions === undefined) throw new Error('remote session persistence is not configured')
      object.parse(raw)
      return await sessions.listWorkspaces()
    }
    if (method === 'reg.create') {
      if (sessions === undefined) throw new Error('remote session persistence is not configured')
      const input = remoteCreateWorkspaceRequest.parse(raw)
      return await sessions.createWorkspace(input.path, input.title)
    }
    if (method === 'persist.list') {
      if (sessions === undefined) throw new Error('remote session persistence is not configured')
      return await sessions.listSessions(remoteSessionListRequest.parse(raw).workspaceId)
    }
    if (method === 'persist.create') {
      if (sessions === undefined) throw new Error('remote session persistence is not configured')
      const input = remoteSessionCreateRequest.parse(raw)
      return await sessions.createSession(input.workspaceId, input.header as never)
    }
    if (method === 'persist.open') {
      if (sessions === undefined) throw new Error('remote session persistence is not configured')
      const input = remoteSessionOpenRequest.parse(raw)
      return await sessions.openSession(input.workspaceId, input.sessionId, input.mode)
    }
    if (method === 'persist.append') {
      if (sessions === undefined) throw new Error('remote session persistence is not configured')
      const input = remoteSessionAppendRequest.parse(raw)
      await sessions.append(input.handleId, input.events as never)
      return null
    }
    if (method === 'persist.flush') {
      if (sessions === undefined) throw new Error('remote session persistence is not configured')
      await sessions.flush(remoteSessionHandleRequest.parse(raw).handleId)
      return null
    }
    if (method === 'persist.close') {
      if (sessions === undefined) throw new Error('remote session persistence is not configured')
      await sessions.close(remoteSessionHandleRequest.parse(raw).handleId)
      return null
    }
    if (method === 'process.prepare') return processes.prepare(raw)
    if (method === 'process.start') return processes.start(processIdRequest.parse(raw).id, signal)
    if (method === 'process.done') return processes.done(processIdRequest.parse(raw).id)
    if (method === 'process.wait') return processes.wait(processIdRequest.parse(raw).id, signal)
    if (method === 'process.terminate') {
      await processes.terminate(processIdRequest.parse(raw).id)
      return null
    }
    if (method === 'terminal.environment') {
      object.parse(raw)
      return ctx.subprocess.terminalEnvironment(signal)
    }
    if (method === 'terminal.resize') {
      const input = resizeRequest.parse(raw)
      await processes.resizeTerminal(input.id, input.cols, input.rows)
      return null
    }
    if (method === 'terminal.write' || method === 'terminal.inspect' || method === 'terminal.activity' || method === 'terminal.signal') {
      const input = terminalOperation.parse(raw)
      const operation = method === 'terminal.write' ? 'write' : method === 'terminal.inspect' ? 'inspect' : method === 'terminal.activity' ? 'activity' : 'signal'
      if (operation === 'signal') terminalSignalSchema.parse(input.value)
      return processes.terminal(input.id, operation, input.value)
    }
    if (method === 'executable') {
      const input = executableRequest.parse(raw)
      const env = input.env === undefined
        ? undefined
        : Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== null))
      try {
        return await ctx.subprocess.resolveExecutable(input.command, env, signal)
      } catch (error) {
        if ((error as { name?: string }).name === 'SubprocessExecutableNotFoundError') {
          throw codedError(error, 'SUBPROCESS_EXECUTABLE_NOT_FOUND')
        }
        throw error
      }
    }
    if (method === 'sandbox') {
      const input = sandboxRequest.parse(raw)
      const resolved = await this.resolvePolicy(input.policy, signal)
      if (resolved.mode === 'danger-full-access') throw new Error('unconfined argv does not need a sandbox wrapper')
      return await ctx.sandbox.confine(input.argv, resolved as Parameters<typeof ctx.sandbox.confine>[1], signal)
    }
    if (method === 'fs.resolve' || method === 'fs.lstat') {
      const input = pathRequest.parse(raw)
      const cwd = input.cwd ?? this.workspace
      return method === 'fs.resolve'
        ? await ctx.fs.resolve(input.path, { cwd, signal })
        : await ctx.fs.lstat(input.path, { cwd }, signal) ?? null
    }
    if (method === 'fs.stat' || method === 'fs.list' || method === 'fs.readText' || method === 'fs.stream') {
      const target = asTarget(targetRequest.parse(raw).target)
      if (method === 'fs.stat') return await ctx.fs.stat(target, signal) ?? null
      if (method === 'fs.list') return entriesSchema.parse(await ctx.fs.listDir(target, signal))
      if (method === 'fs.stream') return await this.openTextStream(target, signal)
      return await this.readWholeText(target, signal)
    }
    if (method === 'fs.next') {
      const id = streamIdRequest.parse(raw).id
      const record = this.iterators.get(id)
      if (record === undefined) throw new Error('unknown remote text stream')
      const next = await record.iterator.next()
      return { done: next.done === true, value: typeof next.value === 'string' ? next.value : '' }
    }
    if (method === 'fs.streamClose') {
      const id = streamIdRequest.parse(raw).id
      const record = this.iterators.get(id)
      if (record !== undefined) {
        this.iterators.delete(id)
        record.controller.abort(new Error('remote text stream closed'))
        await record.iterator.return?.().catch(() => {})
      }
      return null
    }
    if (method === 'fs.readBytes') {
      const input = readBytesRequest.parse(raw)
      const bytes = await ctx.fs.readBytes(input.target, signal, Math.min(input.maxBytes, MAX_TEXT_BYTES))
      return Buffer.from(bytes).toString('base64')
    }
    if (method === 'fs.readRange') {
      const input = readRangeRequest.parse(raw)
      if (input.length > MAX_TEXT_BYTES) throw codedError(new Error('remote read range exceeds the byte ceiling'), 'FS_TOO_LARGE')
      const bytes = await ctx.fs.readByteRange(input.target, { offset: input.offset, length: input.length }, signal)
      return Buffer.from(bytes).toString('base64')
    }
    if (method === 'fs.write') {
      const input = writeRequest.parse(raw)
      const resolved = await this.resolvePolicy(input.policy, signal)
      return writeResultSchema.parse(await ctx.fs.writeText(
        input.target,
        input.content,
        input.expected,
        signal,
        resolved as Parameters<typeof ctx.fs.writeText>[4],
      ))
    }
    if (method === 'fs.edit') {
      const input = editRequest.parse(raw)
      const resolved = await this.resolvePolicy(input.policy, signal)
      return editResultSchema.parse(await ctx.fs.editText(
        input.target,
        input.edit,
        input.expected,
        signal,
        resolved as Parameters<typeof ctx.fs.editText>[4],
      ))
    }
    throw new Error(`unknown remote workspace operation "${method}"`)
  }

  /** Whole-text reads go through the iterator API so the byte ceiling is enforced remotely. */
  private async readWholeText(target: FsTarget, signal: AbortSignal): Promise<string> {
    const iterator = await this.options.ctx.fs.streamText(target, signal) as AsyncIterable<string> & Partial<AsyncIterator<string>>
    let total = 0
    let text = ''
    try {
      for await (const chunk of iterator) {
        total += Buffer.byteLength(chunk, 'utf8')
        if (total > MAX_TEXT_BYTES) throw codedError(new Error(`remote text exceeds ${MAX_TEXT_BYTES} bytes`), 'FS_TOO_LARGE')
        text += chunk
      }
    } finally {
      await iterator.return?.().catch(() => {})
    }
    return text
  }

  /** Register an iterator before returning its id, so the first `fs.next` cannot race. */
  private async openTextStream(target: FsTarget, signal: AbortSignal): Promise<string> {
    if (this.iterators.size >= MAX_TEXT_STREAMS) throw new Error('remote text stream limit reached')
    const controller = new AbortController()
    const iterator = await this.options.ctx.fs.streamText(target, AbortSignal.any([signal, controller.signal])) as unknown as AsyncIterator<string>
    const id = randomUUID()
    this.iterators.set(id, { iterator, controller })
    return id
  }
}

/** Attach a machine-readable code without depending on a provider error class. */
function codedError(error: unknown, code: string): Error {
  const detail = error instanceof Error ? error : new Error(String(error))
  Object.defineProperty(detail, 'code', { value: code, enumerable: true, configurable: true })
  return detail
}
