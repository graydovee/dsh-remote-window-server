/**
 * Remote process ownership.
 *
 * This mirrors the official SSH helper's `RemoteProcesses` (MIT, DeepSeek
 * Harness `packages/ssh/ssh/src/helper-processes.ts`) with one substitution:
 * where the helper binds one TLS-PSK unix socket per channel and makes the
 * client attach them through OpenSSH forwarding, this server publishes the same
 * `{path, capability}` endpoint coordinates but serves each one from a logical
 * stream inside the multiplexer. The observable protocol is unchanged: a
 * prepared process publishes its channels before any target code runs, `start`
 * spawns, `done` reports the retained completion, and output collection pushes
 * `snapshot` frames on the stream's own RPC channel.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, type Duplex, type Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-subprocess'
import { SshRpcPeer } from '@deepseek-ai/dsh-ssh/protocol'
import {
  outputSnapshotFrameLimit,
  processIdSchema,
  spawnSchema,
  type SshProcessId,
} from '@deepseek-ai/dsh-ssh/schemas'
import {
  OutputCollector,
  logSpillFailure,
  prepareManagedProcessBinding,
  type SpillFailureReporter,
} from '@deepseek-ai/dsh-subprocess-local/output'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
} from '@deepseek-ai/dsh-subprocess'

/** The channels a prepared process can publish. */
export type Channel = 'stdin' | 'stdout' | 'stderr' | 'control' | 'terminal'

/**
 * One prepared channel: endpoint coordinates plus its two directions.
 *
 * `inbound` carries bytes the client sent, `outbound` carries bytes for the
 * client. Keeping them apart is what stops the server from echoing received
 * bytes back; the multiplexer's binding mirrors the official helper's
 * one-socket-per-channel wiring.
 */
export interface ProcessStream {
  readonly name: Channel
  readonly path: string
  readonly capability: string
  readonly inbound: PassThrough
  readonly outbound: PassThrough
}

/** Owns the endpoint namespace; the server root keeps every path under `hello.root`. */
export interface ProcessStreamFactory {
  create: (name: Channel, path: string, capability: string) => ProcessStream
  close: (stream: ProcessStream) => void
}

/** Wire completion: direct outcome, spill files, and retained output tails. */
export interface Completion {
  outcome: { exitCode: number | null; signal: string | null }
  spills: { stdout?: string; stderr?: string }
  collected: { stdout?: { tail: string; totalBytes: number }; stderr?: { tail: string; totalBytes: number } }
}

type Request = z.infer<typeof spawnSchema>

interface ProcessRecord {
  readonly request: Request
  readonly streams: Partial<Record<Channel, ProcessStream>>
  readonly controller: AbortController
  readonly expiry: NodeJS.Timeout
  start?: Promise<void>
  done?: Promise<Completion>
  ordinary?: SubprocessHandle
  terminal?: SubprocessTerminalHandle
  release?: Promise<void>
}

/** Resolve when a provider stream is finished, however it ended. */
function sourceFinished(source: Readable): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => { resolve() }
    source.once('end', done)
    source.once('close', done)
    source.once('error', done)
  })
}

/** Coalesce live tail updates while capture continues independently of network readers. */
class SnapshotForwarder {
  private readonly peer: SshRpcPeer
  private dirty = false
  private stopped = false
  private running: Promise<void> | undefined

  constructor(inbound: Readable, outbound: Writable, private readonly collector: OutputCollector, maxBytes: number) {
    this.peer = new SshRpcPeer(inbound, outbound, outputSnapshotFrameLimit(maxBytes), 1)
    this.peer.once('closed', () => { this.stopped = true })
  }

  offer(): void {
    if (this.stopped) return
    this.dirty = true
    if (this.running !== undefined) return
    this.running = this.flush()
  }

  private async flush(): Promise<void> {
    try {
      while (this.dirty && !this.stopped) {
        this.dirty = false
        const snapshot = this.collector.snapshot()
        await this.peer.request(
          'snapshot',
          { tail: snapshot.bytes.toString('base64'), totalBytes: snapshot.totalBytes },
          z.null(),
        )
      }
    } catch {
      this.stopped = true
      this.peer.close()
    } finally {
      this.running = undefined
    }
  }

  async finish(): Promise<void> {
    this.offer()
    while (this.running !== undefined) await this.running
    if (!this.stopped) this.peer.close()
  }
}

/** Retained completions whose ids may still be awaited by the client. */
const COMPLETION_RETAIN_FACTOR = 4

/** Owns remote launch reservations through final process-range quiescence. */
export class RemoteProcesses {
  private readonly records = new Map<SshProcessId, ProcessRecord>()
  /** Settled promises preserve the original rejection for late done requests. */
  private readonly completed = new Map<SshProcessId, Promise<Completion>>()
  private readonly cleanups = new Set<Promise<void>>()
  private closing = false
  private readonly reportSpillFailure: SpillFailureReporter

  constructor(
    private readonly ctx: Context,
    private readonly root: string,
    private readonly factory: ProcessStreamFactory,
    private readonly limit: number,
    private readonly preparationMs: number,
  ) {
    this.reportSpillFailure = logSpillFailure(ctx.logger, 'remote workspace server')
  }

  /**
   * Allocate channel endpoints; no target executes until {@link start}.
   * @param raw - untrusted process request received over the channel.
   * @returns the reservation id and its endpoint coordinates.
   */
  async prepare(raw: unknown): Promise<{ id: SshProcessId; streams: Partial<Record<Channel, { path: string; capability: string }>> }> {
    if (this.closing || this.records.size >= this.limit) throw new Error('remote process capacity unavailable')
    const request = spawnSchema.parse(raw)
    const id = randomUUID() as SshProcessId
    const directory = join(this.root, id)
    const controller = new AbortController()
    const record: ProcessRecord = {
      request,
      streams: {},
      controller,
      expiry: setTimeout(() => { void this.release(id).catch(() => {}) }, this.preparationMs),
    }
    this.records.set(id, record)
    try {
      await mkdir(directory, { mode: 0o700 })
      controller.signal.throwIfAborted()
      const names: Channel[] = request.terminal === undefined
        ? ['stdout', 'stderr', ...(request.stdio?.stdin === 'pipe' ? ['stdin' as const] : []), ...(request.stdio?.control === 'pipe' ? ['control' as const] : [])]
        : ['terminal']
      for (const name of names) {
        record.streams[name] = this.factory.create(name, join(directory, name), randomCapability())
        controller.signal.throwIfAborted()
      }
      return {
        id,
        streams: Object.fromEntries(Object.entries(record.streams).map(([name, stream]) => [
          name,
          { path: (stream as ProcessStream).path, capability: (stream as ProcessStream).capability },
        ])),
      }
    } catch (error) {
      await this.release(id)
      throw error
    }
  }

  /**
   * Start a prepared reservation. Duplicate starts refuse.
   * @param id - the prepared reservation.
   * @param signal - cancels pending publication without claiming rollback.
   * @returns the terminal pid when the request owns a PTY.
   */
  async start(id: SshProcessId, signal?: AbortSignal): Promise<{ pid?: number }> {
    const record = this.record(id)
    if (record.start !== undefined) throw new Error('remote process launch was already requested')
    signal?.throwIfAborted()
    const abort = (): void => { record.controller.abort(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
    record.start = this.startOnce(id, record)
    try {
      await record.start
    } catch (error) {
      const failed = Promise.reject<Completion>(error)
      void failed.catch(() => {})
      record.done = failed
      await this.finishFailed(id, record, failed)
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
    return record.terminal === undefined ? {} : { pid: record.terminal.pid }
  }

  private async startOnce(id: SshProcessId, record: ProcessRecord): Promise<void> {
    clearTimeout(record.expiry)
    if (this.closing) throw new Error('remote workspace server is closing')
    record.controller.signal.throwIfAborted()
    const request = record.request
    const resolved = await this.ctx.fs.resolve(request.cwd, { signal: record.controller.signal })
    const cwd = this.ctx.fs.processPath(resolved)
    record.controller.signal.throwIfAborted()
    const env: Record<string, string | undefined> = request.env === undefined
      ? {}
      : Object.fromEntries(Object.entries(request.env).map(([key, value]) => [key, value ?? undefined]))
    if (request.terminal !== undefined) {
      const terminal = await this.ctx.subprocess.spawnTerminal({
        argv: request.argv,
        cwd,
        env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        graceMs: request.graceMs,
        ...request.terminal,
        signal: record.controller.signal,
      })
      record.terminal = terminal
      record.controller.signal.throwIfAborted()
      const stream = record.streams.terminal as ProcessStream
      // A terminal channel is server-to-client only; the client half-closes its
      // writable side immediately, so draining `inbound` just releases its EOF.
      stream.inbound.resume()
      const output = pipeline(terminal.output, stream.outbound).catch(() => {})
      const done: Promise<Completion> = terminal.done.then(outcome => ({ outcome: wireOutcome(outcome), spills: {}, collected: {} }))
      record.done = done
      void done.then(async () => {
        if (request.terminal?.shellActivity === true) {
          await output
          return
        }
        await terminal.terminate()
        await output
        await this.rememberCompleted(id, record, done)
      }, () => this.finishFailed(id, record, done)).catch(() => {})
      return
    }
    const stdio = request.stdio as NonNullable<Request['stdio']>
    const spec: SubprocessSpawnSpec = {
      argv: request.argv,
      cwd,
      env,
      graceMs: request.graceMs,
      signal: record.controller.signal,
      stdio: {
        stdin: stdio.stdin,
        stdout: 'pipe',
        stderr: 'pipe',
        ...(stdio.control === undefined ? {} : { control: stdio.control }),
      },
    }
    const ordinary = this.ctx.subprocess.spawn(spec)
    record.ordinary = ordinary
    const control = ordinary.control
    if (record.streams.control !== undefined && control === undefined) {
      void ordinary.done.catch(() => {})
      throw new Error('remote subprocess provider did not establish the control channel')
    }
    const collectors: Partial<Record<'stdout' | 'stderr', OutputCollector>> = {}
    const stopCapture: Array<() => void> = []
    const forwarders: SnapshotForwarder[] = []
    const forwarded: Promise<void>[] = []
    const streams: Promise<void>[] = []
    for (const name of ['stdout', 'stderr'] as const) {
      const source = ordinary[name] as Readable
      const mode = stdio[name]
      const stream = record.streams[name] as ProcessStream
      if (typeof mode === 'object') {
        const binding = prepareManagedProcessBinding({ onSpillFailure: this.reportSpillFailure })
        const collector = new OutputCollector(mode.maxBytes, name, mode.spill === undefined ? undefined : {
          maxBytes: mode.spill.maxBytes,
          dir: binding.spillDir,
          onFailure: binding.onSpillFailure,
        })
        collectors[name] = collector
        const forwarder = new SnapshotForwarder(stream.inbound, stream.outbound, collector, mode.maxBytes)
        forwarders.push(forwarder)
        const receive = (chunk: Buffer): void => { collector.push(chunk); forwarder.offer() }
        source.on('data', receive)
        stopCapture.push(() => {
          source.off('data', receive)
          source.destroy()
          collector.seal()
        })
      } else {
        // Pipe mode is one-way: the client only reads this channel.
        stream.inbound.resume()
        // `pipeline` keeps error/cleanup behavior, but its own promise only
        // settles when the *destination* also finishes, which a channel the
        // peer keeps reading never does. Completion is therefore observed on
        // the source, so `done` does not wait for the grace timeout.
        void pipeline(source, stream.outbound).catch(() => {})
        streams.push(sourceFinished(source))
      }
    }
    if (record.streams.stdin !== undefined) {
      const stream = record.streams.stdin as ProcessStream
      void pipeline(stream.inbound, ordinary.stdin as Writable).catch(() => {})
      stream.outbound.resume()
    }
    if (record.streams.control !== undefined) {
      const duplex = control as Duplex
      const stream = record.streams.control as ProcessStream
      stream.inbound.pipe(duplex)
      duplex.pipe(stream.outbound)
      stream.inbound.on('error', () => { duplex.destroy() })
      duplex.on('error', () => { stream.inbound.destroy() })
    }
    const done: Promise<Completion> = ordinary.done.finally(() => {
      for (const stop of stopCapture) stop()
    }).then(async (outcome) => {
      for (const forwarder of forwarders) forwarded.push(forwarder.finish())
      await Promise.race([
        Promise.all(streams),
        new Promise<void>((resolve) => { const timer = setTimeout(resolve, request.graceMs); timer.unref() }),
      ])
      const spills: Completion['spills'] = {}
      const collected: Completion['collected'] = {}
      for (const name of ['stdout', 'stderr'] as const) {
        const collector = collectors[name]
        if (collector === undefined) continue
        const snapshot = collector.snapshot()
        collected[name] = { tail: snapshot.bytes.toString('base64'), totalBytes: snapshot.totalBytes }
        const path = collector.readFrom(0).spillPath
        if (path !== undefined) spills[name] = path
      }
      return { outcome: wireOutcome(outcome), spills, collected }
    })
    record.done = done
    void done.then(async () => {
      await ordinary.waitForExit()
      await Promise.all([...streams, ...forwarded])
      await this.rememberCompleted(id, record, done)
    }, () => this.finishFailed(id, record, done)).catch(() => {})
  }

  /**
   * Await the direct result without claiming descendants have exited.
   * @param id - the started reservation.
   * @returns the exit observation and retained output.
   */
  async done(id: SshProcessId): Promise<Completion> {
    const retained = this.completed.get(id)
    if (retained !== undefined) return retained
    const record = this.record(id)
    if (record.start === undefined) throw new Error('remote process has not started')
    await record.start
    return record.done as Promise<Completion>
  }

  /**
   * Observe the managed range used for termination.
   * @param id - the started reservation.
   * @param signal - cancels the observation, leaving ownership intact.
   * @returns whether the owned range is empty.
   */
  async wait(id: SshProcessId, signal?: AbortSignal): Promise<boolean> {
    if (this.completed.has(id)) return true
    const record = this.record(id)
    await record.start
    if (record.ordinary !== undefined) return record.ordinary.waitForExit(signal)
    if (record.terminal !== undefined) {
      await record.terminal.terminate()
      return true
    }
    throw new Error('remote process was not started')
  }

  /** Terminate and await the managed range independently of output readers. */
  async terminate(id: SshProcessId): Promise<void> {
    if (this.completed.has(id)) return
    const record = this.record(id)
    record.controller.abort(new Error('remote process termination requested'))
    record.ordinary?.terminate()
    if (record.ordinary !== undefined) await record.ordinary.waitForExit()
    if (record.terminal !== undefined) {
      await record.terminal.terminate()
      if (record.request.terminal?.shellActivity === true && record.done !== undefined) {
        await this.rememberCompleted(id, record, record.done)
      }
    }
    if (record.ordinary === undefined && record.terminal === undefined) await this.release(id)
  }

  /**
   * Operate on the terminal owned by one reservation.
   * @param id - the terminal reservation.
   * @param operation - input, foreground observation, or signal delivery.
   * @param value - input text or signal name.
   * @returns the operation's wire result.
   */
  async terminal(id: SshProcessId, operation: 'write' | 'inspect' | 'activity' | 'signal', value?: string): Promise<unknown> {
    const terminal = this.record(id).terminal
    if (terminal === undefined) throw new Error('remote handle does not own a terminal')
    if (operation === 'write') {
      await terminal.write(z.string().parse(value))
      return null
    }
    if (operation === 'inspect') return await terminal.inspectForeground() ?? null
    if (operation === 'activity') return await terminal.inspectActivity()
    return await terminal.signalForeground(terminalSignalSchema.parse(value))
  }

  /** Resize an allocated terminal without replacing its process. */
  async resizeTerminal(id: SshProcessId, cols: number, rows: number): Promise<void> {
    const terminal = this.record(id).terminal
    if (terminal === undefined) throw new Error('remote handle does not own a terminal')
    await terminal.resize(cols, rows)
  }

  /** Stop every owned process on lease expiry or disconnect. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const outcomes = await Promise.allSettled([
      ...[...this.records.keys()].map(id => this.release(id)),
      ...this.cleanups,
    ])
    const errors = [...new Set(outcomes.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []))]
    if (errors.length > 0) throw new AggregateError(errors, 'remote process cleanup failed')
  }

  private async release(id: SshProcessId): Promise<void> {
    const record = this.records.get(id)
    if (record === undefined) return
    record.release ??= this.trackCleanup(async () => {
      clearTimeout(record.expiry)
      record.controller.abort(new Error('remote process reservation closed'))
      await record.start?.catch(() => {})
      for (const stream of Object.values(record.streams)) this.factory.close(stream as ProcessStream)
      record.ordinary?.terminate()
      if (record.ordinary !== undefined) await record.ordinary.waitForExit()
      if (record.terminal !== undefined) await record.terminal.terminate()
      this.records.delete(id)
      await rm(join(this.root, id), { recursive: true, force: true })
    })
    await record.release
  }

  private record(id: SshProcessId): ProcessRecord {
    const record = this.records.get(id)
    if (record === undefined) throw new Error('unknown or expired remote process handle')
    return record
  }

  private async finishFailed(id: SshProcessId, record: ProcessRecord, result: Promise<Completion>): Promise<void> {
    clearTimeout(record.expiry)
    record.ordinary?.terminate()
    if (record.ordinary !== undefined) await record.ordinary.waitForExit()
    if (record.terminal !== undefined) await record.terminal.terminate()
    await this.rememberCompleted(id, record, result)
  }

  private async rememberCompleted(id: SshProcessId, record: ProcessRecord, result: Promise<Completion>): Promise<void> {
    if (this.records.get(id) !== record || record.release !== undefined) return
    const cleanup = this.trackCleanup(async () => {
      for (const stream of Object.values(record.streams)) this.factory.close(stream as ProcessStream)
      await rm(join(this.root, id), { recursive: true, force: true })
    })
    this.records.delete(id)
    this.completed.set(id, result)
    if (this.completed.size > this.limit * COMPLETION_RETAIN_FACTOR) {
      this.completed.delete(this.completed.keys().next().value as SshProcessId)
    }
    await cleanup
  }

  private trackCleanup(work: () => Promise<void>): Promise<void> {
    const pending = Promise.resolve().then(work)
    this.cleanups.add(pending)
    return pending.finally(() => { this.cleanups.delete(pending) })
  }
}

const terminalSignalSchema = z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'])

/** Re-export for the controller's terminal.signal parameter validation. */
export { terminalSignalSchema }

/** Process ids arrive as branded UUID strings. */
export { processIdSchema }

/** Convert a provider outcome into its wire shape with an exception-free signal. */
function wireOutcome(outcome: SubprocessOutcome): Completion['outcome'] {
  return { exitCode: outcome.exitCode, signal: outcome.signal === null ? null : String(outcome.signal) }
}

/** One 256-bit stream capability, hex encoded. */
function randomCapability(): string {
  return randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
}

/** Signals that terminate a process range, for type completeness. */
export type { SubprocessTerminalSignal }
