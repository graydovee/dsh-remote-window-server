/**
 * Logical stream multiplexer.
 *
 * One transport (an `ssh2` exec channel's stdin/stdout pair, a child process's
 * stdio, or a unix socket) carries:
 *
 * - opaque RPC bytes through {@link FrameMux.json}, re-framed as `json` frames
 *   and handed to `@deepseek-ai/dsh-ssh/protocol`'s `SshRpcPeer` unchanged, and
 *   streams over `stream-open`/`stream-data`/half-close frames
 *   ({@link FrameMux.open} client-side, `accept` server-side).
 *
 * Flow control is a per-stream byte window: the receiver credits bytes as its
 * consumer actually pulls them, so a slow reader (say a process writing 200 MB
 * to stdout while the model reads a snapshot) throttles that single stream
 * instead of growing host memory or stalling the RPC channel.
 */
import { Duplex, PassThrough, type Readable, type Writable } from 'node:stream'
import {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_STREAM_CHUNK_BYTES,
  END_DIRECTION,
  FRAME_ABORT,
  FRAME_CREDIT,
  FRAME_DATA,
  FRAME_END,
  FRAME_JSON,
  FRAME_OPEN,
  FRAME_OPEN_FAIL,
  FRAME_OPEN_OK,
  FrameDecoder,
  FrameError,
  MAX_STREAM_ID,
  encodeAbortFrame,
  encodeCreditFrame,
  encodeDataFrame,
  encodeEndFrame,
  encodeJsonFrame,
  encodeOpenFailFrame,
  encodeOpenFrame,
  encodeOpenOkFrame,
  type Frame,
} from './codec.ts'

/** Both ends must use the same per-stream receive window; it is part of the wire contract. */
export const STREAM_WINDOW_BYTES = 1024 * 1024

/** How many transport bytes one logical stream may push before yielding to other streams. */
export const STREAM_CHUNK_BYTES = DEFAULT_STREAM_CHUNK_BYTES

/** One logical stream: writable half sends data, readable half receives it. */
class MuxChannel extends Duplex {
  constructor(
    private readonly mux: FrameMux,
    readonly id: number,
  ) {
    // `autoDestroy` would destroy the channel as soon as one direction ends,
    // which is exactly what a half-close must not do: the peer still has to
    // receive the rest of the stream. Lifecycle is owned by `reap`.
    super({ allowHalfOpen: true, autoDestroy: false, emitClose: true })
  }

  override _read(): void {
    this.mux.pullCredit(this.id)
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.mux.writeChannel(this.id, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.mux.endChannel(this.id)
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.mux.destroyChannel(this.id, error)
    callback(error)
  }
}

/**
 * How a served stream is wired, described per direction.
 *
 * The two halves are distinct objects on purpose: a single duplex used for both
 * directions makes the server's own "bytes arrived from the client" handler emit
 * them straight back to the client. Every served stream is therefore described
 * as the sink for client bytes plus the source of bytes for the client, exactly
 * like the official helper's one-socket-per-channel wiring.
 */
export interface ChannelBinding {
  /** Client bytes, in arrival order. */
  readonly inbound: Writable
  /** Bytes for the client; ending it half-closes the client's readable half. */
  readonly outbound: Readable
}

interface ChannelState {
  readonly id: number
  readonly channel: MuxChannel
  /** Bytes this side may still send without waiting for credit. */
  sendWindow: number
  /** The single in-flight write Node has not completed yet. */
  waiting: { readonly bytes: Buffer; readonly done: (error?: Error | null) => void } | undefined
  /** Bytes pushed into the readable half since the last credit frame. */
  pendingCredit: number
  /** The consumer's buffer is full; withholding credit applies backpressure. */
  blocked: boolean
  /** Terminal state per direction. */
  sentEnd: boolean
  receivedEnd: boolean
  settled: boolean
}

/** How the mux is wired; `accept` is required for the server role. */
export interface FrameMuxOptions {
  readonly transport: MuxTransport
  readonly role: 'client' | 'server'
  /** Server role: resolve an incoming `stream-open` to the stream that serves it. */
  readonly accept?: (endpoint: unknown, id: number) => ChannelBinding | undefined | Promise<ChannelBinding | undefined>
  readonly maxFrameBytes?: number
  readonly windowBytes?: number
  /** Diagnostics label; never includes credentials. */
  readonly label?: string
}

/**
 * The byte conduit the multiplexer needs.
 *
 * Deliberately not a `Duplex`: `Duplex.from` wires stream-finished machinery
 * whose "premature close" bookkeeping is exactly what a transport shared with a
 * child process's stdio must not fight. A transport is a write sink plus an
 * event source, nothing more.
 */
export interface MuxTransport {
  /** Queue one frame; delivery order is the caller's responsibility. */
  write(frame: Buffer): void
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'end', listener: () => void): unknown
  /** Stop reading and stop accepting writes. */
  destroy(): void
}

/**
 * Adapt a readable/writable pair into a transport.
 *
 * Errors are contained here — a closing peer's EPIPE is a close, not a crash —
 * and `destroy` stops reading and half-closes the writable side, so a shared
 * stdout is never destroyed outright.
 */
export function streamTransport(input: Readable, output: Writable): MuxTransport {
  input.on('error', () => {})
  output.on('error', () => {})
  let destroyed = false
  return {
    write: (frame) => {
      if (destroyed) return
      try {
        output.write(frame)
      } catch {
        destroyed = true
      }
    },
    on: (event, listener) => {
      if (event === 'data' || event === 'close' || event === 'end') input.on(event, listener as never)
      else output.on('error', listener)
    },
    destroy: () => {
      destroyed = true
      if (!input.destroyed) input.destroy()
      if (!output.destroyed && !output.writableEnded) output.end()
    },
  }
}

/** Multiplexes logical streams and opaque RPC bytes over one transport. */
export class FrameMux {
  private readonly decoder: FrameDecoder
  private readonly channels = new Map<number, ChannelState>()
  private readonly pendingAccepts = new Set<Promise<void>>()
  private readonly jsonChannel: PassThrough
  private readonly jsonPump: PassThrough
  private readonly settled: Promise<Error | undefined>
  private settle: (error: Error | undefined) => void = () => {}
  private nextId = 1
  private failure: Error | undefined
  private closing = false

  constructor(private readonly options: FrameMuxOptions) {
    if (options.role === 'server' && options.accept === undefined) {
      throw new Error('a server-role mux requires an accept hook')
    }
    this.decoder = new FrameDecoder(options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES)
    this.settled = new Promise<Error | undefined>((resolve) => { this.settle = resolve })
    // Opaque RPC bytes: the caller's `SshRpcPeer` owns length-prefixed JSON
    // framing, so this side only moves bytes and never parses them.
    this.jsonPump = new PassThrough({ highWaterMark: 64 * 1024 })
    this.jsonChannel = new PassThrough({ highWaterMark: 64 * 1024 })
    this.jsonPump.on('data', (chunk: Buffer) => { this.sendJson(chunk) })
    this.jsonPump.on('error', (error: Error) => { this.close(error) })
    this.jsonChannel.on('error', () => {})
    options.transport.on('data', (chunk: Buffer) => { this.receive(chunk) })
    options.transport.on('error', (error: Error) => { this.close(error) })
    options.transport.on('close', () => {
      this.close(this.failure ?? new Error('remote workspace transport closed'))
    })
    options.transport.on('end', () => { this.close(new Error('remote workspace transport ended')) })
  }

  /** RPC bytes arriving from the peer; hand this to `SshRpcPeer` as its input. */
  jsonInput(): Readable {
    return this.jsonChannel
  }

  /** Writable that carries this side's RPC frames to the peer. */
  jsonOutput(): Writable {
    return this.jsonPump
  }

  /** Resolves once the transport failed or closed; `undefined` after a clean close. */
  get closed(): Promise<Error | undefined> {
    return this.settled
  }

  get openStreams(): number {
    return this.channels.size
  }

  /**
   * Attach a stream and wait for the peer to accept it.
   * @param endpoint - peer-interpreted coordinates (the remote server maps the path to its stream).
   * @param signal - cancels the attempt; a late acceptance is destroyed.
   * @returns the attached duplex.
   */
  async open(endpoint: unknown, signal?: AbortSignal): Promise<Duplex> {
    if (this.failure !== undefined) throw this.failure
    if (this.options.role !== 'client') throw new Error('only a client-role mux opens streams')
    signal?.throwIfAborted()
    const id = this.allocateId()
    const channel = new MuxChannel(this, id)
    const state = this.createState(id, channel)
    const ok = Promise.withResolvers<void>()
    this.accepts.set(id, ok)
    const abort = (): void => {
      this.accepts.delete(id)
      this.send(encodeAbortFrame(id, 'stream allocation cancelled'))
      this.removeState(state, new Error('stream allocation cancelled'))
      ok.reject(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason)))
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      this.send(encodeOpenFrame(id, endpoint))
      await ok.promise
      return channel
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  /** Close the transport and fail every stream and pending open. */
  close(reason?: Error): void {
    if (process.env.DSH_RW_DEBUG) console.error('[mux] CLOSE role=', this.options.role, 'reason=', reason?.message)
    if (this.failure !== undefined) return
    const error = reason ?? new Error('remote workspace channel closed')
    this.failure = error
    this.closing = true
    for (const pending of this.accepts.values()) pending.reject(error)
    this.accepts.clear()
    for (const state of [...this.channels.values()]) this.removeState(state, error)
    this.jsonPump.destroy()
    this.jsonChannel.destroy()
    this.options.transport.destroy()
    this.settle(reason)
  }

  /** Await outstanding server-side accept hooks (tests and orderly shutdown). */
  async quiesce(): Promise<void> {
    while (this.pendingAccepts.size > 0) await Promise.allSettled([...this.pendingAccepts])
  }

  // ── channel callbacks (called by MuxChannel) ─────────────────────────────

  /** @internal */
  writeChannel(id: number, bytes: Buffer, done: (error?: Error | null) => void): void {
    const state = this.channels.get(id)
    if (state === undefined) {
      done(new Error('stream is no longer open'))
      return
    }
    state.waiting = { bytes, done }
    this.pump(state)
  }

  /** @internal */
  endChannel(id: number): void {
    const state = this.channels.get(id)
    if (state === undefined || state.sentEnd) return
    state.sentEnd = true
    this.send(encodeEndFrame(id, END_DIRECTION.inbound))
    this.reap(state)
  }

  /** @internal */
  destroyChannel(id: number, error: Error | null): void {
    const state = this.channels.get(id)
    if (state === undefined) return
    if (!state.sentEnd) this.send(encodeAbortFrame(id, error?.message ?? 'stream destroyed'))
    this.removeState(state, error ?? undefined)
  }

  /** @internal */
  pullCredit(id: number): void {
    const state = this.channels.get(id)
    if (state === undefined) return
    state.blocked = false
    this.offerCredit(state)
  }

  // ── internals ────────────────────────────────────────────────────────────

  private readonly accepts = new Map<number, PromiseWithResolvers<void>>()

  private allocateId(): number {
    for (let attempt = 0; attempt <= MAX_STREAM_ID; attempt++) {
      const id = this.nextId
      this.nextId = this.nextId >= MAX_STREAM_ID ? 1 : this.nextId + 1
      if (!this.channels.has(id) && !this.accepts.has(id)) return id
    }
    throw new Error('no stream ids remain')
  }

  private createState(id: number, channel: MuxChannel): ChannelState {
    const state: ChannelState = {
      id, channel,
      sendWindow: this.options.windowBytes ?? STREAM_WINDOW_BYTES,
      waiting: undefined,
      pendingCredit: 0,
      blocked: false,
      sentEnd: false,
      receivedEnd: false,
      settled: false,
    }
    channel.on('error', () => {})
    this.channels.set(id, state)
    return state
  }

  private removeState(state: ChannelState, error?: Error): void {
    if (state.settled) return
    state.settled = true
    this.channels.delete(state.id)
    if (state.waiting !== undefined) {
      const { done } = state.waiting
      state.waiting = undefined
      done(error ?? new Error('stream closed before the write completed'))
    }
    if (!state.channel.destroyed) state.channel.destroy(error)
  }

  /** Drop the channel once both halves are done. */
  private reap(state: ChannelState): void {
    if (!state.receivedEnd || !state.channel.writableEnded) return
    if (!state.channel.destroyed) state.channel.destroy()
    this.channels.delete(state.id)
  }

  private send(frame: Buffer): void {
    if (process.env.DSH_RW_DEBUG && frame.readUInt8(0) === 0) console.error('[mux] SEND json role=', this.options.role, 'len=', frame.length)
    if (this.failure !== undefined) return
    try {
      this.options.transport.write(frame)
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private sendJson(bytes: Buffer): void {
    for (let offset = 0; offset < bytes.length; offset += STREAM_CHUNK_BYTES) {
      this.send(encodeJsonFrame(bytes.subarray(offset, Math.min(bytes.length, offset + STREAM_CHUNK_BYTES))))
    }
  }

  private pump(state: ChannelState): void {
    const waiting = state.waiting
    if (waiting === undefined || state.settled) return
    if (state.sendWindow <= 0) return
    const size = Math.min(waiting.bytes.length, state.sendWindow, STREAM_CHUNK_BYTES)
    const chunk = waiting.bytes.subarray(0, size)
    const rest = waiting.bytes.subarray(size)
    state.sendWindow -= size
    // Retire the pending write *before* sending: on an in-memory transport the
    // peer receives the frame synchronously and its credit re-enters `pump`
    // from inside `send`, which would resend the chunk while `waiting` is set.
    // The write callback completes once the frame is queued.
    state.waiting = rest.length === 0 ? undefined : { bytes: rest, done: waiting.done }
    this.send(encodeDataFrame(state.id, chunk))
    if (rest.length === 0) waiting.done()
  }

  private offerCredit(state: ChannelState): void {
    if (state.blocked || state.pendingCredit === 0) return
    const credit = state.pendingCredit
    state.pendingCredit = 0
    this.send(encodeCreditFrame(state.id, credit))
  }

  private receive(chunk: Buffer): void {
    let frames: Frame[]
    try {
      frames = this.decoder.push(chunk)
    } catch (error) {
      this.close(error as Error)
      return
    }
    for (const frame of frames) {
      if (this.failure !== undefined) return
      try {
        this.dispatch(frame)
      } catch (error) {
        this.close(error as Error)
        return
      }
    }
  }

  private dispatch(frame: Frame): void {
    switch (frame.type) {
      case FRAME_JSON:
        // The RPC consumer owns its own write queue and in-flight budget, so a
        // burst is absorbed by the JSON channel's buffer instead of pausing a
        // transport this multiplexer does not control.
        this.jsonChannel.write(frame.json)
        return
      case FRAME_OPEN:
        this.receiveOpen(frame.id, frame.endpoint)
        return
      case FRAME_OPEN_OK: {
        // A cancelled or already-resolved open must not close the channel: the
        // peer answered a request this side is no longer waiting on.
        const pending = this.accepts.get(frame.id)
        if (pending === undefined) return
        this.accepts.delete(frame.id)
        pending.resolve()
        return
      }
      case FRAME_OPEN_FAIL: {
        // Same leniency as an acknowledgement, plus the channel state may
        // already be gone if the open was cancelled.
        const state = this.channels.get(frame.id)
        if (state !== undefined) this.removeState(state, new Error(frame.message))
        const pending = this.accepts.get(frame.id)
        if (pending === undefined) return
        this.accepts.delete(frame.id)
        pending.reject(new Error(frame.message === '' ? 'the remote refused the stream' : frame.message))
        return
      }
      case FRAME_DATA: {
        const state = this.requireState(frame.id, 'data')
        const accepted = state.channel.push(frame.payload)
        state.pendingCredit += frame.payload.length
        if (!accepted) state.blocked = true
        this.offerCredit(state)
        return
      }
      case FRAME_END: {
        // The peer can half-close a stream this side already reaped, so an
        // unknown id here is a late message, not a desync.
        const state = this.channels.get(frame.id)
        if (state === undefined) return
        if (frame.direction === END_DIRECTION.inbound) {
          state.receivedEnd = true
          if (!state.channel.readableEnded) state.channel.push(null)
          this.reap(state)
        } else {
          // The peer will not read any more; stop writing and release it.
          state.receivedEnd = true
          if (!state.channel.destroyed) state.channel.destroy()
          this.channels.delete(state.id)
        }
        return
      }
      case FRAME_ABORT: {
        // As with a half-close, an abort may race this side's own cleanup.
        const state = this.channels.get(frame.id)
        if (state !== undefined) this.removeState(state, new Error(frame.message === '' ? 'the remote aborted the stream' : frame.message))
        return
      }
      case FRAME_CREDIT: {
        // A credit can arrive after this side finished and reaped the stream;
        // ignoring it only leaves the peer's window tighter than necessary.
        const state = this.channels.get(frame.id)
        if (state === undefined) return
        state.sendWindow += frame.bytes
        this.pump(state)
        return
      }
      default:
        throw new FrameError('unknown frame type')
    }
  }

  private requireState(id: number, what: string): ChannelState {
    const state = this.channels.get(id)
    if (state === undefined) throw new FrameError(`received ${what} for unknown stream ${id}`)
    return state
  }

  private receiveOpen(id: number, endpoint: unknown): void {
    if (this.options.role !== 'server') throw new FrameError('a client-role mux must not receive stream-open')
    if (this.channels.has(id)) throw new FrameError(`stream ${id} is already attached`)
    const accept = this.options.accept as NonNullable<FrameMuxOptions['accept']>
    const task = Promise.resolve()
      .then(async () => accept(endpoint, id))
      .then(async (binding) => {
        if (this.failure !== undefined) {
          if (binding !== undefined) destroyBinding(binding)
          return
        }
        if (binding === undefined) {
          this.send(encodeOpenFailFrame(id, 'the remote has no stream for that endpoint'))
          return
        }
        const channel = new MuxChannel(this, id)
        this.createState(id, channel)
        // Directional wiring: client bytes flow into `inbound`, and `outbound`
        // feeds the client. One duplex for both directions would echo every
        // received byte straight back to the peer.
        channel.on('data', (chunk: Buffer) => { if (!binding.inbound.write(chunk)) channel.pause() })
        binding.inbound.on('drain', () => { channel.resume() })
        binding.inbound.on('error', (error: Error) => { channel.destroy(error) })
        channel.on('end', () => { binding.inbound.end() })
        binding.outbound.on('data', (chunk: Buffer) => {
                if (!channel.write(chunk)) binding.outbound.pause()
        })
        channel.on('drain', () => { binding.outbound.resume() })
        binding.outbound.on('error', (error: Error) => { channel.destroy(error) })
        binding.outbound.on('end', () => { channel.end() })
        channel.on('error', () => { destroyBinding(binding) })
        channel.on('close', () => { destroyBinding(binding) })
        this.send(encodeOpenOkFrame(id))
      })
      .catch((error: unknown) => {
        this.send(encodeOpenFailFrame(id, error instanceof Error ? error.message : String(error)))
      })
      .finally(() => { this.pendingAccepts.delete(task) })
    this.pendingAccepts.add(task)
  }
}

/** Release both halves of a served stream without throwing on an already-closed side. */
function destroyBinding(binding: ChannelBinding): void {
  if (!binding.inbound.destroyed) binding.inbound.destroy()
  if (!binding.outbound.destroyed) binding.outbound.destroy()
}
