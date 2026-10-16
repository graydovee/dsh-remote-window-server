import { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import { describe, expect, it } from 'vitest'
import { RemoteSessionStore } from '../src/server/session-store.ts'

const header = (id: string, cwd: string): SessionHeader => ({
  id: id as never,
  cwd,
  version: 4 as never,
  createdAt: 1,
  isSeeded: false,
})

describe('RemoteSessionStore', () => {
  it('projects official persistence records into stable remote workspaces', async () => {
    const persistence = {
      list: async () => [{ header: header('s1', '/srv/project'), revision: 'r1' as never, sizeBytes: 12 }],
    }
    const ctx = { get: (name: string) => name === 'sessionPersistence' ? persistence : undefined } as unknown as Context
    const store = new RemoteSessionStore(ctx, 'server-a', 'install-a')
    const workspace = await store.createWorkspace('/srv/project', 'Project')
    const listed = await store.listWorkspaces()
    expect(listed).toEqual([{ ...workspace, sessionCount: 1 }])
    await expect(store.listSessions(workspace.id)).resolves.toEqual([{
      id: 's1',
      header: header('s1', '/srv/project'),
      sizeBytes: 12,
      createdAt: 1,
      cwd: '/srv/project',
    }])
  })

  it('folds the latest session/title event and reports the last activity time', async () => {
    // The title lives in the log as a projection event this profile does not
    // mount; the client dsh writes it, so reading is the only way to learn it.
    const opened: string[] = []
    const events = [
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
      { type: 'session/title', seq: 1, time: 20, data: { title: 'first title', messageSeqs: [], source: 'fallback' } },
      { type: 'session/title', seq: 2, time: 30, data: { title: 'renamed by the user', messageSeqs: [], source: 'user' } },
    ]
    const sizes = new Map([['s1', 42], ['s2', 7]])
    const persistence = {
      list: async () => [...sizes].map(([id, sizeBytes]) => ({
        header: header(id, '/srv/project'),
        revision: `r-${String(sizeBytes)}` as never,
        sizeBytes,
      })),
      open: async (id: string) => {
        opened.push(id)
        return {
          read: async () => ({ eventState: 'detached', events: id === 's1' ? events : [{ type: 'turn/start', seq: 0, time: 5, data: { turn: 1 } }] }),
          close: async () => {},
        }
      },
    }
    const ctx = { get: (name: string) => name === 'sessionPersistence' ? persistence : undefined } as unknown as Context
    const store = new RemoteSessionStore(ctx, 'server-a', 'install-a')
    const workspace = await store.createWorkspace('/srv/project', 'Project')
    await expect(store.titles(workspace.id)).resolves.toEqual([
      { id: 's1', title: 'renamed by the user', updatedAt: 30 },
      { id: 's2', title: '', updatedAt: 5 },
    ])
    // A second call with unchanged artifacts must not re-read the logs.
    opened.length = 0
    await store.titles(workspace.id)
    expect(opened).toEqual([])
    // A grown artifact invalidates only its own entry.
    sizes.set('s1', 99)
    await store.titles(workspace.id)
    expect(opened).toEqual(['s1'])
  })

  it('keeps a session whose log cannot be read in the titles result', async () => {
    const persistence = {
      list: async () => [{ header: header('s1', '/srv/project'), revision: 'r1' as never, sizeBytes: 5 }],
      open: async () => { throw new Error('session persistence holds no such session') },
    }
    const ctx = { get: (name: string) => name === 'sessionPersistence' ? persistence : undefined } as unknown as Context
    const store = new RemoteSessionStore(ctx, 'server-a', 'install-a')
    const workspace = await store.createWorkspace('/srv/project', 'Project')
    await expect(store.titles(workspace.id)).resolves.toEqual([{ id: 's1', title: '' }])
  })

  it('does not wrap official write ownership errors', async () => {
    const persistence = {
      list: async () => [],
      open: async () => { throw new SessionAlreadyOwnedError('s1' as never) },
    }
    const ctx = { get: (name: string) => name === 'sessionPersistence' ? persistence : undefined } as unknown as Context
    const store = new RemoteSessionStore(ctx, 'server-a', 'install-a')
    const workspace = await store.createWorkspace('/srv/project', 'Project')
    await expect(store.openSession(workspace.id, 's1' as never, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
  })
})
