/** Stable error object shape shared by the v1 server plugin (protocol §2.1). */
export class PluginError extends Error {
  readonly isDSHRemoteError = true as const
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'RemoteError'
  }
}

/** Scrub known secret shapes from diagnostics before they leave the process. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b(token|password|passphrase|secret|api[_-]?key)(\s*[=:]\s*)[^\s,;'"]+/gi, '$1$2[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
}

/** Convert unknown errors into a safe envelope error. */
export function errorValue(error: unknown, fallbackCode = 'internal'): { code: string; message: string; details?: unknown } {
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown; isDSHRemoteError?: unknown } | undefined
  const code = typeof candidate?.code === 'string' ? candidate.code : fallbackCode
  const message = scrubSecrets(error instanceof Error ? error.message : String(error))
  return {
    code,
    message,
    ...(candidate?.details === undefined ? {} : { details: candidate.details }),
  }
}

/**
 * HTTP status for one stable P1 error code (protocol §12).
 *
 * Explicit table: an unmapped business code is a contract bug, not a silent
 * 500. Keep this in sync with `RW_ERROR_CODES`; `internal` is the only 500
 * fallback.
 */
export function httpStatusFor(code: string): number {
  switch (code) {
    case 'bad-request':
    case 'workspace-path-invalid':
    case 'persist-read-only':
      return 400
    case 'unauthorized':
      return 401
    case 'forbidden':
    case 'lease-mismatch':
      return 403
    case 'plugin-missing':
    case 'workspace-unknown':
    case 'session-not-found':
    case 'target-not-connected':
      return 404
    case 'plugin-protocol-mismatch':
    case 'plugin-version-mismatch':
    case 'profile-mismatch':
    case 'profile-foreign-client':
    case 'profile-in-use':
    case 'registry-stale':
    case 'workspace-not-empty':
    case 'session/writer-held':
    case 'session/agent-busy':
    case 'session/archive-activity':
    case 'session/archived-pin':
    case 'executor-held':
    case 'executor-mode-conflict':
    case 'executor-switch-confirm-required':
    case 'executor-switch-busy':
    case 'persist-create-exists':
    case 'agent-unavailable':
      return 409
    case 'handle-not-found':
      return 410
    case 'upstream-timeout':
      return 502
    case 'tunnel-unavailable':
      return 503
    case 'timeout':
      return 504
    default:
      return 500
  }
}
