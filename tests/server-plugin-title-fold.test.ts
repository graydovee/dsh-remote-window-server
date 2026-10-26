import { describe, expect, it } from 'vitest'
import { foldFacts, resolveBlank } from '../src/server-plugin/title-fold.ts'

describe('JSONL title fold', () => {
  it('uses the last session/title and detects turn/start', () => {
    const facts = foldFacts([
      { type: 'session/title', time: 10, data: { title: 'first' } },
      { type: 'turn/start', time: 20 },
      { type: 'session/title', time: 30, data: { title: 'second' } },
    ])
    expect(facts).toEqual({ title: 'second', titleSource: 'log', blank: false, updatedAt: 30 })
  })

  it('reports a blank session with a fallback title', () => {
    expect(foldFacts([{ type: 'session/start', time: 5 }])).toEqual({ titleSource: 'fallback', blank: true, updatedAt: 5 })
  })

  it('ignores malformed title payloads', () => {
    expect(foldFacts([{ type: 'session/title', time: 1, data: { title: 1 } }])).toEqual({ titleSource: 'fallback', blank: true, updatedAt: 1 })
  })
})

describe('session blank resolution', () => {
  it('trusts live projection metadata', () => {
    expect(resolveBlank(true, true, false, false)).toBe(true)
    expect(resolveBlank(false, true, true, true)).toBe(false)
  })

  it('folds cold rows instead of trusting the cold summary default', () => {
    expect(resolveBlank(undefined, false, false, true)).toBe(true)
    expect(resolveBlank(undefined, false, false, false)).toBe(false)
  })

  it('keeps live summary blank when no metadata is mounted', () => {
    expect(resolveBlank(undefined, true, true, false)).toBe(true)
  })
})
