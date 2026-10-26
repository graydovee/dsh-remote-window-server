import { describe, expect, it } from 'vitest'
import { normalizeTimeline, readTimeline, TIMELINE_MAX_TEXT_CHARS } from '../src/server-plugin/timeline.ts'

const events = [
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 2, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }] }, stream: [] } },
  { type: 'tool/call', seq: 3, time: 4, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"echo hi"}' } },
  { type: 'tool/result', seq: 4, time: 5, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'hi' }] } } },
  { type: 'approval/asked', seq: 5, time: 6, data: { id: 'ap1', toolName: 'bash', reason: 'needs write' } },
  { type: 'approval/decided', seq: 6, time: 7, data: { id: 'ap1', outcome: 'allowed-once' } },
  { type: 'turn/end', seq: 7, time: 8, data: { turn: 1, reason: { kind: 'stop' } } },
  { type: 'plugin/future', seq: 8, time: 9, data: {}, ignorable: true },
  { type: 'request/header', seq: 9, time: 10, data: { header: {} } },
]

describe('v2 timeline normalization', () => {
  it('renders user/assistant/reasoning/tool/turn/approval/unknown rows', () => {
    const rows = normalizeTimeline(events as never)
    expect(rows.map(row => row.kind)).toEqual(['turn', 'user', 'reasoning', 'assistant', 'tool-call', 'tool-result', 'approval', 'approval', 'turn', 'unknown'])
    expect(rows.find(row => row.kind === 'reasoning')).toMatchObject({ text: 'think' })
    expect(rows.find(row => row.kind === 'assistant')).toMatchObject({ text: 'answer' })
    expect(rows.find(row => row.kind === 'tool-result')).toMatchObject({ callId: 'c1', text: 'hi', isError: false })
    expect(rows.at(-1)).toMatchObject({ kind: 'unknown', type: 'plugin/future', ignorable: true })
  })

  it('truncates oversized tool output and marks the total size', () => {
    const huge = 'x'.repeat(TIMELINE_MAX_TEXT_CHARS + 20)
    const rows = normalizeTimeline([{ type: 'tool/result', seq: 1, time: 1, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: huge }] } } }] as never)
    expect(rows[0]).toMatchObject({ kind: 'tool-result', truncated: true, totalBytes: huge.length })
  })

  it('pages backward using beforeSeq and returns aliases', async () => {
    const opened: number[] = []
    const ctx = {
      get: (name: string) => name === 'sessionPersistence' ? {
        async stat() { return { eventCount: events.length } },
        async open() {
          return {
            async read(offset: number, length: number) { opened.push(offset); return { events: events.slice(offset, offset + length) } },
            async close() {},
          }
        },
      } : undefined,
    }
    const page = await readTimeline(ctx as never, { sessionId: 's1', beforeSeq: 5, limit: 2 })
    expect(opened).toEqual([0])
    expect(page.entries.map(row => row.seq)).toEqual([3, 4])
    expect(page.nextBeforeSeq).toBe(3)
    expect(page.afterSeq).toBe(-1)
    expect(page.eventCount).toBe(events.length)
  })
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

/** A tiny real-JSONL-shaped fixture: header line then one event per line. */
function jsonlEvents(events: readonly Record<string, unknown>[]): string {
  return `${JSON.stringify({ version: 4, id: 'session-fixture', createdAt: 1, isSeeded: false })}\n${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

function jsonlPersistence(path: string, eventCount: number) {
  return {
    async stat() { return { eventCount } },
    async open() {
      return {
        async read(offset: number, length: number) {
          const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(1)
          const events = lines.map(line => JSON.parse(line) as { seq: number })
          return { events: events.filter(event => event.seq >= offset && event.seq < offset + length) }
        },
        async close() {},
      }
    },
  }
}

describe('timeline against JSONL-shaped fixture', () => {
  const visible = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ...Array.from({ length: 4 }, (_, index) => ({ type: 'agent/inbox/spliced', seq: index + 1, time: 1 + index, data: {} })),
    { type: 'turn/start', seq: 5, time: 6, data: { turn: 2 } },
    ...Array.from({ length: 3 }, (_, index) => ({ type: 'request/header', seq: index + 6, time: 6 + index, data: { header: {} } })),
    { type: 'user/message', seq: 9, time: 10, data: { id: 'm1', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
    ...Array.from({ length: 6 }, (_, index) => ({ type: 'step/start', seq: index + 10, time: 10 + index, data: { turn: 1, step: 1 } })),
    { type: 'plugin/future', seq: 16, time: 17, data: {}, ignorable: true },
    { type: 'step/end', seq: 17, time: 18, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 18, time: 19, data: { turn: 1, reason: 'stop' } },
  ]
  let dir = ''
  let persistence: ReturnType<typeof jsonlPersistence>
  const ctx = () => ({ get: () => persistence }) as never

  it('returns the last two visible entries for limit:2 and pages by entry seq', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rw-timeline-jsonl-'))
    const path = join(dir, 'session.jsonl')
    await writeFile(path, jsonlEvents(visible))
    persistence = jsonlPersistence(path, visible.length)
    try {
      const page = await readTimeline(ctx(), { sessionId: 'session-fixture', limit: 2 })
      expect(page.entries.map(entry => entry.seq)).toEqual([16, 18])
      expect(page.nextBeforeSeq).toBe(16)
      const older = await readTimeline(ctx(), { sessionId: 'session-fixture', beforeSeq: 18, limit: 10 })
      expect(older.entries.map(entry => entry.seq)).toEqual([0, 5, 9, 16])
      expect(older.nextBeforeSeq).toBe(0)
      const newer = await readTimeline(ctx(), { sessionId: 'session-fixture', afterSeq: 14, limit: 10 })
      expect(newer.entries.map(entry => entry.seq)).toEqual([16, 18])
      expect(newer.nextAfterSeq).toBe(18)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('keeps entryId stable when the same event appears in different pages', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rw-timeline-jsonl-'))
    const path = join(dir, 'session.jsonl')
    await writeFile(path, jsonlEvents(visible))
    persistence = jsonlPersistence(path, visible.length)
    try {
      const first = await readTimeline(ctx(), { sessionId: 'session-fixture', beforeSeq: 19, limit: 10 })
      const second = await readTimeline(ctx(), { sessionId: 'session-fixture', afterSeq: 0, limit: 10 })
      for (const entry of first.entries) if (entry.seq !== 0) expect(second.entries.find(row => row.seq === entry.seq)?.entryId).toBe(entry.entryId)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('maps assistant/attempt failures to error entries', () => {
    const rows = normalizeTimeline([{ type: 'assistant/attempt', seq: 3, time: 1, data: { stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded', code: 'TRANSPORT' } } } }] } }] as never)
    expect(rows).toEqual([expect.objectContaining({ kind: 'error', message: 'provider exploded', code: 'TRANSPORT' })])
  })
})
