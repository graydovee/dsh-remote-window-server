/**
 * TLS-PSK authentication for out-of-band streams.
 *
 * Streams that ride inside this plugin's multiplexer (the `ssh2` exec channel
 * and a child process's stdio) are already inside an authenticated SSH session,
 * so they are protected by the per-stream capability check alone. Streams that
 * are *separate connections* — a unix socket on the same machine, used by the
 * local fixture and by CI — need proof that the peer is the endpoint owner and
 * not another local process that guessed (or replaced) a pathname. That proof is
 * a 256-bit capability used as a TLS-PSK key: it is never transmitted as data.
 *
 * Adapted from DeepSeek Harness `packages/ssh/ssh/src/stream-security.ts`
 * (MIT); the server half mirrors `helper-processes.ts`'s `endpoint()`.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { createServer, connect, type Server, type TLSSocket } from 'node:tls'
import type { Duplex } from 'node:stream'

/** Certificate-free PSK and AEAD only; there is no unauthenticated fallback. */
export const STREAM_TLS_OPTIONS = {
  ciphers: 'PSK-AES256-GCM-SHA384',
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
} as const

/** The fixed PSK identity both halves must present. */
export const STREAM_PSK_IDENTITY = 'dsh-stream'

/** Generate one stream capability: 32 random bytes, hex encoded. */
export function createStreamCapability(): string {
  return randomBytes(32).toString('hex')
}

/** Constant-time comparison of a capability against an issued one. */
export function capabilityMatches(expected: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(candidate, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function timeoutError(message: string): Error {
  return new Error(message)
}

/**
 * Client half: authenticate a connected socket with its stream capability.
 * @param socket - the connected transport (unix socket or any duplex).
 * @param capability - the per-stream 256-bit key, hex encoded.
 * @param timeoutMs - handshake deadline.
 * @param signal - cancels the handshake and destroys the stream.
 * @returns an authenticated, paused TLS stream; attach a consumer before resuming.
 */
export async function authenticateStreamClient(
  socket: Duplex,
  capability: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<TLSSocket> {
  if (signal?.aborted) {
    socket.destroy()
    signal.throwIfAborted()
  }
  const stream = connect({
    ...STREAM_TLS_OPTIONS,
    socket,
    rejectUnauthorized: true,
    pskCallback: () => ({ psk: Buffer.from(capability, 'hex'), identity: STREAM_PSK_IDENTITY }),
    // PSK proves peer identity without an X.509 certificate or hostname.
    checkServerIdentity: () => undefined,
  })
  const abort = (): void => { stream.destroy(signal?.reason instanceof Error ? signal.reason : new Error(String(signal?.reason))) }
  signal?.addEventListener('abort', abort, { once: true })
  stream.once('close', () => { signal?.removeEventListener('abort', abort) })
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        stream.off('secureConnect', secured)
        stream.off('error', failed)
        stream.off('close', closed)
        clearTimeout(timer)
      }
      const secured = (): void => { cleanup(); stream.disableRenegotiation(); stream.pause(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { failed(new Error('remote stream closed during authentication')) }
      const timer = setTimeout(() => { failed(timeoutError('remote stream authentication timed out')) }, timeoutMs)
      stream.once('secureConnect', secured)
      stream.once('error', failed)
      stream.once('close', closed)
    })
    return stream
  } catch (error) {
    stream.destroy()
    throw error
  }
}

/** One listening stream endpoint (single connection, then the listener closes). */
export interface StreamListener {
  readonly path: string
  readonly capability: string
  readonly connected: Promise<Duplex>
  close(): Promise<void>
}

/**
 * Bind one unix-socket endpoint that accepts exactly one PSK-authenticated peer.
 * @param path - absolute socket path under the server root.
 * @param timeoutMs - TLS handshake deadline and listener lifetime hint.
 * @returns the endpoint coordinates published to the client.
 */
export async function createStreamListener(path: string, timeoutMs: number): Promise<StreamListener> {
  const capability = randomBytes(32)
  const connected = Promise.withResolvers<Duplex>()
  const server: Server = createServer({
    ...STREAM_TLS_OPTIONS,
    allowHalfOpen: true,
    handshakeTimeout: timeoutMs,
    pskCallback: (_socket, identity) => identity === STREAM_PSK_IDENTITY ? capability : null,
  })
  let accepted: TLSSocket | undefined
  server.maxConnections = 8
  void connected.promise.catch(() => {})
  server.on('tlsClientError', (_error, socket) => { socket.destroy() })
  server.on('secureConnection', (socket) => {
    if (accepted !== undefined) {
      socket.destroy()
      return
    }
    socket.disableRenegotiation()
    socket.pause()
    socket.on('error', () => {})
    accepted = socket
    server.close()
    connected.resolve(socket)
  })
  server.on('error', (error) => { connected.reject(error) })
  server.on('close', () => {
    if (accepted === undefined) connected.reject(new Error('remote stream reservation closed'))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    await chmod(path, 0o600)
  } catch (error) {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    throw error
  }
  return {
    path,
    capability: capability.toString('hex'),
    connected: connected.promise,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      if (accepted !== undefined && !accepted.closed) accepted.destroy()
    },
  }
}
