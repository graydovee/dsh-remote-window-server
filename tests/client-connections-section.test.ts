/**
 * Pure parts of the server profile's connection panel (protocol §16.14).
 *
 * The React components need a browser module table this repository does not
 * install, so the contract they rely on is asserted here through the DOM-free
 * modules: the read URL, the envelope parser, row selection, row copy, the
 * locale fallback and the three command builders the client page executes.
 */
import { describe, expect, it } from 'vitest'
import { parseRwPortalCommand, rwPortalClosePortal, rwPortalOpenConnectDialog, rwPortalSwitchTarget } from '../src/protocol.ts'
import {
  isEmbedded, portalCommandTarget, requestClosePortal, requestNewConnection, switchToTarget,
} from '../src/client/commands.ts'
import { createTargetsFeed } from '../src/client/data.ts'
import { adoptDocumentLocale, en, getLocale, localeOf, t, zh } from '../src/client/locales.ts'
import {
  CLIENT_TARGETS_ROUTE, emptySnapshot, formatEndpoint, parseTargetsValue, phaseLabel,
  selectActiveTargetId, targetsRequestPath,
} from '../src/client/targets-model.ts'

/** A published snapshot with the two row kinds. */
function snapshot() {
  return {
    clientId: 'client-abc',
    updatedAt: 42,
    activeTargetId: 't1',
    targets: [
      { targetId: 't1', label: 'dev-box', kind: 'ssh', host: '203.0.113.10', port: 22, username: 'tester', phase: 'ready', active: true },
      { targetId: 't2', label: 'wsl-box', kind: 'wsl', host: 'Ubuntu', phase: 'stopped' },
    ],
  }
}

/** The envelopes the profile route can answer with. */
function envelope(value: unknown): unknown {
  return { ok: true, value }
}

describe('connection list read path', () => {
  it('stays a profile-relative URL so the portal mount is preserved', () => {
    expect(CLIENT_TARGETS_ROUTE).toBe('dsh-remote-workspace-server/api/client/targets')
    expect(targetsRequestPath()).toBe(CLIENT_TARGETS_ROUTE)
    expect(targetsRequestPath().startsWith('/')).toBe(false)
  })

  it('reads the P1 envelope and the bare value alike', () => {
    expect(parseTargetsValue(envelope(snapshot()))?.targets).toHaveLength(2)
    expect(parseTargetsValue(snapshot())?.updatedAt).toBe(42)
  })

  it('serves the empty snapshot as an empty list, not a failure', () => {
    const parsed = parseTargetsValue(envelope({ clientId: '', updatedAt: 0, targets: [] }))
    expect(parsed).toEqual({ clientId: '', updatedAt: 0, targets: [] })
    expect(parsed?.targets).toEqual([])
    expect(emptySnapshot()).toEqual({ clientId: '', updatedAt: 0, targets: [] })
  })

  it('drops unreadable rows and rejects a payload without a targets array', () => {
    const parsed = parseTargetsValue(envelope({
      clientId: 'c',
      updatedAt: 1,
      targets: [
        { targetId: 'ok', label: 'ok', kind: 'ssh', phase: 'ready' },
        { targetId: 'no-kind', label: 'x', phase: 'ready' },
        { targetId: 'bad-phase', label: 'x', kind: 'wsl', phase: 'exploded' },
        { label: 'no id', kind: 'ssh', phase: 'ready' },
      ],
    }))
    expect(parsed?.targets.map(row => row.targetId)).toEqual(['ok'])
    expect(parseTargetsValue({ ok: true, value: { updatedAt: 1 } })).toBeUndefined()
    expect(parseTargetsValue('nope')).toBeUndefined()
    expect(parseTargetsValue({ ok: false, error: { code: 'internal' } })).toBeUndefined()
  })

  it('falls back to the target id when the label is empty', () => {
    const parsed = parseTargetsValue(envelope({
      updatedAt: 1,
      targets: [{ targetId: 't9', label: '', kind: 'ssh', phase: 'ready' }],
    }))
    expect(parsed?.targets[0]?.label).toBe('t9')
  })
})

describe('active row selection', () => {
  it('lets the frame query name the highlighted row and falls back to the snapshot', () => {
    const value = parseTargetsValue(envelope(snapshot()))!
    expect(selectActiveTargetId(value, '?dshRwTarget=t2')).toBe('t2')
    expect(selectActiveTargetId(value, '?dshRwSession=s1&dshRwTarget=t2')).toBe('t2')
    expect(selectActiveTargetId(value, '')).toBe('t1')
    expect(selectActiveTargetId(value, '?dshRwTarget=')).toBe('t1')
    expect(selectActiveTargetId(emptySnapshot(), '')).toBeUndefined()
  })
})

describe('row copy', () => {
  it('renders user@host:port for ssh and the distribution for WSL', () => {
    adoptDocumentLocale('zh')
    const value = parseTargetsValue(envelope(snapshot()))!
    expect(formatEndpoint(value.targets[0]!)).toBe('tester@203.0.113.10:22')
    expect(formatEndpoint(value.targets[1]!)).toBe('WSL · Ubuntu')
    expect(formatEndpoint({ targetId: 'x', label: 'x', kind: 'wsl', phase: 'ready' })).toBe('WSL')
    expect(formatEndpoint({ targetId: 'x', label: 'x', kind: 'ssh', host: '203.0.113.10', phase: 'ready' })).toBe('203.0.113.10')
  })

  it('localizes the phase, including after switching to English', () => {
    adoptDocumentLocale('zh')
    expect(phaseLabel('ready')).toBe('已连接')
    adoptDocumentLocale('en-US')
    expect(phaseLabel('ready')).toBe('Connected')
    expect(phaseLabel('degraded')).toBe('Connected (limited)')
    adoptDocumentLocale('zh')
  })
})

describe('locale selection', () => {
  it('defaults to zh and treats only an en prefix as English', () => {
    expect(localeOf(undefined)).toBe('zh')
    expect(localeOf('')).toBe('zh')
    expect(localeOf('zh-CN')).toBe('zh')
    expect(localeOf('en-US')).toBe('en')
    expect(localeOf('EN')).toBe('en')
    expect(localeOf('fr-FR')).toBe('zh')
  })

  it('ships both dictionaries with identical key sets', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('keeps an unknown placeholder and resolves known ones', () => {
    adoptDocumentLocale('zh')
    expect(getLocale()).toBe('zh')
    expect(t('connections.activate', { label: 'dev-box' })).toBe('切换到 dev-box')
    expect(t('connections.activate', {})).toBe('切换到 {label}')
    expect(t('connections.endpoint', { username: 'tester', host: '203.0.113.10', port: 22 })).toBe('tester@203.0.113.10:22')
  })
})

describe('portal commands', () => {
  it('posts the versioned switch/open/close commands to the pinned parent origin', () => {
    const posted: Array<{ data: unknown; origin: string }> = []
    const target = portalCommandTarget({
      parent: { postMessage: (data: unknown, origin: string) => { posted.push({ data, origin }) } },
      location: { origin: 'http://127.0.0.1:3000' },
    })
    expect(target).toBeDefined()
    expect(switchToTarget('t2', target)).toBe(true)
    expect(requestNewConnection(target)).toBe(true)
    expect(requestClosePortal(target)).toBe(true)
    expect(posted).toEqual([
      { data: rwPortalSwitchTarget('t2'), origin: 'http://127.0.0.1:3000' },
      { data: rwPortalOpenConnectDialog(), origin: 'http://127.0.0.1:3000' },
      { data: rwPortalClosePortal(), origin: 'http://127.0.0.1:3000' },
    ])
    // The client page validates exactly this vocabulary.
    expect(parseRwPortalCommand(posted[0]?.data)).toEqual({ v: 1, type: 'dsh-rw/switch-target', targetId: 't2' })
    expect(parseRwPortalCommand(posted[1]?.data)).toEqual({ v: 1, type: 'dsh-rw/open-connect-dialog' })
    expect(parseRwPortalCommand(posted[2]?.data)).toEqual({ v: 1, type: 'dsh-rw/close-portal' })
  })

  it('drops every command when the profile UI was opened directly', () => {
    const self: { parent?: unknown; location?: { origin?: string } } = { location: { origin: 'http://127.0.0.1:3000' } }
    self.parent = self
    expect(isEmbedded(self)).toBe(false)
    expect(portalCommandTarget(self)).toBeUndefined()
    expect(switchToTarget('t2', undefined)).toBe(false)
    expect(requestNewConnection(undefined)).toBe(false)
    expect(requestClosePortal(undefined)).toBe(false)
  })

  it('refuses an empty target id and an origin-less page', () => {
    const posted: unknown[] = []
    const target = portalCommandTarget({
      parent: { postMessage: (data: unknown) => { posted.push(data) } },
      location: { origin: 'http://127.0.0.1:3000' },
    })
    expect(switchToTarget('', target)).toBe(false)
    expect(posted).toEqual([])
    expect(portalCommandTarget({ parent: { postMessage: () => {} } })).toBeUndefined()
  })
})

describe('snapshot feed', () => {
  it('keeps the previous list when a read fails and flags the sync', async () => {
    let fail = false
    const responses: Array<{ ok: boolean; status: number; json(): Promise<unknown> }> = [
      { ok: true, status: 200, json: async () => envelope(snapshot()) },
      { ok: false, status: 503, json: async () => ({ ok: false }) },
      { ok: true, status: 200, json: async () => ({ ok: true, value: { updatedAt: 1, targets: 'nope' } }) },
    ]
    const feed = createTargetsFeed({
      fetch: async () => {
        const next = responses.shift()
        if (next === undefined || fail) return { ok: false, status: 500, json: async () => ({}) }
        return next
      },
    })
    const stop = feed.start()
    try {
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(feed.snapshot().sync).toBe('ok')
      expect(feed.snapshot().snapshot.targets).toHaveLength(2)

      feed.refresh()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(feed.snapshot().sync).toBe('stale')
      // The failed read must not blank the list.
      expect(feed.snapshot().snapshot.targets).toHaveLength(2)
      expect(feed.snapshot().loaded).toBe(true)

      feed.refresh()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(feed.snapshot().sync).toBe('stale')
      expect(feed.snapshot().snapshot.targets).toHaveLength(2)
      fail = true
    } finally {
      stop()
    }
  })
})
