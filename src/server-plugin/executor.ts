/** Per-session executor state shared by every client of one server (protocol §5.4/§16.5). */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RwExecutorMode, RwExecutorRecord } from '../protocol.ts'

export interface ExecutorOwner {
  readonly clientId: string
  readonly instanceId: string
  readonly heartbeatAt: string
}

/** Durable executor record store (one small JSON file per session). */
export class ExecutorStore {
  constructor(private readonly dir: string) {}

  private file(sessionId: string): string {
    return join(this.dir, `${encodeURIComponent(sessionId)}.json`)
  }

  /** Read one record, or null when absent/malformed. */
  async get(sessionId: string): Promise<RwExecutorRecord | null> {
    try {
      const value = JSON.parse(await readFile(this.file(sessionId), 'utf8')) as RwExecutorRecord
      return value?.version === 1 && typeof value.sessionId === 'string' && (value.mode === 'server' || value.mode === 'local')
        ? value
        : null
    } catch {
      return null
    }
  }

  /** Write one record atomically. */
  async write(record: RwExecutorRecord): Promise<RwExecutorRecord> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const path = this.file(record.sessionId)
    const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    await rename(temporary, path)
    return record
  }

  /** Upsert a record; owner defaults to the current lease for local mode. */
  async assign(sessionId: string, mode: RwExecutorMode, owner: ExecutorOwner | undefined, switchedBy: RwExecutorRecord['switchedBy'] = 'user'): Promise<RwExecutorRecord> {
    return await this.write({
      version: 1,
      sessionId,
      mode,
      updatedAt: new Date().toISOString(),
      ...(mode === 'local' && owner !== undefined ? { owner } : {}),
      ...(switchedBy === undefined ? {} : { switchedBy }),
    })
  }
}
