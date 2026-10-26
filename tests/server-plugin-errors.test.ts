import { describe, expect, it } from 'vitest'
import { httpStatusFor } from '../src/server-plugin/errors.ts'

describe('P1 error status mapping (protocol §12)', () => {
  it('maps workspace delete non-empty to 409', () => {
    expect(httpStatusFor('workspace-not-empty')).toBe(409)
  })

  it('maps the documented business codes', () => {
    expect(httpStatusFor('workspace-unknown')).toBe(404)
    expect(httpStatusFor('workspace-path-invalid')).toBe(400)
    expect(httpStatusFor('session/writer-held')).toBe(409)
    expect(httpStatusFor('session/archive-activity')).toBe(409)
    expect(httpStatusFor('session/archived-pin')).toBe(409)
    expect(httpStatusFor('handle-not-found')).toBe(410)
    expect(httpStatusFor('persist-read-only')).toBe(400)
    expect(httpStatusFor('executor-held')).toBe(409)
    expect(httpStatusFor('tunnel-unavailable')).toBe(503)
    expect(httpStatusFor('timeout')).toBe(504)
  })

  it('falls back to 500 only for internal/unknown', () => {
    expect(httpStatusFor('internal')).toBe(500)
    expect(httpStatusFor('something-new')).toBe(500)
  })
})
