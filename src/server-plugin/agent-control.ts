/**
 * v2 agent control: prompt/cancel/approval without `sessionController.create`.
 *
 * The live `ctx.agents` registry is the only requirement. A cold session is
 * resumed through the plugin's existing managed-handle path (or reported as a
 * coded `agent-unavailable`), so a profile that lacks `sessionController` can
 * still drive a blank/server session.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { RwApprovalRequest, RwApprovalSummary, RwApprovalValue, RwPromptValue, RwSessionStatusValue } from '../protocol.ts'
import { PluginError } from './errors.ts'
import type { ApprovalSource } from './events.ts'
import { sessionStatus } from './events.ts'

/** Assistant/user message shape accepted by `Agent.followup`/`steer`. */
interface OutgoingMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: { readonly kind: 'user' }
}

interface AgentLike {
  readonly id?: unknown
  readonly status?: string
  followup?(message: OutgoingMessage): void
  steer?(message: OutgoingMessage): void
  cancel?(cause: { readonly kind: 'user' }): void
}

interface AgentsLike {
  get(id: string): AgentLike | undefined
}

interface ManagedLike {
  prepare(sessionId: string): Promise<
    | { readonly managed: true; readonly agentPreset?: string }
    | { readonly managed: false; readonly fallback: 'restart'; readonly reason: string }
  >
}

interface ApprovalRequestLike {
  readonly agent: AgentLike
  readonly toolName: string
  readonly callId?: unknown
  readonly reason?: string
  readonly displayReason?: Record<string, string>
  readonly signal?: AbortSignal
}

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface PendingApproval {
  readonly summary: RwApprovalSummary
  readonly resolve: (outcome: ApprovalOutcome) => void
  readonly signal?: AbortSignal
  readonly onAbort?: () => void
  readonly timer: NodeJS.Timeout
}

/** Pending approval requests keyed by service-issued id; also an SSE source. */
export class ApprovalHub implements ApprovalSource {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly listeners = new Map<string, Set<(approval: RwApprovalSummary) => void>>()
  private disposed = false

  /** Whether a v2 SSE client is watching this session (it can answer approvals). */
  hasSubscribers(sessionId: string): boolean {
    return (this.listeners.get(sessionId)?.size ?? 0) > 0
  }

  /**
   * Answer an approval request. Without a v2 watcher (and without the QA
   * marker) earlier waterfall listeners keep priority; a v2 SSE subscriber or
   * the QA gate preempts them so the self-drawn client can answer instead of a
   * background official-UI answerer holding the request forever.
   */
  async handle(request: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>, preempt = false): Promise<ApprovalOutcome> {
    if (this.disposed) return 'unavailable'
    const sessionId = String(request.agent.id ?? '')
    if (sessionId === '') return 'unavailable'
    if (preempt || this.hasSubscribers(sessionId) || process.env.DSH_RW_DEBUG === '1') {
      console.error(`[dsh-remote-workspace-server] approval request session=${sessionId} preempt=${preempt} subscribers=${this.hasSubscribers(sessionId)} pending=${this.pending.size}`)
    }
    if (!preempt && !this.hasSubscribers(sessionId)) {
      const earlier = await next()
      if (earlier !== 'unavailable') return earlier
    }
    const approvalId = randomUUID()
    const summary: RwApprovalSummary = {
      approvalId,
      sessionId,
      toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: String(request.callId) }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }),
      requestedAt: Date.now(),
    }
    const outcome = await new Promise<ApprovalOutcome>(resolve => {
      const onAbort = (): void => { finish('cancelled') }
      const finish = (value: ApprovalOutcome): void => {
        const entry = this.pending.get(approvalId)
        if (entry === undefined) return
        this.pending.delete(approvalId)
        clearTimeout(entry.timer)
        entry.signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }
      // A disconnected/unresponsive v2 client must not hold a tool forever.
      const timer = setTimeout(() => { finish('unavailable') }, 120_000)
      timer.unref()
      const entry: PendingApproval = { summary, resolve: finish, ...(request.signal === undefined ? {} : { signal: request.signal }), ...(request.signal === undefined ? {} : { onAbort }), timer }
      this.pending.set(approvalId, entry)
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (request.signal?.aborted === true) finish('cancelled')
      this.notify(summary)
    })
    return outcome
  }

  /** Resolve one pending request from `session/approval`. */
  answer(params: Record<string, unknown>): RwApprovalValue {
    const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
    const approvalId = typeof params['approvalId'] === 'string' ? params['approvalId'] : ''
    const decision = params['decision']
    if (sessionId === '' || approvalId === '') throw new PluginError('bad-request', 'session/approval requires sessionId and approvalId')
    if (decision !== 'allowed-once' && decision !== 'rejected' && decision !== 'cancelled' && decision !== 'allow' && decision !== 'deny') {
      throw new PluginError('bad-request', 'session/approval decision must be allowed-once, rejected or cancelled')
    }
    const entry = this.pending.get(approvalId)
    if (entry === undefined || entry.summary.sessionId !== sessionId) {
      throw new PluginError('bad-request', `approval "${approvalId}" is not pending for session "${sessionId}"`, { approvalId, sessionId })
    }
    const normalized = decision === 'allow' ? 'allowed-once' : decision === 'deny' ? 'rejected' : decision
    entry.resolve(normalized)
    return { accepted: true, approvalId, decision: normalized }
  }

  /** Pending summaries for status/SSE. */
  list(sessionId: string): RwApprovalSummary[] {
    return [...this.pending.values()].map(entry => entry.summary).filter(summary => summary.sessionId === sessionId)
  }

  subscribe(sessionId: string, listener: (approval: RwApprovalSummary) => void): () => void {
    const set = this.listeners.get(sessionId) ?? new Set()
    set.add(listener)
    this.listeners.set(sessionId, set)
    return () => {
      const current = this.listeners.get(sessionId)
      if (current === undefined) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(sessionId)
    }
  }

  /**
   * Register the approval listener on an agent-scoped context. The official
   * service dispatches with `scopeTarget(agent, agent)`; an agent-scoped
   * listener is admitted on the real profile, while a root plugin listener is
   * filtered out.
   */
  attachAgent(agentCtx: Context, preempt = false): () => void {
    return installApprovalAnswerer(agentCtx, this, preempt)
  }

  /** Resolve any outstanding request as cancelled and stop accepting new ones. */
  dispose(): void {
    this.disposed = true
    for (const entry of [...this.pending.values()]) entry.resolve('cancelled')
    this.pending.clear()
    this.listeners.clear()
  }

  private notify(summary: RwApprovalSummary): void {
    for (const listener of this.listeners.get(summary.sessionId) ?? []) {
      try { listener(summary) } catch { /* one UI listener must not break the tool */ }
    }
  }
}

/** Install the approval waterfall listener; returns its disposer. */
export function installApprovalAnswerer(ctx: Context, hub: ApprovalHub, preempt = false): () => void {
  // Prepend so the agent-scoped listener observes the request before a
  // background official-UI answerer can fail it closed with `unavailable`.
  const off = (ctx as unknown as {
    on(
      event: 'approval/request',
      listener: (request: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>,
      options: { prepend: boolean },
    ): () => void
  }).on('approval/request', (request, next) => hub.handle(request, next, preempt), { prepend: true })
  return () => { off?.() }
}

function outgoingMessage(text: string): OutgoingMessage {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** Resolve a live agent, resuming a cold server session through the managed handle. */
async function ensureAgent(ctx: Context, managed: ManagedLike | undefined, sessionId: string): Promise<AgentLike> {
  const agents = ctx.get('agents') as AgentsLike | undefined
  if (agents === undefined) throw new PluginError('agent-unavailable', 'the profile has no agents service', { sessionId })
  const existing = agents.get(sessionId)
  if (existing !== undefined) return existing
  if (managed === undefined) throw new PluginError('agent-unavailable', 'no managed agent path is available for this session', { sessionId })
  const prepared = await managed.prepare(sessionId)
  if (prepared.managed === false) {
    throw new PluginError('agent-unavailable', `the session cannot be driven by this plugin: ${prepared.reason}`, { sessionId, reason: prepared.reason })
  }
  const resumed = agents.get(sessionId)
  if (resumed === undefined) throw new PluginError('agent-unavailable', 'the agent did not become live after resume', { sessionId })
  return resumed
}

/** `session/prompt`: deliver one follow-up or steering user message. */
export async function promptSession(ctx: Context, managed: ManagedLike | undefined, params: Record<string, unknown>): Promise<RwPromptValue> {
  const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
  const raw = typeof params['text'] === 'string' ? params['text'] : ''
  const text = raw.trim()
  if (sessionId === '') throw new PluginError('bad-request', 'session/prompt requires sessionId')
  if (text === '') throw new PluginError('bad-request', 'session/prompt requires non-empty text')
  const mode = params['mode'] === 'steer' ? 'steer' : 'followup'
  const agent = await ensureAgent(ctx, managed, sessionId)
  const message = outgoingMessage(text)
  try {
    if (mode === 'steer') agent.steer?.(message)
    else agent.followup?.(message)
  } catch (error) {
    throw new PluginError('persist-read-only', `prompt rejected: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { accepted: true, sessionId }
}

/** `session/status`: live agent + pending approvals. */
export async function sessionStatusValue(ctx: Context, hub: ApprovalHub, params: Record<string, unknown>, approvalGate?: 'qa' | 'off'): Promise<RwSessionStatusValue> {
  const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
  if (sessionId === '') throw new PluginError('bad-request', 'session/status requires sessionId')
  const agents = ctx.get('agents') as AgentsLike | undefined
  if (agents?.get(sessionId) === undefined) {
    // A cold/unstarted session still has a persisted header; a completely
    // unknown id is a real 404, not a fake idle agent.
    const persistence = ctx.get('sessionPersistence') as { stat?(id: string): Promise<unknown> } | undefined
    const stored = await persistence?.stat?.(sessionId).catch(() => undefined)
    if (stored === undefined) throw new PluginError('session-not-found', `session "${sessionId}" does not exist`, { sessionId })
  }
  return { ...sessionStatus(ctx, sessionId, hub.list(sessionId)), ...(approvalGate === undefined ? {} : { approvalGate }) }
}

/** `session/cancel` for v2; kept here so the prompt and cancel paths share lookup. */
export async function cancelSession(ctx: Context, managed: ManagedLike | undefined, params: Record<string, unknown>): Promise<{ canceled: boolean; sessionId: string }> {
  const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : ''
  if (sessionId === '') throw new PluginError('bad-request', 'session/cancel requires sessionId')
  const agent = await ensureAgent(ctx, managed, sessionId)
  agent.cancel?.({ kind: 'user' })
  return { canceled: true, sessionId }
}

/** Validate one `session/approval` payload and resolve it. */
export function approveSession(hub: ApprovalHub, params: Record<string, unknown>): RwApprovalValue {
  return hub.answer(params)
}

export type { RwApprovalRequest }
