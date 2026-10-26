import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutorStore } from '../src/server-plugin/executor.ts'
import { EVENT_COUNT_DECODE_MAX_BYTES, EVENT_COUNT_DECODE_WARN_BYTES, PersistBridge } from '../src/server-plugin/persist.ts'

const homes: string[] = []
afterEach(async () => { while (homes.length > 0) await rm(homes.pop() as string, { recursive: true, force: true }) })

function harness(options: { record?: { mode: 'server' | 'local'; owner?: { clientId: string; instanceId: string; heartbeatAt: string } }; liveAgent?: boolean; eventCount?: number; readEvents?: number; sizeBytes?: number; appendError?: Error }) {
  const home = `${tmpdir()}/rw-persist-${Math.random().toString(16).slice(2)}`
  homes.push(home)
  const store = new ExecutorStore(join(home, 'executors'))
  const workspace = { id: 'w1', path: '/work' }
  const opened: Array<{ sessionId: string; access: string }> = []
  let readCalls = 0
  const persistence = {
    async open(sessionId: string, access: string) {
      opened.push({ sessionId, access })
      return {
        id: sessionId, header: { id: sessionId, cwd: '/work' }, inheritedEventCount: 0, access,
        async read() { readCalls += 1; return { events: Array.from({ length: options.readEvents ?? 0 }, () => ({ type: 'session/title' })), eventState: 'owned' } },
        async append(events: readonly unknown[]) { if (options.appendError !== undefined) throw options.appendError; void events }, async flush() {}, async close() {},
      }
    },
    async create() { throw new Error('not used') },
    async list() { return [] },
    async stat() { return { header: { id: 's1' }, ...(options.eventCount === undefined ? {} : { eventCount: options.eventCount }), ...(options.sizeBytes === undefined ? {} : { sizeBytes: options.sizeBytes }) } },
    async flush() {},
  }
  const ctx = {
    get: (name: string) => name === 'sessionPersistence' ? persistence
      : name === 'workspaceRegistry' ? { list: () => [workspace] }
        : name === 'agents' ? { get: () => options.liveAgent === true ? {} : undefined }
          : undefined,
  }
  const bridge = new PersistBridge(ctx as never, store, () => ({ clientId: 'c1', instanceId: 'i1', heartbeatAt: new Date().toISOString() }))
  return { bridge, store, opened, sessionId: 's1', readCalls: () => readCalls }
}

describe('persist write-open executor guard', () => {
  it('rejects a server-mode record', async () => {
    const { bridge, store, sessionId } = harness({})
    await store.assign(sessionId, 'server', undefined, 'user')
    await expect(bridge.open({ sessionId, access: 'write' })).rejects.toMatchObject({ code: 'executor-mode-conflict' })
  })

  it('rejects another fresh local owner', async () => {
    const { bridge, store, sessionId } = harness({})
    await store.assign(sessionId, 'local', { clientId: 'other', instanceId: 'x', heartbeatAt: new Date().toISOString() }, 'user')
    await expect(bridge.open({ sessionId, access: 'write' })).rejects.toMatchObject({ code: 'executor-held' })
  })

  it('rejects an unrecorded session with a live server agent', async () => {
    const { bridge, sessionId } = harness({ liveAgent: true })
    await expect(bridge.open({ sessionId, access: 'write' })).rejects.toMatchObject({ code: 'executor-mode-conflict' })
  })

  it('computes eventCount from the official log when the snapshot omits it', async () => {
    const { bridge, sessionId } = harness({ readEvents: 2 })
    const value = await bridge.open({ sessionId, access: 'read' }) as { eventCount: number }
    expect(value.eventCount).toBe(2)
  })

  it('warns once for a large log and memoizes the decoded count', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { bridge, sessionId, readCalls } = harness({ readEvents: 2, sizeBytes: EVENT_COUNT_DECODE_WARN_BYTES + 1 })
      await expect(bridge.open({ sessionId, access: 'read' })).resolves.toMatchObject({ eventCount: 2 })
      await expect(bridge.open({ sessionId, access: 'read' })).resolves.toMatchObject({ eventCount: 2 })
      expect(readCalls()).toBe(1)
      expect(warn.mock.calls.filter(call => String(call[0]).includes('decoding it once for exact session facts'))).toHaveLength(1)
    } finally { warn.mockRestore() }
  })

  it('refuses to decode above the safety ceiling', async () => {
    const { bridge, sessionId, readCalls } = harness({ readEvents: 1, sizeBytes: EVENT_COUNT_DECODE_MAX_BYTES + 1 })
    await expect(bridge.open({ sessionId, access: 'read' })).rejects.toMatchObject({ code: 'internal' })
    expect(readCalls()).toBe(0)
  })

  it('maps a non-contiguous append to bad-request instead of internal', async () => {
    const { bridge, sessionId } = harness({ appendError: new Error('append seq mismatch for "s1": expected 3 at index 0, got 2') })
    const open = await bridge.open({ sessionId, access: 'write' }) as { handleId: string }
    await expect(bridge.append({ handleId: open.handleId, events: [{ seq: 2 }] })).rejects.toMatchObject({ code: 'bad-request', details: { reason: 'seq-mismatch' } })
  })

  it('assigns a local handoff for an unrecorded cold session', async () => {
    const { bridge, opened, sessionId, store } = harness({ eventCount: 3 })
    const value = await bridge.open({ sessionId, access: 'write' }) as { eventCount: number }
    expect(value.eventCount).toBe(3)
    expect(opened).toEqual([{ sessionId, access: 'write' }])
    await expect(store.get(sessionId)).resolves.toMatchObject({ mode: 'local', switchedBy: 'handoff' })
  })
})
