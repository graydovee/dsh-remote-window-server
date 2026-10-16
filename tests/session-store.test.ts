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
