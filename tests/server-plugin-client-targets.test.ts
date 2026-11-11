/**
 * `client/targets`: the snapshot the client host publishes and the browser half
 * reads (protocol §16.14).
 *
 * Two layers are pinned here: the pure normalization/retention rules (that is
 * where secret leakage, unbounded memory and stale overwrites would happen), and
 * the real `apply` route wiring (admission-only GET, capability bit, dispatch).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  CLIENT_TARGETS_MAX_ROWS,
  ClientTargetsSnapshot,
  emptyClientTargets,
  normalizeClientTargets,
} from '../src/server-plugin/client-targets.ts'
import { apply } from '../src/server-plugin/index.ts'
import { REMOTE_WORKSPACE_PLUGIN_PROTOCOL, REMOTE_WORKSPACE_PLUGIN_VERSION, RW_PATHS } from '../src/protocol.ts'

/** Minimal response the exact-route handlers write into. */
class FakeResponse {
  status = 0
  headers: Record<string, string> = {}
  body = ''
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status
    this.headers = headers
    return this
  }
  end(body?: string): this {
    this.body = body ?? ''
    return this
  }
}

/** One request: headers plus an async body, which is all the routes read. */
class FakeRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  private readonly payload: string

  constructor(options: { method?: string; url?: string; headers?: Record<string, string>; body?: unknown } = {}) {
    this.method = options.method ?? 'POST'
    this.url = options.url ?? '/'
    this.headers = options.headers ?? {}
    this.payload = options.body === undefined ? '' : JSON.stringify(options.body)
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
    if (this.payload !== '') yield Buffer.from(this.payload, 'utf8')
  }
}

interface FakeRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: unknown, res: FakeResponse) => unknown
}

const CLIENT_ID = 'client-abc'
const PROFILE = 'profile-x'
const PRINCIPAL = { 'x-dsh-rw-client': CLIENT_ID, 'x-dsh-rw-instance': 'instance-1' }

/** Run the real plugin `apply` against a stub host context. */
function installPlugin(): {
  readonly routes: Map<string, FakeRoute>
  cleanup(): void
} {
  const routes = new Map<string, FakeRoute>()
  const webServer = {
    port: 4242,
    register(route: unknown): () => void {
      const record = route as FakeRoute
      routes.set(record.path, record)
      return () => {}
    },
    registerUpgrade(): () => void { return () => {} },
    tapIndex(): () => void { return () => {} },
  }
  const connection = { admit: () => ({ peer: { id: 'peer' } }) }
  const home = mkdtempSync(join(tmpdir(), 'dsh-rw-targets-'))
  const ctx: Record<string, unknown> = {}
  ctx['get'] = (service: string) => {
    if (service === 'webServer') return webServer
    if (service === 'connection') return connection
    return undefined
  }
  ctx['effect'] = (callback: () => unknown) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  }
  ctx['inject'] = (_deps: string[], callback: (scope: unknown) => void) => {
    callback(ctx)
    return () => {}
  }
  apply(ctx as never, { profile: PROFILE, clientId: CLIENT_ID, home })
  return { routes, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/** Read the envelope body of one route call. */
function decodeEnvelope(response: FakeResponse): { ok: boolean; value?: unknown; error?: { code?: string } } {
  return JSON.parse(response.body) as { ok: boolean; value?: unknown; error?: { code?: string } }
}

/** POST one P1 RPC through the real route. */
async function rpc(
  routes: Map<string, FakeRoute>,
  method: string,
  params: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: { code?: string } }> {
  const response = new FakeResponse()
  await routes.get(RW_PATHS.rpc)?.handler(new FakeRequest({
    headers: PRINCIPAL,
    body: { protocol: REMOTE_WORKSPACE_PLUGIN_PROTOCOL, method, params },
  }), response)
  return decodeEnvelope(response)
}

/** GET the snapshot through the real route. */
async function readSnapshot(routes: Map<string, FakeRoute>): Promise<{ ok: boolean; value?: unknown }> {
  const response = new FakeResponse()
  await routes.get(RW_PATHS.clientTargets)?.handler(new FakeRequest({ method: 'GET' }), response)
  return decodeEnvelope(response)
}

/** One well-formed publication. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: CLIENT_ID,
    updatedAt: 10,
    activeTargetId: 't1',
    targets: [
      { targetId: 't1', label: 'dev-box', kind: 'ssh', host: '203.0.113.10', port: 22, username: 'tester', phase: 'ready', active: true },
      { targetId: 't2', label: 'wsl-box', kind: 'wsl', host: 'Ubuntu', phase: 'stopped' },
    ],
    ...overrides,
  }
}

describe('client target snapshot normalization', () => {
  it('rebuilds rows from the whitelist and drops unknown fields', () => {
    const value = normalizeClientTargets(snapshot({
      targets: [{
        targetId: 't1',
        label: 'dev-box',
        kind: 'ssh',
        host: '203.0.113.10',
        port: 22,
        username: 'tester',
        phase: 'ready',
        active: true,
        // Fields that must never survive into the server profile:
        credentialKey: 'ssh/dev-box',
        privateKeyPath: '/home/user/.ssh/id_ed25519',
        hostKeyFingerprint: 'SHA256:abc',
        profileName: 'graydovee-remote-workspace-client-abc',
      }],
    }))
    expect(value.targets).toEqual([{
      targetId: 't1',
      label: 'dev-box',
      kind: 'ssh',
      host: '203.0.113.10',
      port: 22,
      username: 'tester',
      phase: 'ready',
      active: true,
    }])
    expect(JSON.stringify(value)).not.toContain('credentialKey')
    expect(JSON.stringify(value)).not.toContain('privateKeyPath')
    expect(JSON.stringify(value)).not.toContain('hostKeyFingerprint')
  })

  it('drops rows with an unusable id, kind or phase instead of rendering them half-valid', () => {
    const value = normalizeClientTargets({
      clientId: CLIENT_ID,
      updatedAt: 1,
      targets: [
        { targetId: '', label: 'empty id', kind: 'ssh', phase: 'ready' },
        { targetId: 'no-kind', label: 'x', phase: 'ready' },
        { targetId: 'bad-phase', label: 'x', kind: 'ssh', phase: 'exploded' },
        { targetId: 'ok', label: 'ok', kind: 'ssh', phase: 'connecting' },
      ],
    })
    expect(value.targets.map(row => row.targetId)).toEqual(['ok'])
  })

  it('bounds the list to 64 rows and de-duplicates by target id', () => {
    const rows = Array.from({ length: CLIENT_TARGETS_MAX_ROWS + 5 }, (_, index) => ({
      targetId: `t${index % (CLIENT_TARGETS_MAX_ROWS + 5)}`,
      label: `row ${index}`,
      kind: 'ssh',
      phase: 'ready',
    }))
    const value = normalizeClientTargets({ clientId: CLIENT_ID, updatedAt: 1, targets: rows })
    expect(value.targets.length).toBe(CLIENT_TARGETS_MAX_ROWS)
    expect(new Set(value.targets.map(row => row.targetId)).size).toBe(CLIENT_TARGETS_MAX_ROWS)
  })

  it('scrubs secret-shaped text the client leaked into a label or host', () => {
    const value = normalizeClientTargets({
      clientId: CLIENT_ID,
      updatedAt: 1,
      targets: [{
        targetId: 't1',
        label: 'token=supersecret-value',
        kind: 'ssh',
        host: 'password=hunter2',
        username: 'sk-abcdefgh1234',
        phase: 'ready',
      }],
    })
    const row = value.targets[0]!
    expect(row.label).toBe('token=[redacted]')
    expect(row.host).toBe('password=[redacted]')
    expect(row.username).toBe('[redacted]')
  })

  it('rejects a malformed envelope with bad-request and accepts an empty list', () => {
    expect(() => normalizeClientTargets(null)).toThrowError(/object body/)
    expect(() => normalizeClientTargets({ updatedAt: 1, targets: [] })).toThrowError(/clientId/)
    expect(() => normalizeClientTargets({ clientId: CLIENT_ID, targets: [] })).toThrowError(/updatedAt/)
    expect(normalizeClientTargets({ clientId: CLIENT_ID, updatedAt: 0, targets: [] })).toEqual({
      clientId: CLIENT_ID,
      updatedAt: 0,
      targets: [],
    })
  })
})

describe('client target snapshot retention', () => {
  it('starts empty and serves the documented empty value', () => {
    const store = new ClientTargetsSnapshot()
    expect(store.read()).toEqual({ clientId: '', updatedAt: 0, targets: [] })
    expect(store.present).toBe(false)
    expect(emptyClientTargets()).toEqual({ clientId: '', updatedAt: 0, targets: [] })
  })

  it('keeps updatedAt monotonic and drops equal or older publications', () => {
    const store = new ClientTargetsSnapshot()
    expect(store.accept(snapshot({ updatedAt: 10 }))).toEqual({ accepted: true, updatedAt: 10, count: 2 })
    expect(store.accept(snapshot({ updatedAt: 9, activeTargetId: 't2' }))).toEqual({ accepted: false, updatedAt: 10, count: 2 })
    expect(store.accept(snapshot({ updatedAt: 10, activeTargetId: 't2' }))).toEqual({ accepted: false, updatedAt: 10, count: 2 })
    expect(store.read().activeTargetId).toBe('t1')
    expect(store.accept(snapshot({ updatedAt: 11, activeTargetId: 't2' }))).toEqual({ accepted: true, updatedAt: 11, count: 2 })
    expect(store.read().activeTargetId).toBe('t2')
  })

  it('clears on demand (lease release) and accepts a lower stamp again afterwards', () => {
    const store = new ClientTargetsSnapshot()
    store.accept(snapshot({ updatedAt: 100 }))
    store.clear()
    expect(store.read().targets).toEqual([])
    expect(store.accept(snapshot({ updatedAt: 1 }))).toEqual({ accepted: true, updatedAt: 1, count: 2 })
  })

  it('refuses a publication that claims another client than the lease', () => {
    const store = new ClientTargetsSnapshot()
    expect(() => store.accept(snapshot({ clientId: 'someone-else' }), { leaseClientId: CLIENT_ID }))
      .toThrowError(/does not match the active profile lease/)
    expect(store.present).toBe(false)
    expect(store.accept(snapshot(), { leaseClientId: CLIENT_ID })).toEqual({ accepted: true, updatedAt: 10, count: 2 })
    // Without a lease owner the body cannot be cross-checked; the headers already were.
    expect(store.accept(snapshot({ updatedAt: 11, clientId: 'other' }), {})).toEqual({ accepted: true, updatedAt: 11, count: 2 })
  })
})

describe('client target route and dispatch', () => {
  it('advertises the capability bit, serves the empty snapshot, then the published one', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = installPlugin()
    try {
      const handshake = new FakeResponse()
      await harness.routes.get(RW_PATHS.handshake)?.handler(new FakeRequest({
        headers: { 'x-dsh-rw-client': CLIENT_ID },
        body: {
          protocol: REMOTE_WORKSPACE_PLUGIN_PROTOCOL,
          pluginVersion: REMOTE_WORKSPACE_PLUGIN_VERSION,
          clientId: CLIENT_ID,
          instanceId: 'instance-1',
          profile: PROFILE,
        },
      }), handshake)
      const handshaken = decodeEnvelope(handshake) as { value: { capabilities: Record<string, unknown> } }
      expect(handshaken.value.capabilities['clientTargets']).toBe(1)

      // Before the first publication the route answers the documented empty value.
      expect(await readSnapshot(harness.routes)).toEqual({
        ok: true,
        value: { clientId: '', updatedAt: 0, targets: [] },
      })

      expect(await rpc(harness.routes, 'client/targets', snapshot())).toEqual({
        ok: true,
        value: { accepted: true, updatedAt: 10, count: 2 },
      })
      const read = await readSnapshot(harness.routes) as { value: { updatedAt: number; activeTargetId: string; targets: unknown[] } }
      expect(read.value.updatedAt).toBe(10)
      expect(read.value.activeTargetId).toBe('t1')
      expect(read.value.targets).toHaveLength(2)

      // A stale republication is an accepted RPC with accepted:false, not an error.
      expect(await rpc(harness.routes, 'client/targets', snapshot({ updatedAt: 5 }))).toEqual({
        ok: true,
        value: { accepted: false, updatedAt: 10, count: 2 },
      })

      // `profile/release` drops the list with the lease.
      expect((await rpc(harness.routes, 'profile/release', {})).ok).toBe(true)
      expect(await readSnapshot(harness.routes)).toEqual({
        ok: true,
        value: { clientId: '', updatedAt: 0, targets: [] },
      })
    } finally {
      harness.cleanup()
      errorSpy.mockRestore()
    }
  })

  it('rejects an unauthenticated read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const home = mkdtempSync(join(tmpdir(), 'dsh-rw-targets-'))
    const routes = new Map<string, FakeRoute>()
    const webServer = {
      port: 4242,
      register(route: unknown): () => void {
        const record = route as FakeRoute
        routes.set(record.path, record)
        return () => {}
      },
      registerUpgrade(): () => void { return () => {} },
      tapIndex(): () => void { return () => {} },
    }
    const ctx: Record<string, unknown> = {}
    ctx['get'] = (service: string) => {
      if (service === 'webServer') return webServer
      // No `connection` service: admission cannot pass.
      return undefined
    }
    ctx['effect'] = (callback: () => unknown) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    }
    ctx['inject'] = (_deps: string[], callback: (scope: unknown) => void) => { callback(ctx); return () => {} }
    apply(ctx as never, { profile: PROFILE, clientId: CLIENT_ID, home })
    try {
      const response = new FakeResponse()
      await routes.get(RW_PATHS.clientTargets)?.handler(new FakeRequest({ method: 'GET' }), response)
      expect(response.status).toBe(401)
      expect(decodeEnvelope(response).error?.code).toBe('unauthorized')
    } finally {
      rmSync(home, { recursive: true, force: true })
      errorSpy.mockRestore()
    }
  })

  it('routes the client targets path exactly once and never through the lease headers', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = installPlugin()
    try {
      expect(harness.routes.has(RW_PATHS.clientTargets)).toBe(true)
      expect(RW_PATHS.clientTargets).toBe('/dsh-remote-workspace-server/api/client/targets')
      // No lease yet: the read still answers (admission only), unlike `api/rpc`.
      const read = await readSnapshot(harness.routes)
      expect(read.ok).toBe(true)
      expect((await rpc(harness.routes, 'profile/status', {})).error?.code).toBe('lease-mismatch')
    } finally {
      harness.cleanup()
      errorSpy.mockRestore()
    }
  })
})
