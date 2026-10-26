/** Single-client profile lease (protocol §3.4). */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RwProfileLease } from '../protocol.ts'

export interface LeaseClaimRequest {
  readonly clientId: string
  readonly instanceId: string
  readonly profile: string
  readonly pid: number
  readonly port: number
  readonly tokenFingerprint: string
}

export type LeaseDecision =
  | { readonly kind: 'claimed'; readonly lease: RwProfileLease; readonly staleTakeover: boolean }
  | { readonly kind: 'foreign-client'; readonly ownerClientId: string }
  | { readonly kind: 'in-use'; readonly owner: RwProfileLease }

/** Stale lease TTL (heartbeat age). */
export const LEASE_TTL_MS = 20_000

/** Fresh claim decision; pure for tests. */
export function decideLease(
  existing: RwProfileLease | undefined,
  request: LeaseClaimRequest,
  now: number,
): LeaseDecision {
  const stamp = new Date(now).toISOString()
  if (existing === undefined) {
    return {
      kind: 'claimed',
      staleTakeover: false,
      lease: {
        version: 1,
        profile: request.profile,
        clientId: request.clientId,
        instanceId: request.instanceId,
        pid: request.pid,
        port: request.port,
        startedAt: stamp,
        heartbeatAt: stamp,
        tokenFingerprint: request.tokenFingerprint,
      },
    }
  }
  if (existing.clientId !== request.clientId) {
    return { kind: 'foreign-client', ownerClientId: existing.clientId }
  }
  const age = now - Date.parse(existing.heartbeatAt)
  if (existing.instanceId === request.instanceId) {
    return { kind: 'claimed', staleTakeover: false, lease: { ...existing, profile: request.profile, pid: request.pid, port: request.port, heartbeatAt: stamp, tokenFingerprint: request.tokenFingerprint } }
  }
  if (Number.isFinite(age) && age <= LEASE_TTL_MS) return { kind: 'in-use', owner: existing }
  return {
    kind: 'claimed',
    staleTakeover: true,
    lease: {
      version: 1,
      profile: request.profile,
      clientId: request.clientId,
      instanceId: request.instanceId,
      pid: request.pid,
      port: request.port,
      startedAt: stamp,
      heartbeatAt: stamp,
      tokenFingerprint: request.tokenFingerprint,
    },
  }
}

/** Read one lease document; absent/malformed = undefined. */
export async function readLease(path: string): Promise<RwProfileLease | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as RwProfileLease
    return value?.version === 1 && typeof value.profile === 'string' && typeof value.clientId === 'string'
      && typeof value.instanceId === 'string' && typeof value.heartbeatAt === 'string'
      ? value
      : undefined
  } catch {
    return undefined
  }
}

/** Atomically write one lease document (0600). */
export async function writeLease(path: string, lease: RwProfileLease): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
  await writeFile(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/** Remove the lease on explicit release. */
export async function removeLease(path: string): Promise<void> {
  await rm(path, { force: true })
}

/** Owns the in-memory lease and its heartbeat. */
export class ProfileLease {
  private lease: RwProfileLease | undefined
  private timer: NodeJS.Timeout | undefined
  private readonly serverId: string

  constructor(
    readonly path: string,
    readonly profile: string,
    private readonly heartbeatMs = 5_000,
  ) {
    this.serverId = `${process.pid}`
  }

  get current(): RwProfileLease | undefined {
    return this.lease
  }

  get fingerprint(): string {
    return this.serverId
  }

  /** Claim/refresh the lease for one handshake. */
  async claim(request: Omit<LeaseClaimRequest, 'pid' | 'port' | 'profile' | 'tokenFingerprint'> & { port: number; tokenFingerprint: string }): Promise<LeaseDecision> {
    const existing = await readLease(this.path)
    const decision = decideLease(existing, {
      ...request,
      profile: this.profile,
      pid: process.pid,
      port: request.port,
    }, Date.now())
    if (decision.kind !== 'claimed') return decision
    this.lease = decision.lease
    await writeLease(this.path, decision.lease)
    this.startHeartbeat()
    return decision
  }

  /** Refresh heartbeat of the current lease. */
  async heartbeat(): Promise<{ ok: boolean; expiresAt: string }> {
    if (this.lease === undefined) return { ok: false, expiresAt: new Date(0).toISOString() }
    const now = new Date().toISOString()
    this.lease = { ...this.lease, heartbeatAt: now }
    await writeLease(this.path, this.lease).catch(() => {})
    return { ok: true, expiresAt: new Date(Date.parse(now) + LEASE_TTL_MS).toISOString() }
  }

  /** Whether a request header pair matches this instance. */
  matches(clientId: string | undefined, instanceId: string | undefined): boolean {
    return this.lease !== undefined && clientId === this.lease.clientId && instanceId === this.lease.instanceId
  }

  /** Stop heartbeat and remove the lease (explicit release only). */
  async release(): Promise<void> {
    this.stopHeartbeat()
    this.lease = undefined
    await removeLease(this.path).catch(() => {})
  }

  /** Stop heartbeat without touching the file (process shutdown/effect cleanup). */
  dispose(): void {
    this.stopHeartbeat()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.timer = setInterval(() => { void this.heartbeat() }, this.heartbeatMs)
    this.timer.unref()
  }

  private stopHeartbeat(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }
}
