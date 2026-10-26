/** Small cross-process writer lock with PID-stale takeover (withFileLock semantics). */
import { open, readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'

const DEFAULT_WAIT_MS = 2_000

/** Whether a PID is still alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Run one operation while holding `<path>.lock`.
 * @param path - target file the lock protects.
 * @param operation - critical section.
 * @param waitMs - contention deadline.
 */
export async function withFileLock<T>(path: string, operation: () => Promise<T>, waitMs = DEFAULT_WAIT_MS): Promise<T> {
  const lockPath = `${path}.lock`
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + waitMs
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n`, 'utf8')
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        await handle?.close().catch(() => {})
        throw error
      }
      await handle?.close().catch(() => {})
      const owner = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10)
      if (Number.isSafeInteger(owner) && owner > 0 && !alive(owner)) {
        await rm(lockPath, { force: true }).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for lock ${lockPath}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true }).catch(() => {})
  }
}

/** Whether a path exists (lock diagnostics only). */
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
