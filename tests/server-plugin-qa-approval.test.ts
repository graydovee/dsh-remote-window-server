import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readQaApprovalTool } from '../src/server-plugin/qa-approval.ts'

describe('QA-only approval gate', () => {
  it('is disabled without a marker or with a blank marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rw-qa-gate-'))
    try {
      expect(readQaApprovalTool(join(dir, 'missing'))).toBeUndefined()
      await writeFile(join(dir, 'blank'), '   \n')
      expect(readQaApprovalTool(join(dir, 'blank'))).toBeUndefined()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('returns a configured tool name or wildcard', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rw-qa-gate-'))
    try {
      await writeFile(join(dir, 'tool'), 'bash\n')
      expect(readQaApprovalTool(join(dir, 'tool'))).toBe('bash')
      await writeFile(join(dir, 'any'), '*')
      expect(readQaApprovalTool(join(dir, 'any'))).toBe('*')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
