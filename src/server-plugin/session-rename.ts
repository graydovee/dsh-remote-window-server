/** P1 session rename over the official persistence (fallback + deterministic tests). */
import type { Context } from '@deepseek-ai/cordis'
import { PluginError } from './errors.ts'
import { mapPersistenceError } from './persist.ts'

interface HandleLike {
  read(offset?: number, length?: number): Promise<{ events: readonly unknown[] }>
  append(events: readonly unknown[]): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>
}

interface PersistenceLike {
  open(id: string, access: 'write'): Promise<HandleLike>
}

/** Append one durable user `session/title`; no agent is created or resumed. */
export async function renameStoredSession(ctx: Context, params: Record<string, unknown>): Promise<{ title: string; seq: number }> {
  const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
  const rawTitle = typeof params['title'] === 'string' ? params['title'] : ''
  const title = rawTitle.trim()
  if (sessionId === '') throw new PluginError('bad-request', 'session/rename requires sessionId')
  if (title === '') throw new PluginError('bad-request', 'session/rename requires a non-empty title')
  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
  if (persistence === undefined) throw new PluginError('internal', 'the profile has no sessionPersistence service')
  let handle: HandleLike
  try {
    handle = await persistence.open(sessionId, 'write')
  } catch (error) { mapPersistenceError(error) }
  try {
    const { events } = await handle.read(0)
    const seq = events.length
    await handle.append([{
      type: 'session/title',
      seq,
      time: Date.now(),
      data: { title, messageSeqs: [], source: { kind: 'user' } },
    }])
    await handle.flush()
    return { title, seq }
  } catch (error) { mapPersistenceError(error) } finally {
    await handle.close().catch(() => {})
  }
}
