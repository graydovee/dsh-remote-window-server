import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { listDirectory } from '../src/server-plugin/fs-api.ts'

function harness(entries: readonly { name: string; type: string }[]) {
  const ctx = {
    get: (name: string) => name === 'fs' ? {
      async resolve(path: string) { return { targetKey: path } },
      processPath(target: { targetKey?: string }) { return target.targetKey ?? '/' },
      async listDir() { return entries },
    } : undefined,
  }
  return ctx as never
}

describe('P1 fs/list directory browser', () => {
  it('maps official entries, sorts directories first, and reports parent', async () => {
    const result = await listDirectory(harness([
      { name: 'zeta.txt', type: 'file' },
      { name: 'alpha', type: 'directory' },
      { name: 'beta', type: 'directory' },
      { name: 'pipe', type: 'symlink' },
    ]), { path: '/home/user/work' })
    expect(result.home).toBe(homedir())
    expect(result.path).toBe('/home/user/work')
    expect(result.parent).toBe('/home/user')
    expect(result.entries).toEqual([
      { name: 'alpha', type: 'directory' },
      { name: 'beta', type: 'directory' },
      { name: 'pipe', type: 'other' },
      { name: 'zeta.txt', type: 'file' },
    ])
  })

  it('defaults to home and the filesystem root has no parent', async () => {
    const root = await listDirectory(harness([]), { path: '/' })
    expect(root.home).toBe(homedir())
    expect(root.parent).toBeNull()
    const home = await listDirectory(harness([]), {})
    expect(home.path).toBe(homedir())
  })
})
