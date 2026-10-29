import { describe, expect, it } from 'vitest'
import { decideLease, LEASE_TTL_MS, type LeaseClaimRequest } from '../src/server-plugin/lease.ts'
import type { RwProfileLease } from '../src/protocol.ts'

const request = (instanceId: string, clientId = 'client1'): LeaseClaimRequest => ({
  clientId,
  instanceId,
  profile: 'graydovee-remote-window-client1',
  pid: 10,
  port: 3000,
  tokenFingerprint: 'abc',
})

const lease = (instanceId: string, heartbeatAt: string, clientId = 'client1'): RwProfileLease => ({
  version: 1,
  profile: 'graydovee-remote-window-client1',
  clientId,
  instanceId,
  pid: 10,
  port: 3000,
  startedAt: heartbeatAt,
  heartbeatAt,
  tokenFingerprint: 'abc',
})

describe('profile lease decisions', () => {
  it('claims an absent lease', () => {
    const decision = decideLease(undefined, request('i1'), 1_000)
    expect(decision.kind).toBe('claimed')
    if (decision.kind === 'claimed') expect(decision.staleTakeover).toBe(false)
  })

  it('refreshes the same instance', () => {
    const decision = decideLease(lease('i1', new Date(900).toISOString()), request('i1'), 1_000)
    expect(decision.kind).toBe('claimed')
    if (decision.kind === 'claimed') expect(decision.lease.heartbeatAt).toBe(new Date(1_000).toISOString())
  })

  it('refuses a different client id', () => {
    expect(decideLease(lease('i1', new Date(900).toISOString()), request('i2', 'client2'), 1_000).kind).toBe('foreign-client')
  })

  it('refuses a live instance', () => {
    expect(decideLease(lease('i1', new Date(1_000).toISOString()), request('i2'), 1_000 + LEASE_TTL_MS).kind).toBe('in-use')
  })

  it('takes over a stale instance', () => {
    const decision = decideLease(lease('i1', new Date(0).toISOString()), request('i2'), LEASE_TTL_MS + 1)
    expect(decision.kind).toBe('claimed')
    if (decision.kind === 'claimed') expect(decision.staleTakeover).toBe(true)
  })
})
