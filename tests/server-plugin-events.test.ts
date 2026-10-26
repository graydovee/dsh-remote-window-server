import { describe, expect, it } from 'vitest'
import { sessionEventParams, streamSessionEvents } from '../src/server-plugin/events.ts'

describe('v2 session events', () => {
  it('parses sessionId/afterSeq and rejects malformed cursors', () => {
    expect(sessionEventParams('/x?sessionId=s1&afterSeq=3')).toEqual({ sessionId: 's1', afterSeq: 3 })
    expect(sessionEventParams('/x?sessionId=s1')).toEqual({ sessionId: 's1', afterSeq: -1 })
    expect(() => sessionEventParams('/x')).toThrow(/sessionId/)
    expect(() => sessionEventParams('/x?sessionId=s1&afterSeq=-2')).toThrow(/afterSeq/)
  })

  it('emits ready + incremental timeline frames and resumes from afterSeq', async () => {
    const all = [
      { type: 'user/message', seq: 0, time: 1, data: { id: 'm0', content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: 'b' }] } } },
    ]
    let reads = 0
    const ctx = {
      get: (name: string) => name === 'sessionPersistence' ? {
        async stat() { return { eventCount: all.length } },
        async open() {
          return {
            async read(offset: number, length: number) { reads += 1; return { events: all.slice(offset, offset + length) } },
            async close() {},
          }
        },
      } : undefined,
    }
    const frames: { event: string; data: unknown }[] = []
    const controller = new AbortController()
    await streamSessionEvents(ctx as never, {
      sessionId: 's1',
      afterSeq: 0,
      signal: controller.signal,
      sink: {
        send(frame) { frames.push(frame); if (frame.event === 'timeline') controller.abort() },
        closed() { return controller.signal.aborted },
      },
    })
    expect(frames[0]).toMatchObject({ event: 'ready', data: { sessionId: 's1', afterSeq: 0 } })
    expect(frames[1]).toMatchObject({ event: 'timeline', data: { afterSeq: 1 } })
    expect(reads).toBeGreaterThan(0)
  })

  it('never replays entries at or below afterSeq', async () => {
    const all = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 2, data: { id: 'm1', content: [{ type: 'text', text: 'a' }], source: { kind: 'user' } } },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: 'stop' } },
      { type: 'turn/start', seq: 3, time: 4, data: { turn: 2 } },
    ]
    const ctx = {
      get: (name: string) => name === 'sessionPersistence' ? {
        async stat() { return { eventCount: all.length } },
        async open() { return { async read(offset: number, length: number) { return { events: all.slice(offset, offset + length) } }, async close() {} } },
      } : undefined,
    }
    const frames: { event: string; data: unknown }[] = []
    const controller = new AbortController()
    await streamSessionEvents(ctx as never, {
      sessionId: 's1', afterSeq: 1, signal: controller.signal,
      sink: { send(frame) { frames.push(frame); if (frame.event === 'timeline') controller.abort() }, closed() { return controller.signal.aborted } },
    })
    const timeline = frames.find(frame => frame.event === 'timeline')
    expect(timeline?.data).toMatchObject({ afterSeq: 3 })
    expect((timeline?.data as { entries: { seq: number }[] }).entries.every(entry => entry.seq > 1)).toBe(true)
  })
})
