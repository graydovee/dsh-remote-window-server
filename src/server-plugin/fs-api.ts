/** P1 directory browser backing the client's "add workspace" dialog (protocol §4.3). */
import { homedir } from 'node:os'
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { RwFsDirEntry, RwListDirResult } from '../protocol.ts'
import { PluginError } from './errors.ts'

interface FsTargetLike {
  readonly targetKey?: string
}

interface FileSystemLike {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTargetLike>
  processPath(target: FsTargetLike): string
  listDir(target: FsTargetLike, signal?: AbortSignal): Promise<readonly { readonly name: string; readonly type: string }[]>
}

/** One blocking page: official `ctx.fs.resolve` + `listDir`, no second path protocol. */
export async function listDirectory(ctx: Context, params: Record<string, unknown>): Promise<RwListDirResult> {
  const fs = ctx.get('fs') as FileSystemLike | undefined
  if (fs === undefined) throw new PluginError('fs-error', 'the profile has no fs service')
  const home = homedir()
  const requested = typeof params['path'] === 'string' && params['path'] !== '' ? params['path'] : home
  try {
    const target = await fs.resolve(requested, { cwd: home })
    const path = fs.processPath(target)
    const entries: RwFsDirEntry[] = (await fs.listDir(target)).map((entry): RwFsDirEntry => ({
      name: entry.name,
      type: entry.type === 'file' || entry.type === 'directory' ? entry.type : 'other',
    })).sort((left, right) => {
      if (left.type !== right.type) {
        if (left.type === 'directory') return -1
        if (right.type === 'directory') return 1
      }
      return left.name.localeCompare(right.name)
    })
    return {
      home,
      path,
      parent: path === '/' ? null : posix.dirname(path),
      entries,
    }
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw new PluginError('fs-error', error instanceof Error ? error.message : String(error), { path: requested })
  }
}
