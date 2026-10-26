import { describe, expect, it, vi } from 'vitest'
import { BOOTSTRAP_SCRIPT } from '../src/server-plugin/embed.ts'

class FakeStorage {
  readonly data = new Map<string, string>()
  get length(): number { return this.data.size }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null }
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void { this.data.set(key, value) }
  removeItem(key: string): void { this.data.delete(key) }
  clear(): void { this.data.clear() }
}

function page(prefix = 'dshrw:p:') {
  const localStorage = new FakeStorage()
  const sessionStorage = new FakeStorage()
  const window: Record<string, unknown> = {
    location: { origin: 'http://127.0.0.1:3000', search: '' },
    localStorage,
    sessionStorage,
    addEventListener: () => {},
    parent: undefined,
    __DSH_RW_EMBED__: { protocol: 1, storagePrefix: prefix, embedCssPath: 'dsh-remote-workspace-server/embed/embed.css' },
  }
  window['parent'] = window
  const clicks: string[] = []
  const dialog = {
    querySelectorAll: () => [{ textContent: '继续', click: () => { clicks.push('continue') } }],
  }
  const document = {
    documentElement: { setAttribute: () => {} },
    head: { appendChild: () => {} },
    createElement: () => ({ rel: '', href: '' }),
    querySelectorAll: () => [dialog],
  }
  return { window, document, localStorage, sessionStorage, clicks }
}

function inject(context: ReturnType<typeof page>): void {
  const run = new Function('window', 'document', 'URLSearchParams', BOOTSTRAP_SCRIPT) as (
    window: unknown, document: unknown, params: typeof URLSearchParams,
  ) => void
  run(context.window, context.document, URLSearchParams)
}

describe('embed storage shim', () => {
  it('prefixes exactly once and is idempotent across repeated injection', () => {
    const context = page()
    inject(context)
    inject(context)
    const local = context.window['localStorage'] as FakeStorage
    local.setItem('dsh.sessions.current', '{"sessionId":"s1"}')
    expect(context.localStorage.data.get('dshrw:p:dsh.sessions.current')).toBe('{"sessionId":"s1"}')
    expect([...context.localStorage.data.keys()]).toEqual(['dshrw:p:dsh.sessions.current'])
    expect(local.getItem('dsh.sessions.current')).toBe('{"sessionId":"s1"}')
  })

  it('dismisses the preview notice once when dshRwSession is present', () => {
    vi.useFakeTimers()
    try {
      const context = page()
      ;(context.window['location'] as { search: string }).search = '?dshRwSession=session-1'
      inject(context)
      vi.advanceTimersByTime(300)
      expect(context.clicks).toEqual(['continue'])
      vi.advanceTimersByTime(500)
      expect(context.clicks).toEqual(['continue'])
    } finally { vi.useRealTimers() }
  })

  it('keys/length/clear stay prefix-scoped per storage', () => {
    const context = page()
    context.localStorage.data.set('dshrw:p:a', '1')
    context.localStorage.data.set('other', '2')
    context.sessionStorage.data.set('dshrw:p:b', '3')
    inject(context)
    const local = context.window['localStorage'] as FakeStorage
    const session = context.window['sessionStorage'] as FakeStorage
    expect(local.length).toBe(1)
    expect(session.length).toBe(1)
    expect(local.key(0)).toBe('a')
    expect(session.key(0)).toBe('b')
    expect(local.key(1)).toBeNull()
    local.clear()
    expect(context.localStorage.data.has('other')).toBe(true)
    expect(context.localStorage.data.has('dshrw:p:a')).toBe(false)
    expect(session.length).toBe(1)
  })
})
