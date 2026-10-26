/**
 * Execution-world mux over WebSocket (protocol §7).
 *
 * Outer handshake (plugin-owned): a text `hello` / `hello-ok` exchange after
 * the HTTP upgrade. After that, **one WS binary message = one
 * `src/frame/codec.ts` mux frame**, exactly the bytes the retired stdio
 * channel carried. The server side reuses `RemoteExecutionServer`, which
 * dispatches the official helper method set against this profile's
 * `ctx.fs`/`ctx.subprocess`/`ctx.sandbox` providers.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { PassThrough, Writable, type Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_MAX_FRAME_BYTES, FRAME_HEADER_BYTES, FRAME_JSON, encodeJsonFrame } from '../frame/codec.ts'
import { RemoteExecutionServer } from './execution/controller.ts'
import { REMOTE_WORKSPACE_PLUGIN_PROTOCOL } from '../protocol.ts'
import { PluginError } from './errors.ts'
import type { ProfileLease } from './lease.ts'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_WS_MESSAGE_BYTES = 64 * 1024 * 1024

interface WsHandlers {
  readonly onText: (text: string) => void
  readonly onBinary: (bytes: Buffer) => void
  readonly onClose: () => void
}

/** Minimal RFC-6455 server half: masked client frames in, unmasked frames out. */
export class WebSocketChannel {
  private buffer = Buffer.alloc(0)
  private fragment: { opcode: number; chunks: Buffer[] } | undefined
  private closed = false

  constructor(
    private readonly socket: Duplex,
    private handlers: WsHandlers,
  ) {
    socket.on('data', chunk => this.feed(chunk))
    socket.on('error', () => this.teardown())
    socket.on('close', () => this.teardown())
  }

  /** Complete the HTTP upgrade and start a channel; any `head` bytes are fed too. */
  static accept(req: IncomingMessage, socket: Duplex, head: Buffer): WebSocketChannel | undefined {
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || key === '') { socket.destroy(); return undefined }
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'))
    let channel: WebSocketChannel
    channel = new WebSocketChannel(socket, {
      onText: text => channel.current.onText(text),
      onBinary: bytes => channel.current.onBinary(bytes),
      onClose: () => channel.current.onClose(),
    })
    if (head.length > 0) channel.feed(head)
    return channel
  }

  private current: WsHandlers = {
    onText: () => { this.close(4003, 'mux hello missing') },
    onBinary: () => { this.close(4003, 'mux hello missing') },
    onClose: () => {},
  }

  /** Replace the message handlers (used once the outer hello is accepted). */
  setHandlers(handlers: WsHandlers): void {
    this.current = handlers
  }

  /** Send one text control frame. */
  sendText(text: string): void {
    this.sendFrame(0x1, Buffer.from(text, 'utf8'))
  }

  /** Send one binary mux frame. */
  sendBinary(payload: Buffer): void {
    this.sendFrame(0x2, payload)
  }

  /** Send a close frame and tear the socket down. */
  close(code = 1000, reason = ''): void {
    if (this.closed) return
    const body = Buffer.alloc(2 + Buffer.byteLength(reason))
    body.writeUInt16BE(code, 0)
    body.write(reason, 2)
    this.sendFrame(0x8, body)
    this.teardown()
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.closed) return
    const length = payload.length
    let header: Buffer
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length])
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(length), 2)
    }
    try { this.socket.write(Buffer.concat([header, payload])) } catch { this.teardown() }
  }

  private feed(chunk: Buffer): void {
    if (this.closed) return
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const first = this.buffer[0] as number
      const second = this.buffer[1] as number
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(MAX_WS_MESSAGE_BYTES)) { this.close(1009, 'frame too large'); return }
        length = Number(big)
        offset = 10
      }
      if (length > MAX_WS_MESSAGE_BYTES) { this.close(1009, 'frame too large'); return }
      const maskOffset = offset
      if (masked) offset += 4
      if (this.buffer.length < offset + length) return
      let payload: Buffer = this.buffer.subarray(offset, offset + length)
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4)
        const unmasked = Buffer.allocUnsafe(payload.length)
        for (let i = 0; i < payload.length; i++) unmasked[i] = (payload[i] as number) ^ (mask[i % 4] as number)
        payload = unmasked
      }
      this.buffer = this.buffer.subarray(offset + length)
      if (opcode === 0x8) { this.close(1000); return }
      if (opcode === 0x9) { this.sendFrame(0xa, payload); continue }
      if (opcode === 0xa) continue
      if (opcode === 0x0) {
        if (this.fragment === undefined) { this.close(1002, 'unexpected continuation'); return }
        this.fragment.chunks.push(payload)
        if (fin) {
          const complete = Buffer.concat(this.fragment.chunks)
          const kind = this.fragment.opcode
          this.fragment = undefined
          if (kind === 0x1) this.current.onText(complete.toString('utf8'))
          else this.current.onBinary(complete)
        }
        continue
      }
      if (opcode !== 0x1 && opcode !== 0x2) { this.close(1003, 'unsupported opcode'); return }
      if (!fin) { this.fragment = { opcode, chunks: [payload] }; continue }
      if (opcode === 0x1) this.current.onText(payload.toString('utf8'))
      else this.current.onBinary(payload)
    }
  }

  private teardown(): void {
    if (this.closed) return
    this.closed = true
    this.current.onClose()
    if (!this.socket.destroyed) this.socket.destroy()
  }
}

/** Parse the outer hello JSON value; throws a coded PluginError on mismatch. */
export function parseMuxHelloValue(value: unknown, lease: ProfileLease): { clientId: string; instanceId: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PluginError('bad-request', 'mux hello must be an object')
  const hello = value as Record<string, unknown>
  if (hello['kind'] !== 'hello') throw new PluginError('bad-request', 'first mux frame must be { kind: "hello" }')
  if (Number(hello['protocol']) !== REMOTE_WORKSPACE_PLUGIN_PROTOCOL) throw new PluginError('plugin-protocol-mismatch', `unsupported mux protocol ${String(hello['protocol'])}; this server speaks ${REMOTE_WORKSPACE_PLUGIN_PROTOCOL}`, { serverProtocol: REMOTE_WORKSPACE_PLUGIN_PROTOCOL })
  const clientId = typeof hello['clientId'] === 'string' ? hello['clientId'] : ''
  const instanceId = typeof hello['instanceId'] === 'string' ? hello['instanceId'] : ''
  if (!lease.matches(clientId, instanceId)) throw new PluginError('lease-mismatch', 'the mux hello identity does not match the active profile lease')
  return { clientId, instanceId }
}

/** Parse one text hello message (compatibility path). */
export function parseMuxHello(text: string, lease: ProfileLease): { clientId: string; instanceId: string } {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new PluginError('bad-request', 'mux hello is not JSON') }
  return parseMuxHelloValue(value, lease)
}

/** Decode one outer binary hello (a FRAME_JSON codec frame); returns the payload. */
export function decodeBinaryHello(bytes: Buffer): unknown {
  if (bytes.length <= FRAME_HEADER_BYTES) throw new PluginError('bad-request', 'mux hello frame is empty')
  if (bytes[0] !== FRAME_JSON) throw new PluginError('bad-request', 'first mux frame must be a FRAME_JSON hello frame')
  try { return JSON.parse(bytes.subarray(FRAME_HEADER_BYTES).toString('utf8')) } catch { throw new PluginError('bad-request', 'mux hello payload is not JSON') }
}

/**
 * Serve one authenticated upgrade: outer hello, then FrameMux bytes to the
 * execution-world server. The caller has already run `connection.admit` and
 * checked the lease headers.
 */
export function serveMux(ctx: Context, lease: ProfileLease, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const channel = WebSocketChannel.accept(req, socket, head)
  if (channel === undefined) return
  let server: RemoteExecutionServer | undefined
  let input: PassThrough | undefined
  let helloSettled = false
  const dispose = (): void => {
    void server?.dispose().catch(() => {})
    server = undefined
    if (input !== undefined && !input.destroyed) input.end()
    input = undefined
  }
  const settleHello = (): void => {
    helloSettled = true
    const source = new PassThrough()
    input = source
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) { channel.sendBinary(chunk); callback() },
      final(callback) { channel.close(); callback() },
    })
    try {
      server = new RemoteExecutionServer({ ctx, input: source, output, workspace: process.cwd() })
    } catch (error) {
      channel.close(4003, error instanceof Error ? error.message : 'execution world unavailable')
      return
    }
    channel.setHandlers({
      onText: () => { channel.close(4002, 'mux accepts binary frames only after hello') },
      onBinary: bytes => {
        if (input === undefined) { channel.close(4004, 'mux is closing'); return }
        input.write(bytes)
      },
      onClose: dispose,
    })
    // The outer hello-ok is itself one codec FRAME_JSON frame (contract A).
    channel.sendBinary(encodeJsonFrame(Buffer.from(JSON.stringify({ kind: 'hello-ok', protocol: REMOTE_WORKSPACE_PLUGIN_PROTOCOL, maxFrameBytes: DEFAULT_MAX_FRAME_BYTES }), 'utf8')))
  }
  channel.setHandlers({
    onText: text => {
      if (helloSettled) { channel.close(4002, 'unexpected mux text frame'); return }
      try { parseMuxHello(text, lease) } catch (error) {
        const code = error instanceof PluginError && error.code === 'lease-mismatch' ? 4003 : 4001
        channel.close(code, error instanceof Error ? error.message : 'mux hello rejected')
        return
      }
      settleHello()
    },
    onBinary: bytes => {
      if (helloSettled) {
        if (input === undefined) { channel.close(4004, 'mux is closing'); return }
        input.write(bytes)
        return
      }
      try { parseMuxHelloValue(decodeBinaryHello(bytes), lease) } catch (error) {
        const code = error instanceof PluginError && error.code === 'lease-mismatch' ? 4003 : 4001
        channel.close(code, error instanceof Error ? error.message : 'mux hello rejected')
        return
      }
      settleHello()
    },
    onClose: dispose,
  })
}
