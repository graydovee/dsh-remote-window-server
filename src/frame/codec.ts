/**
 * Wire framing for the remote-workspace channel.
 *
 * Every frame is `type(1B) + length(4B BE) + payload`. The `json` type carries
 * the official helper RPC envelopes unchanged (they keep their own 4-byte
 * length prefix inside this payload, so `@deepseek-ai/dsh-ssh/protocol`'s
 * `SshRpcPeer` is reused verbatim on both ends); the remaining types implement
 * logical streams so that stdout, stdin, control and terminal channels
 * multiplex over the single SSH exec stream or stdio pipe.
 *
 * The decoder is deliberately strict: an unknown type, a zero-length or
 * oversized frame, or a truncated payload at end-of-transport is a protocol
 * error rather than a silent drop, because a desynchronized frame boundary
 * would otherwise reinterpret process output as control messages.
 */

/** JSON RPC envelope payload (official helper frame bytes, nested verbatim). */
export const FRAME_JSON = 0
/** `4B id + JSON {endpoint}`: the client asks to attach a logical stream. */
export const FRAME_OPEN = 1
/** `4B id + raw bytes`: ordered stream payload. */
export const FRAME_DATA = 2
/** `4B id + 1B direction`: half-close. 0 = the sender will send no more, 1 = the sender will read no more. */
export const FRAME_END = 3
/** `4B id + JSON {message}`: hard failure of one stream; both halves are destroyed. */
export const FRAME_ABORT = 4
/** `4B id + JSON {}`: the peer accepted the stream. */
export const FRAME_OPEN_OK = 5
/** `4B id + JSON {message}`: the peer refused the stream. */
export const FRAME_OPEN_FAIL = 6
/** `4B id + 4B bytes`: replenish the peer's send window for that stream. */
export const FRAME_CREDIT = 7

/** Fixed frame header: 1 byte type plus a 32-bit big-endian payload length. */
export const FRAME_HEADER_BYTES = 5

/** Matches the official helper's per-frame ceiling. */
export const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Stream data is chunked well below the per-frame ceiling to keep credit accounting fine-grained. */
export const DEFAULT_STREAM_CHUNK_BYTES = 256 * 1024

/** Stream ids are 32-bit; ids are allocated per transport, not per peer. */
export const MAX_STREAM_ID = 0xffff_ffff

/** Half-close directions on the wire. */
export const END_DIRECTION = { inbound: 0, outbound: 1 } as const

/** A malformed or oversized frame. */
export class FrameError extends Error {
  readonly code = 'FRAME_PROTOCOL'

  constructor(message: string) {
    super(message)
    this.name = 'FrameError'
  }
}

/** One decoded frame. `payload` is only present for data frames. */
export type Frame =
  | { readonly type: typeof FRAME_JSON; readonly json: Buffer }
  | { readonly type: typeof FRAME_OPEN; readonly id: number; readonly endpoint: unknown }
  | { readonly type: typeof FRAME_DATA; readonly id: number; readonly payload: Buffer }
  | { readonly type: typeof FRAME_END; readonly id: number; readonly direction: number }
  | { readonly type: typeof FRAME_ABORT; readonly id: number; readonly message: string }
  | { readonly type: typeof FRAME_OPEN_OK; readonly id: number }
  | { readonly type: typeof FRAME_OPEN_FAIL; readonly id: number; readonly message: string }
  | { readonly type: typeof FRAME_CREDIT; readonly id: number; readonly bytes: number }

/** Encode one frame with its 5-byte header. */
export function encodeFrame(type: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length)
  frame.writeUInt8(type, 0)
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, FRAME_HEADER_BYTES)
  return frame
}

/** Encode an RPC envelope payload; the bytes are already a length-prefixed helper frame. */
export function encodeJsonFrame(bytes: Buffer): Buffer {
  return encodeFrame(FRAME_JSON, bytes)
}

function withId(id: number, tail: Buffer): Buffer {
  const payload = Buffer.allocUnsafe(4 + tail.length)
  payload.writeUInt32BE(id >>> 0, 0)
  tail.copy(payload, 4)
  return payload
}

function jsonTail(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value) ?? 'null', 'utf8')
}

/** `stream-open` with the caller-supplied endpoint coordinates. */
export function encodeOpenFrame(id: number, endpoint: unknown): Buffer {
  return encodeFrame(FRAME_OPEN, withId(id, jsonTail({ endpoint })))
}

/** `stream-open` acknowledgement. */
export function encodeOpenOkFrame(id: number): Buffer {
  return encodeFrame(FRAME_OPEN_OK, withId(id, Buffer.alloc(0)))
}

/** `stream-open` refusal; the client rejects its `connectStream()` promise. */
export function encodeOpenFailFrame(id: number, message: string): Buffer {
  return encodeFrame(FRAME_OPEN_FAIL, withId(id, jsonTail({ message })))
}

/** One data frame. */
export function encodeDataFrame(id: number, payload: Buffer): Buffer {
  return encodeFrame(FRAME_DATA, withId(id, payload))
}

/** Half-close one direction of a stream. */
export function encodeEndFrame(id: number, direction: number): Buffer {
  return encodeFrame(FRAME_END, withId(id, Buffer.from([direction])))
}

/** Destroy one stream on both ends. */
export function encodeAbortFrame(id: number, message: string): Buffer {
  return encodeFrame(FRAME_ABORT, withId(id, jsonTail({ message })))
}

/** Replenish the peer's send window. */
export function encodeCreditFrame(id: number, bytes: number): Buffer {
  const tail = Buffer.allocUnsafe(4)
  tail.writeUInt32BE(bytes >>> 0, 0)
  return encodeFrame(FRAME_CREDIT, withId(id, tail))
}

function parseJson(bytes: Buffer, what: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new FrameError(`malformed ${what} JSON payload`)
  }
}

function objectField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return (value as Record<string, unknown>)[field]
}

/**
 * Incremental frame decoder. Feed it transport chunks; it returns every
 * complete frame in order. A partial frame at the tail is buffered.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  constructor(private readonly maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new FrameError('maxFrameBytes must be a positive integer')
    }
  }

  /** Bytes currently held for an incomplete frame (diagnostics and tests). */
  get pendingBytes(): number {
    return this.buffer.length
  }

  /**
   * Decode every complete frame available in `chunk`.
   * @param chunk - transport bytes in arrival order.
   * @returns complete frames, in order.
   * @throws FrameError if a header or payload is malformed.
   */
  push(chunk: Buffer): Frame[] {
    if (chunk.length === 0) return []
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: Frame[] = []
    let offset = 0
    while (this.buffer.length - offset >= FRAME_HEADER_BYTES) {
      const type = this.buffer.readUInt8(offset)
      const length = this.buffer.readUInt32BE(offset + 1)
      if (length === 0) throw new FrameError('frame declares an empty payload')
      if (length > this.maxFrameBytes) throw new FrameError(`frame length ${length} exceeds the ${this.maxFrameBytes} byte ceiling`)
      const end = offset + FRAME_HEADER_BYTES + length
      if (end > this.buffer.length) break
      frames.push(this.decode(type, this.buffer.subarray(offset + FRAME_HEADER_BYTES, end)))
      offset = end
    }
    this.buffer = offset === 0 ? this.buffer : this.buffer.subarray(offset)
    return frames
  }

  /**
   * Assert the transport ended exactly on a frame boundary.
   * @throws FrameError if a frame is truncated, because the peer's outcome is unknown.
   */
  end(): void {
    if (this.buffer.length !== 0) throw new FrameError('transport ended inside a frame')
  }

  private decode(type: number, payload: Buffer): Frame {
    switch (type) {
      case FRAME_JSON:
        return { type: FRAME_JSON, json: payload }
      case FRAME_OPEN: {
        const { id, tail } = this.readId(payload, 'stream-open')
        const value = parseJson(tail, 'stream-open')
        return { type: FRAME_OPEN, id, endpoint: objectField(value, 'endpoint') }
      }
      case FRAME_OPEN_OK:
        return { type: FRAME_OPEN_OK, id: this.readId(payload, 'stream-open acknowledgement').id }
      case FRAME_OPEN_FAIL: {
        const { id, tail } = this.readId(payload, 'stream-open refusal')
        return { type: FRAME_OPEN_FAIL, id, message: this.readMessage(tail, 'stream-open refusal') }
      }
      case FRAME_DATA: {
        const { id, tail } = this.readId(payload, 'stream data')
        return { type: FRAME_DATA, id, payload: tail }
      }
      case FRAME_END: {
        const { id, tail } = this.readId(payload, 'stream half-close')
        if (tail.length !== 1) throw new FrameError('stream half-close must carry exactly one direction byte')
        const direction = tail.readUInt8(0)
        if (direction !== END_DIRECTION.inbound && direction !== END_DIRECTION.outbound) {
          throw new FrameError(`unknown stream half-close direction ${direction}`)
        }
        return { type: FRAME_END, id, direction }
      }
      case FRAME_ABORT: {
        const { id, tail } = this.readId(payload, 'stream abort')
        return { type: FRAME_ABORT, id, message: this.readMessage(tail, 'stream abort') }
      }
      case FRAME_CREDIT: {
        const { id, tail } = this.readId(payload, 'stream credit')
        if (tail.length !== 4) throw new FrameError('stream credit must carry exactly four bytes')
        return { type: FRAME_CREDIT, id, bytes: tail.readUInt32BE(0) }
      }
      default:
        throw new FrameError(`unknown frame type ${type}`)
    }
  }

  private readId(payload: Buffer, what: string): { id: number; tail: Buffer } {
    if (payload.length < 4) throw new FrameError(`${what} frame is missing its stream id`)
    return { id: payload.readUInt32BE(0), tail: payload.subarray(4) }
  }

  private readMessage(tail: Buffer, what: string): string {
    const value = parseJson(tail, what)
    const message = objectField(value, 'message')
    return typeof message === 'string' ? message : ''
  }
}
