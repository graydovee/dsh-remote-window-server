/** Session-row helpers shared by `session/list` and its tests. */
import type { RwExecutorRecord } from '../protocol.ts'

/** Execution end for one session row; a missing record is the historical server mode. */
export function executorModeOf(record: RwExecutorRecord | null | undefined): 'server' | 'local' {
  return record?.mode === 'local' ? 'local' : 'server'
}
