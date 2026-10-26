import { describe, expect, it } from 'vitest'
import { ApprovalHub, approveSession, promptSession } from '../src/server-plugin/agent-control.ts'

function ctxWith(agent: Record<string, unknown> | undefined) {
  return {
    get: (name: string) => name === 'agents' ? { get: () => agent } : undefined,
  } as never
}

describe('v2 agent control', () => {
  it('prompts a live agent without sessionController', async () => {
    const sent: unknown[] = []
    const ctx = ctxWith({ id: 's1', followup: (message: unknown) => sent.push(message) })
    const value = await promptSession(ctx, undefined, { sessionId: 's1', text: 'hello' })
    expect(value).toEqual({ accepted: true, sessionId: 's1' })
    expect(sent[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hello' }] })
  })

  it('resumes a cold session through the managed path', async () => {
    let live: Record<string, unknown> | undefined
    const ctx = { get: (name: string) => name === 'agents' ? { get: () => live } : undefined } as never
    const managed = { prepare: async () => { live = { id: 's1', followup() {} }; return { managed: true as const } } }
    await expect(promptSession(ctx, managed, { sessionId: 's1', text: 'x' })).resolves.toMatchObject({ accepted: true })
  })

  it('returns a coded error when no agent path exists', async () => {
    await expect(promptSession(ctxWith(undefined), undefined, { sessionId: 's1', text: 'x' })).rejects.toMatchObject({ code: 'agent-unavailable' })
  })

  it('registers on an agent-scoped context (official waterfall scope)', async () => {
    const hub = new ApprovalHub()
    let listener: ((request: unknown, next: () => Promise<string>) => Promise<string>) | undefined
    let prepended = false
    const agentCtx = { on: (_event: string, fn: typeof listener, options?: { prepend?: boolean }) => { listener = fn; prepended = options?.prepend === true; return () => {} } } as never
    hub.attachAgent(agentCtx, true)
    expect(listener).toBeDefined()
    expect(prepended).toBe(true)
    const asked = listener!({ agent: { id: 's1' }, toolName: 'bash' }, () => new Promise<string>(() => {}))
    await Promise.resolve()
    const pending = hub.list('s1')
    expect(pending).toHaveLength(1)
    approveSession(hub, { sessionId: 's1', approvalId: pending[0]!.approvalId, decision: 'allow' })
    await expect(asked).resolves.toBe('allowed-once')
  })

  it('preempts a background answerer so pending is visible immediately', async () => {
    const hub = new ApprovalHub()
    const never = new Promise<'unavailable'>(() => {})
    const asked = hub.handle({ agent: { id: 's1' }, toolName: 'bash' } as never, () => never, true)
    await Promise.resolve()
    const pending = hub.list('s1')
    expect(pending).toHaveLength(1)
    approveSession(hub, { sessionId: 's1', approvalId: pending[0]!.approvalId, decision: 'deny' })
    await expect(asked).resolves.toBe('rejected')
  })

  it('holds an approval until the self-drawn client answers allow/deny', async () => {
    const hub = new ApprovalHub()
    const request = { agent: { id: 's1' }, toolName: 'bash', reason: 'write' }
    const asked = hub.handle(request as never, async () => 'unavailable')
    await Promise.resolve()
    const pending = hub.list('s1')
    expect(pending).toHaveLength(1)
    expect(approveSession(hub, { sessionId: 's1', approvalId: pending[0]!.approvalId, decision: 'allow' }).decision).toBe('allowed-once')
    await expect(asked).resolves.toBe('allowed-once')
  })
})
