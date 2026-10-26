import { describe, expect, it } from 'vitest'
import { renameStoredSession } from '../src/server-plugin/session-rename.ts'

function harness(options: { events?: unknown[]; openError?: Error }) {
  const appended: unknown[][] = []
  const ctx = {
    get: (name: string) => name === 'sessionPersistence' ? {
      async open() {
        if (options.openError !== undefined) throw options.openError
        return {
          async read() { return { events: options.events ?? [] } },
          async append(events: unknown[]) { appended.push(events) },
          async flush() {},
          async close() {},
        }
      },
    } : undefined,
  }
  return { ctx: ctx as never, appended }
}

describe('P1 session/rename fallback', () => {
  it('appends one durable user title event at the next seq', async () => {
    const { ctx, appended } = harness({ events: [{ seq: 0 }, { seq: 1 }] })
    const value = await renameStoredSession(ctx, { sessionId: 's1', title: '  New title  ' })
    expect(value).toEqual({ title: 'New title', seq: 2 })
    expect(appended).toHaveLength(1)
    expect(appended[0]?.[0]).toMatchObject({ type: 'session/title', seq: 2, data: { title: 'New title', source: { kind: 'user' } } })
  })

  it('maps writer-held without appending', async () => {
    const held = Object.assign(new Error('owned'), { name: 'SessionAlreadyOwnedError' })
    const { ctx, appended } = harness({ openError: held })
    await expect(renameStoredSession(ctx, { sessionId: 's1', title: 'x' })).rejects.toMatchObject({ code: 'session/writer-held' })
    expect(appended).toHaveLength(0)
  })

  it('rejects an empty title', async () => {
    const { ctx } = harness({})
    await expect(renameStoredSession(ctx, { sessionId: 's1', title: '   ' })).rejects.toMatchObject({ code: 'bad-request' })
  })
})
