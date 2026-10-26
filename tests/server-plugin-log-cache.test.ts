import { describe, expect, it, vi } from 'vitest'
import { EVENT_COUNT_DECODE_MAX_BYTES, EVENT_COUNT_DECODE_WARN_BYTES, SessionLogCache } from '../src/server-plugin/session-log-cache.ts'

describe('shared session log cache', () => {
  it('keys facts and event count by (sessionId, sizeBytes) and invalidates per session', () => {
    const cache = new SessionLogCache()
    const facts = { title: 't', titleSource: 'log' as const, blank: false, updatedAt: 1 }
    cache.rememberFacts('s1', 10, facts, 4)
    expect(cache.get('s1', 10)).toMatchObject({ eventCount: 4, facts })
    expect(cache.get('s1', 11)).toBeUndefined()
    cache.rememberCount('s1', 11, 5, facts)
    cache.invalidate('s1')
    expect(cache.get('s1', 10)).toBeUndefined()
    expect(cache.get('s1', 11)).toBeUndefined()
  })

  it('refuses above the ceiling and warns once above the soft limit', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const cache = new SessionLogCache()
      expect(() => cache.allowDecode('s1', EVENT_COUNT_DECODE_MAX_BYTES + 1)).toThrowError(/safety ceiling/)
      cache.allowDecode('s2', EVENT_COUNT_DECODE_WARN_BYTES + 1)
      cache.allowDecode('s2', EVENT_COUNT_DECODE_WARN_BYTES + 1)
      expect(warn.mock.calls.filter(call => String(call[0]).includes('session facts'))).toHaveLength(1)
    } finally { warn.mockRestore() }
  })
})
