/**
 * Remote execution-world dispatch over the SSH helper protocol.
 *
 * The official `dsh-fs-ssh` provider is what runs inside the remote world, so
 * every method it calls must exist on this server. These tests drive the real
 * channel (mux + RPC peer) with a fake provider context: they prove the method
 * set, the request admission and the reply shapes, which is exactly the layer a
 * dsh upgrade breaks without any TypeScript error (0.2.2 added `fs.patch`,
 * `fs.delete` and `fs.move` and the server silently fell through to
 * `unknown remote workspace operation`).
 */
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SSH_PROTOCOL_VERSION, SshRpcPeer } from '@deepseek-ai/dsh-ssh/protocol'
import { deleteResultSchema, editResultSchema, helloSchema, moveResultSchema } from '@deepseek-ai/dsh-ssh/schemas'
import { DEFAULT_MAX_FRAME_BYTES } from '../src/frame/codec.ts'
import { FrameMux, streamTransport } from '../src/frame/mux.ts'
import { RemoteExecutionServer } from '../src/server-plugin/execution/controller.ts'

/** One provider call the fake filesystem observed. */
interface ProviderCall {
  readonly method: string
  readonly args: readonly unknown[]
}

/** A target keyed by its remote path; the fake provider never canonicalizes further. */
const target = (path: string): { targetKey: string; displayPath: string } => ({ targetKey: path, displayPath: path })

/**
 * Start one server and one client end over in-memory streams.
 * @param fs - fake filesystem provider mounted as `ctx.fs`.
 * @param calls - provider calls recorded in order.
 * @returns the connected client peer and a disposal helper.
 */
function channel(fs: Record<string, unknown>, calls: ProviderCall[]) {
  const toServer = new PassThrough()
  const toClient = new PassThrough()
  const mux = new FrameMux({ transport: streamTransport(toClient, toServer), role: 'client', label: 'controller-test' })
  const peer = new SshRpcPeer(mux.jsonInput(), mux.jsonOutput(), DEFAULT_MAX_FRAME_BYTES, 128)
  const server = new RemoteExecutionServer({
    // The dispatch path only reads `ctx.fs`; the fake is narrower than Context on purpose.
    ctx: { fs } as never,
    input: toServer,
    output: toClient,
    workspace: '/work',
    leaseMs: 30_000,
    entryPath: fileURLToPath(new URL('../src/server-plugin/execution/controller.ts', import.meta.url)),
  })
  const dispose = async (): Promise<void> => {
    await server.dispose()
    mux.close()
  }
  return { peer, dispose }
}

/** A provider record whose `resolve` rejects paths containing `missing`. */
function filesystem(calls: ProviderCall[]) {
  const record = (method: string, outcome: unknown) => async (...args: unknown[]): Promise<unknown> => {
    calls.push({ method, args })
    return outcome
  }
  return {
    async resolve(path: string, options?: { signal?: AbortSignal }): Promise<{ targetKey: string; displayPath: string }> {
      calls.push({ method: 'resolve', args: [path, options] })
      if (path.includes('missing')) throw new Error(`FS_NOT_FOUND: ${path}`)
      return target(path)
    },
    processPath(value: { targetKey: string }): string {
      return value.targetKey
    },
    patchText: record('patchText', { version: 'v2', before: 'alpha\n', after: 'beta\n' }),
    deleteFile: record('deleteFile', { before: 'beta\n' }),
    moveFile: record('moveFile', {
      sourceBefore: 'beta\n',
      destination: { operation: 'create', version: 'v3', before: null, after: 'beta\n' },
      sourceDeleted: true,
    }),
  }
}

const policy = (extra?: readonly string[]): Record<string, unknown> => ({
  mode: 'workspace-write',
  workspaceRoot: '/work',
  ...(extra === undefined ? {} : { additionalWritableRoots: [...extra] }),
})

describe('remote execution-world dispatch', () => {
  it('serves fs.patch with canonicalized roots and the hunk payload', async () => {
    const calls: ProviderCall[] = []
    const { peer, dispose } = channel(filesystem(calls), calls)
    try {
      await peer.request(
        'hello',
        { protocol: SSH_PROTOCOL_VERSION, workspace: '/work', leaseMs: 30_000 },
        helloSchema,
        AbortSignal.timeout(5_000),
      )
      const hunks = [{ lineNumber: 1, context: 'alpha', oldLines: ['alpha'], newLines: ['beta'], isEndOfFile: false }]
      const reply = await peer.request(
        'fs.patch',
        { target: target('/work/file.txt'), hunks, expected: { version: 'v1' }, policy: policy(['/work/extra']) },
        editResultSchema,
        AbortSignal.timeout(5_000),
      )
      expect(reply).toEqual({ version: 'v2', before: 'alpha\n', after: 'beta\n' })
      const patch = calls.find(call => call.method === 'patchText')
      expect(patch?.args[0]).toEqual(target('/work/file.txt'))
      expect(patch?.args[1]).toEqual(hunks)
      expect(patch?.args[2]).toEqual({ version: 'v1' })
      // The wire policy carries the client's spelling; the provider sees this
      // host's canonical paths, extra writable roots included.
      expect(patch?.args[4]).toEqual({ mode: 'workspace-write', workspaceRoot: '/work', additionalWritableRoots: ['/work/extra'] })
    } finally {
      await dispose()
    }
  })

  it('serves fs.delete and returns the removed content basis', async () => {
    const calls: ProviderCall[] = []
    const { peer, dispose } = channel(filesystem(calls), calls)
    try {
      await peer.request(
        'hello',
        { protocol: SSH_PROTOCOL_VERSION, workspace: '/work', leaseMs: 30_000 },
        helloSchema,
        AbortSignal.timeout(5_000),
      )
      const reply = await peer.request(
        'fs.delete',
        { target: target('/work/file.txt'), expected: { version: 'v2' }, policy: policy() },
        deleteResultSchema,
        AbortSignal.timeout(5_000),
      )
      expect(reply).toEqual({ before: 'beta\n' })
      const remove = calls.find(call => call.method === 'deleteFile')
      expect(remove?.args[0]).toEqual(target('/work/file.txt'))
      expect(remove?.args[1]).toEqual({ version: 'v2' })
    } finally {
      await dispose()
    }
  })

  it('serves fs.move with the source/destination guards', async () => {
    const calls: ProviderCall[] = []
    const { peer, dispose } = channel(filesystem(calls), calls)
    try {
      await peer.request(
        'hello',
        { protocol: SSH_PROTOCOL_VERSION, workspace: '/work', leaseMs: 30_000 },
        helloSchema,
        AbortSignal.timeout(5_000),
      )
      const options = {
        hunks: [{ lineNumber: 1, oldLines: ['beta'], newLines: ['gamma'], isEndOfFile: false }],
        expectedSource: { version: 'v2' },
        expectedDestination: { kind: 'createIfAbsent' },
      }
      const reply = await peer.request(
        'fs.move',
        { source: target('/work/file.txt'), destination: target('/work/next.txt'), options, policy: policy() },
        moveResultSchema,
        AbortSignal.timeout(5_000),
      )
      expect(reply).toMatchObject({ sourceDeleted: true, sourceBefore: 'beta\n' })
      const move = calls.find(call => call.method === 'moveFile')
      expect(move?.args[0]).toEqual(target('/work/file.txt'))
      expect(move?.args[1]).toEqual(target('/work/next.txt'))
      expect(move?.args[2]).toEqual(options)
    } finally {
      await dispose()
    }
  })

  it('refuses a policy whose extra writable root does not resolve here', async () => {
    const calls: ProviderCall[] = []
    const { peer, dispose } = channel(filesystem(calls), calls)
    try {
      await peer.request(
        'hello',
        { protocol: SSH_PROTOCOL_VERSION, workspace: '/work', leaseMs: 30_000 },
        helloSchema,
        AbortSignal.timeout(5_000),
      )
      await expect(peer.request(
        'fs.delete',
        { target: target('/work/file.txt'), policy: policy(['/work/missing']) },
        deleteResultSchema,
        AbortSignal.timeout(5_000),
      )).rejects.toThrow(/FS_NOT_FOUND/u)
      expect(calls.some(call => call.method === 'deleteFile')).toBe(false)
    } finally {
      await dispose()
    }
  })
})
