/**
 * Cross-process workspace registry write guard (protocol §16.4).
 *
 * The official registry is an in-process snapshot over a whole-file JSON unit.
 * This guard wraps the official prototypes so every write (plugin P1 and the
 * profile's own official UI) takes a cross-process lock and compares the file
 * revision before entering the official method.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { PluginError } from './errors.ts'
import { withFileLock } from './file-lock.ts'

interface RegistryLike {
  list(): EntityLike[]
  get(id: string): EntityLike | undefined
  create(path: string, title?: string): Promise<EntityLike>
  delete(id: string): Promise<boolean>
  insertBefore(id: string, beforeId?: string): Promise<readonly string[]>
  initializeDefault(resolve: () => Promise<string>): Promise<EntityLike | undefined>
  pinSession(id: string): Promise<void>
  unpinSession(id: string): Promise<void>
  archiveSession(id: string, options?: { stopActivity?: boolean }): Promise<void>
  unarchiveSession(id: string): Promise<void>
}

interface EntityLike {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly sessionIds: readonly string[]
  setTitle(title: string): Promise<void>
  attachSession(id: string): Promise<void>
  detachSession(id: string): Promise<void>
  insertSessionBefore(id: string, beforeId?: string): Promise<void>
}

interface LoaderEntryLike {
  readonly options: { readonly id: string; readonly name: string; readonly disabled?: boolean | null }
  update(options: { disabled?: boolean }): Promise<void>
}

interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
  await(): Promise<void>
}

interface GuardStatus {
  readonly revision: string
  readonly loadedRevision: string
  readonly epoch: string
  readonly stale: boolean
  readonly capability: 'prototype' | 'none'
  readonly reload: 'loader-disable-enable' | 'none'
}

const WRAPPED = Symbol.for('dsh-rw.registry-wrapper')
const GUARDED_WRITE = Symbol.for('dsh-rw.registry-guarded-write')

let activeGuard: RegistryGuard | undefined

/** Wrap one prototype method once, routing calls through the active guard. */
function wrapMethod(target: object, name: string): boolean {
  const holder = target as Record<string, unknown>
  const original = holder[name]
  if (typeof original !== 'function') return false
  if ((original as { [WRAPPED]?: boolean })[WRAPPED] === true) return true
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const guard = activeGuard
    if (guard === undefined || guard.disposed) return (original as (...a: unknown[]) => unknown).apply(this, args)
    const result = guard.write(() => (original as (...a: unknown[]) => unknown).apply(this, args))
    if (result !== null && typeof result === 'object' && typeof (result as PromiseLike<unknown>).then === 'function') {
      return (result as Promise<unknown>).then(value => { guard.wrapEntityValue(value); return value })
    }
    guard.wrapEntityValue(result)
    return result
  }
  Object.defineProperty(wrapped, WRAPPED, { value: true })
  holder[name] = wrapped
  return true
}

/** One guard per active workspace registry service. */
export class RegistryGuard {
  private loadedRevision = 'uninitialized'
  private currentRevision = 'uninitialized'
  private epochValue = 0
  private changed = false
  private tail: Promise<unknown> = Promise.resolve()
  private wrapped = false
  private reloadAvailable = false
  disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly registryFile: string,
    private readonly lockTarget: string,
  ) {}

  private async revision(): Promise<string> {
    try {
      return createHash('sha256').update(await readFile(this.registryFile)).digest('hex')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
      throw error
    }
  }

  /** Install prototype wrappers and seed the loaded revision. */
  async install(): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry') as RegistryLike | undefined
    if (registry === undefined) return
    activeGuard = this
    this.loadedRevision = await this.revision()
    this.currentRevision = this.loadedRevision
    const registryProto = Object.getPrototypeOf(registry) as object
    const writes = ['create', 'delete', 'insertBefore', 'initializeDefault', 'pinSession', 'unpinSession', 'archiveSession', 'unarchiveSession']
    let wrapped = 0
    for (const method of writes) if (wrapMethod(registryProto, method)) wrapped += 1
    const entities = registry.list()
    const first = entities[0]
    if (first === undefined && registry instanceof Object) {
      // No workspace yet: discover the entity prototype lazily from every
      // registry read/create result (marked reads are not guarded writes).
      for (const method of ['list', 'get', 'create']) {
        const proto = Object.getPrototypeOf(registry) as Record<string, unknown>
        const original = proto[method]
        if (typeof original !== 'function' || (original as { [WRAPPED]?: boolean })[WRAPPED] === true) continue
        const wrappedRead = function (this: unknown, ...args: unknown[]): unknown {
          const value = (original as (...a: unknown[]) => unknown).apply(this, args)
          const guard = activeGuard
          if (guard !== undefined) {
            if (Array.isArray(value)) { const item = value[0]; if (item !== undefined) guard.wrapEntity(item as EntityLike) }
            else if (value instanceof Promise) void value.then(item => { if (item !== undefined) guard.wrapEntity(item as EntityLike) }).catch(() => {})
            else if (value !== undefined && value !== null) guard.wrapEntity(value as EntityLike)
          }
          return value
        }
        Object.defineProperty(wrappedRead, WRAPPED, { value: true })
        proto[method] = wrappedRead
      }
    } else if (first !== undefined) {
      this.wrapEntity(first)
    }
    this.reloadAvailable = this.findWorkspaceEntry() !== undefined
    this.wrapped = wrapped > 0
  }

  /** Wrap the prototype of a created/listed entity (idempotent). */
  wrapEntityValue(value: unknown): void {
    if (value === null || typeof value !== 'object') return
    const candidate = value as Partial<EntityLike>
    if (typeof candidate.id !== 'string' || typeof candidate.setTitle !== 'function') return
    this.wrapEntity(candidate as EntityLike)
  }

  /** Wrap one entity's prototype (once). */
  wrapEntity(entity: EntityLike): void {
    const proto = Object.getPrototypeOf(entity) as object
    for (const method of ['setTitle', 'attachSession', 'detachSession', 'insertSessionBefore']) wrapMethod(proto, method)
  }

  /** Serialize a write through the cross-process lock and revision check. */
  write<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.serial(async () => await withFileLock(this.lockTarget, async () => {
      if (this.loadedRevision === 'uninitialized') this.loadedRevision = await this.revision()
      const current = await this.revision()
      this.currentRevision = current
      if (current !== this.loadedRevision) {
        this.changed = true
        throw new PluginError('registry-stale', 'the server workspace registry changed since this profile loaded it; refresh/reconnect before writing', { loadedRevision: this.loadedRevision, currentRevision: current })
      }
      const result = await operation()
      this.loadedRevision = await this.revision()
      this.currentRevision = this.loadedRevision
      this.changed = false
      return result
    }))
  }

  /** Probe the file revision without writing (read-only stale banner). */
  async probe(): Promise<void> {
    this.currentRevision = await this.revision()
    this.changed = this.currentRevision !== this.loadedRevision
  }

  /** Reload the official workspace row through the loader's disable/enable seam. */
  async refresh(): Promise<{ revision: string; serviceReplaced: boolean }> {
    return await this.serial(async () => {
      const entry = this.findWorkspaceEntry()
      if (entry === undefined) throw new PluginError('registry-reload-failed', 'cannot find the official workspace loader entry; restart the profile server instead')
      await withFileLock(this.lockTarget, async () => {
        await entry.update({ disabled: true })
        await entry.update({ disabled: false })
        const loader = this.ctx.get('loader') as LoaderLike | undefined
        await loader?.await()
        this.loadedRevision = await this.revision()
        this.currentRevision = this.loadedRevision
        this.epochValue += 1
        this.changed = false
        await this.install()
      })
      return { revision: this.loadedRevision, serviceReplaced: true }
    })
  }

  /** Read-only status for handshake/RPC responses. */
  status(): GuardStatus {
    return {
      revision: this.currentRevision,
      loadedRevision: this.loadedRevision,
      epoch: String(this.epochValue),
      stale: this.changed,
      capability: this.wrapped ? 'prototype' : 'none',
      reload: this.reloadAvailable ? 'loader-disable-enable' : 'none',
    }
  }

  /** Stop routing new calls through this guard (prototype wrappers keep the guard object). */
  dispose(): void {
    this.disposed = true
    if (activeGuard === this) activeGuard = undefined
  }

  private findWorkspaceEntry(): LoaderEntryLike | undefined {
    const loader = this.ctx.get('loader') as LoaderLike | undefined
    if (loader === undefined) return undefined
    const entries = [...loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-workspace')
    return entries.length === 1 ? entries[0] : undefined
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}
