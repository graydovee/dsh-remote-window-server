import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutorStore } from '../src/server-plugin/executor.ts'
import { executorModeOf } from '../src/server-plugin/session-row.ts'

const homes: string[] = []
afterEach(async () => { while (homes.length > 0) await rm(homes.pop() as string, { recursive: true, force: true }) })

describe('session/list executor column', () => {
  it('defaults a missing executor record to server', () => {
    expect(executorModeOf(null)).toBe('server')
    expect(executorModeOf(undefined)).toBe('server')
  })

  it('reports local after a local-mode session record', async () => {
    const home = `${tmpdir()}/rw-row-${Math.random().toString(16).slice(2)}`
    homes.push(home)
    const store = new ExecutorStore(join(home, 'executors'))
    const owner = { clientId: 'c1', instanceId: 'i1', heartbeatAt: new Date().toISOString() }
    await store.assign('session-local', 'local', owner, 'handoff')
    expect(executorModeOf(await store.get('session-local'))).toBe('local')
  })

  it('reports server after an executor switch back to server', async () => {
    const home = `${tmpdir()}/rw-row-${Math.random().toString(16).slice(2)}`
    homes.push(home)
    const store = new ExecutorStore(join(home, 'executors'))
    await store.assign('session-server', 'server', undefined, 'user')
    expect(executorModeOf(await store.get('session-server'))).toBe('server')
  })
})
