import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BOOTSTRAP_SCRIPT, EMBED_CSS } from '../src/server-plugin/embed.ts'
import { apply } from '../src/server-plugin/index.ts'
import { RW_PATHS } from '../src/protocol.ts'

class FakeStorage {
  readonly data = new Map<string, string>()
  get length(): number { return this.data.size }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null }
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void { this.data.set(key, value) }
  removeItem(key: string): void { this.data.delete(key) }
  clear(): void { this.data.clear() }
}

interface PageOptions {
  readonly prefix?: string
  readonly search?: string
  /** Give the page a distinct parent window so the ready message is observable. */
  readonly detachedParent?: boolean
}

function page(options: PageOptions = {}) {
  const localStorage = new FakeStorage()
  const sessionStorage = new FakeStorage()
  const attributes = new Map<string, string>()
  const appended: unknown[] = []
  const created: Array<Record<string, string>> = []
  const posts: Array<{ data: unknown; origin: string }> = []
  const config: Record<string, unknown> = {
    protocol: 1,
    storagePrefix: options.prefix ?? 'dshrw:p:',
    embedCssPath: 'dsh-remote-workspace-server/embed/embed.css',
  }
  const parent = { postMessage: (data: unknown, origin: string) => { posts.push({ data, origin }) } }
  const window: Record<string, unknown> = {
    location: { origin: 'http://127.0.0.1:3000', search: options.search ?? '' },
    localStorage,
    sessionStorage,
    addEventListener: () => {},
    __DSH_RW_EMBED__: config,
  }
  window['parent'] = options.detachedParent === true ? parent : window
  const clicks: string[] = []
  const dialog = {
    querySelectorAll: () => [{ textContent: '继续', click: () => { clicks.push('continue') } }],
  }
  const document = {
    documentElement: {
      setAttribute: (name: string, value: string) => { attributes.set(name, value) },
      getAttribute: (name: string) => attributes.get(name) ?? null,
    },
    head: { appendChild: (node: unknown) => { appended.push(node) } },
    createElement: () => {
      const node: Record<string, string> = { rel: '', href: '' }
      created.push(node)
      return node
    },
    querySelectorAll: () => [dialog],
  }
  return { window, document, localStorage, sessionStorage, clicks, attributes, appended, created, posts, config }
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
      const context = page({ search: '?dshRwSession=session-1' })
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

describe('embed bootstrap', () => {
  it('marks full mode for dshRwFull=1 and the full=1 fallback', () => {
    for (const search of [
      '?dshRwFull=1',
      '?full=1',
      '?dshRwSession=s1&dshRwFull=1&dshRwTheme=dark',
      '?dshRwWorkspace=w1&full=1',
    ]) {
      const context = page({ search })
      inject(context)
      expect(context.attributes.get('data-dsh-rw-embed')).toBe('')
      expect(context.attributes.get('data-dsh-rw-full')).toBe('')
    }
  })

  it('leaves full mode off unless the flag is exactly 1', () => {
    for (const search of [
      '',
      '?dshRwSession=s1',
      '?dshRwFull=0',
      '?full=0',
      '?full=true',
      '?dshRwFull=yes',
    ]) {
      const context = page({ search })
      inject(context)
      expect(context.attributes.get('data-dsh-rw-embed')).toBe('')
      expect(context.attributes.has('data-dsh-rw-full')).toBe(false)
    }
  })

  it('still applies the theme/language hints in full mode', () => {
    const context = page({ search: '?dshRwTheme=dark&dshRwLang=zh-CN&dshRwFull=1' })
    inject(context)
    expect(context.attributes.get('data-theme')).toBe('dark')
    expect(context.attributes.get('lang')).toBe('zh-CN')
  })

  it('still posts the ready message to the parent origin', () => {
    const context = page({ search: '?dshRwFull=1', detachedParent: true })
    inject(context)
    expect(context.posts).toEqual([{ data: { v: 1, type: 'dsh-rw/ready' }, origin: 'http://127.0.0.1:3000' }])
  })

  it('honours the configured dshRwParent origin for the ready message', () => {
    const context = page({ detachedParent: true })
    context.config['parentOrigin'] = 'https://client.example'
    inject(context)
    expect(context.posts).toEqual([{ data: { v: 1, type: 'dsh-rw/ready' }, origin: 'https://client.example' }])
  })

  it('injects the embed stylesheet exactly once across repeated injection', () => {
    const context = page({ search: '?dshRwFull=1' })
    inject(context)
    inject(context)
    expect(context.created).toHaveLength(1)
    expect(context.appended).toHaveLength(1)
    expect(context.created[0]).toMatchObject({
      rel: 'stylesheet',
      href: 'dsh-remote-workspace-server/embed/embed.css',
    })
  })

  it('is a static, secret-free script with the dismissal helper inlined', () => {
    expect(BOOTSTRAP_SCRIPT).not.toContain('__DISMISS_ONBOARDING__')
    expect(BOOTSTRAP_SCRIPT).not.toMatch(/Bearer|dsh-auth|token=|password/i)
  })
})

/** One CSS rule: its selector list and declaration body. */
interface CssRule {
  readonly selectors: readonly string[]
  readonly body: string
}

function cssRules(css: string): CssRule[] {
  const rules: CssRule[] = []
  for (const chunk of css.split('}')) {
    const brace = chunk.indexOf('{')
    if (brace === -1) continue
    const selectors = chunk.slice(0, brace).split(',')
      .map(selector => selector.trim())
      .filter(selector => selector !== '')
    rules.push({ selectors, body: chunk.slice(brace + 1).trim() })
  }
  return rules
}

/** The ancestor every non-full embed rule must require. */
const EMBED_ANCESTOR = 'html[data-dsh-rw-embed]'
/** Full mode keeps the complete official shell, so all embed rules exclude it. */
const HIDE_ANCESTOR = `${EMBED_ANCESTOR}:not([data-dsh-rw-full])`

describe('embed CSS', () => {
  it('hides the official sidebar/rightbar/bottom slot and collapses the root grid only for non-full embeds', () => {
    const rules = cssRules(EMBED_CSS)
    expect(rules.flatMap(rule => rule.selectors)).toEqual([
      `${HIDE_ANCESTOR} [data-slot="sidebar"]`,
      `${HIDE_ANCESTOR} [data-slot="sidebar"] *`,
      `${HIDE_ANCESTOR} [data-slot="rightbar"]`,
      `${HIDE_ANCESTOR} [data-slot="rightbar"] *`,
      `${HIDE_ANCESTOR} [data-slot="shell.bottom"]`,
      `${HIDE_ANCESTOR} [data-slot="root"] > div > div`,
    ])
    for (const rule of rules.slice(0, -1)) expect(rule.body).toBe('display: none !important;')
    expect(rules.at(-1)?.body).toBe('grid-template-columns: minmax(0, 1fr) !important;')
  })

  it('gates every rule behind the full-mode exclusion so full mode keeps the official shell', () => {
    const rules = cssRules(EMBED_CSS)
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      for (const selector of rule.selectors) expect(selector.startsWith(HIDE_ANCESTOR)).toBe(true)
    }
    // In full mode `<html>` carries data-dsh-rw-full, so no rule above matches;
    // in particular the `[data-slot="root"]` grid keeps the official tracks.
  })
})

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

interface FakeRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: unknown, res: FakeResponse) => unknown
}

/** Run the real plugin `apply` against a stub host context. */
function installPlugin(): {
  readonly routes: Map<string, FakeRoute>
  readonly taps: Array<(html: string) => string>
  cleanup(): void
} {
  const routes = new Map<string, FakeRoute>()
  const taps: Array<(html: string) => string> = []
  const webServer = {
    port: 4242,
    register(route: unknown): () => void {
      const record = route as FakeRoute
      routes.set(record.path, record)
      return () => {}
    },
    registerUpgrade(): () => void { return () => {} },
    tapIndex(transform: unknown): () => void {
      taps.push(transform as (html: string) => string)
      return () => {}
    },
  }
  const home = mkdtempSync(join(tmpdir(), 'dsh-rw-embed-'))
  const ctx: Record<string, unknown> = {}
  ctx['get'] = (service: string) => (service === 'webServer' ? webServer : undefined)
  ctx['effect'] = (callback: () => unknown) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  }
  ctx['inject'] = (_deps: string[], callback: (scope: unknown) => void) => {
    callback(ctx)
    return () => {}
  }
  apply(ctx as never, { profile: 'profile-x', home })
  return { routes, taps, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

describe('embed route wiring', () => {
  it('serves the bootstrap/CSS routes and injects them into the index exactly once', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = installPlugin()
    try {
      const bootstrap = new FakeResponse()
      await harness.routes.get(RW_PATHS.bootstrap)?.handler({}, bootstrap)
      expect(bootstrap.status).toBe(200)
      expect(bootstrap.headers['content-type']).toContain('text/javascript')
      expect(bootstrap.body).toBe(BOOTSTRAP_SCRIPT)

      const css = new FakeResponse()
      await harness.routes.get(RW_PATHS.embedCss)?.handler({}, css)
      expect(css.status).toBe(200)
      expect(css.headers['content-type']).toContain('text/css')
      expect(css.body).toBe(EMBED_CSS)

      expect(harness.taps).toHaveLength(1)
      const tap = harness.taps[0]!
      const html = '<html><head><title>DSH</title></head><body></body></html>'
      const injected = tap(html)
      expect(injected.match(/__DSH_RW_EMBED__/gu)).toHaveLength(1)
      expect(injected.match(/embed\/bootstrap\.js/gu)).toHaveLength(1)
      expect(injected).toContain('"storagePrefix":"dshrw:profile-x:"')
      expect(injected.indexOf('__DSH_RW_EMBED__')).toBeLessThan(injected.indexOf('embed/bootstrap.js'))
      // The injected document is left alone when the index transform runs again.
      expect(tap(injected)).toBe(injected)
    } finally {
      harness.cleanup()
      errorSpy.mockRestore()
    }
  })
})
