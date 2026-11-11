/**
 * Managed server-mode agents (protocol §16.1, A+).
 *
 * The profile's official UI resumes a session on open and drops the returned
 * AgentHandle, so the plugin can never release the JSONL write lease. Here the
 * plugin resumes first, keeps the handle, and the official UI's follow/promote
 * reuses the live agent instead of resuming again.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalHub } from './agent-control.ts'
import { PluginError } from './errors.ts'

interface HandleLike {
  dispose(): Promise<void>
  readonly agent?: { readonly id?: unknown }
}

interface ObservationLike {
  readonly projections?: { readonly values?: { readonly agentPreset?: string | null } }
  [Symbol.dispose]?(): void
}

interface AgentsLike {
  get(id: string): unknown
  create(options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
    setup?: (agentCtx: Context) => Promise<void> | void
  }): Promise<HandleLike>
  resume(options: {
    resumeSessionId: string
    agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
    setup?: (agentCtx: Context) => Promise<void> | void
  }): Promise<HandleLike>
  list(): readonly { readonly id: unknown; readonly status?: string }[]
}

interface SessionQueryLike {
  observeSession(id: string): Promise<ObservationLike>
}

interface PresetsLike {
  resolve(id?: string): Promise<{ readonly id: string; readonly broken?: string }>
  mount(ctx: Context, id?: string): Promise<{ readonly id: string }>
}

interface DefaultModelLike {
  currentSelection(): { provider?: string; model?: string; reasoningEffort?: string }
}

interface PersistenceLike {
  flush(options?: unknown): Promise<void>
}

export type PrepareResult =
  | { readonly managed: true; readonly agentPreset?: string }
  | { readonly managed: false; readonly fallback: 'restart'; readonly reason: string }

/** Owns the managed AgentHandles of this profile process. */
export class ManagedAgents {
  private readonly handles = new Map<string, { handle: HandleLike; agentPreset?: string }>()
  private readonly preparing = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly onSwitch: (sessionId: string, next: 'local' | 'server') => Promise<void>,
    private readonly options: { readonly approvals?: ApprovalHub; readonly approvalPreempt?: boolean } = {},
  ) {}

  /** Agent-scoped approval registration; runs before the preset setup. */
  private setupApproval(presetMount?: (agentCtx: Context) => Promise<void> | void): (agentCtx: Context) => Promise<void> {
    return async (agentCtx: Context) => {
      this.options.approvals?.attachAgent(agentCtx, this.options.approvalPreempt === true)
      await presetMount?.(agentCtx)
    }
  }

  /** Ensure a live agent whose write lease is owned by this plugin. */
  async prepare(sessionId: string): Promise<PrepareResult> {
    if (sessionId === '') throw new PluginError('bad-request', 'session/prepare-server requires sessionId')
    const agents = this.ctx.get('agents') as AgentsLike | undefined
    if (agents === undefined) throw new PluginError('internal', 'the profile has no agents service')
    if (this.handles.has(sessionId)) return this.result(sessionId)
    if (agents.get(sessionId) !== undefined) {
      return { managed: false, fallback: 'restart', reason: 'the official UI or another component already opened this session' }
    }
    if (this.preparing.has(sessionId)) return { managed: false, fallback: 'restart', reason: 'another prepare-server call is already opening this session' }
    this.preparing.add(sessionId)
    try {
      const query = this.ctx.get('sessionQuery') as SessionQueryLike | undefined
      if (query === undefined) throw new PluginError('agent-compose-failed', 'the profile has no sessionQuery service')
      let observation: ObservationLike
      try {
        observation = await query.observeSession(sessionId)
      } catch (error) {
        return { managed: false, fallback: 'restart', reason: `the session cannot be observed before resume: ${error instanceof Error ? error.message : String(error)}` }
      }
      try {
        const presets = this.ctx.get('agentPresets') as PresetsLike | undefined
        const presetId = observation.projections?.values?.agentPreset ?? undefined
        let resolved: { id: string; broken?: string } | undefined
        try {
          resolved = presets === undefined ? undefined : await presets.resolve(presetId)
        } catch (error) {
          throw new PluginError('agent-compose-failed', `cannot resolve agent preset: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (resolved?.broken !== undefined) throw new PluginError('agent-compose-failed', `agent preset is broken: ${resolved.broken}`, { agentPreset: resolved.id })
        const defaultModel = this.ctx.get('agentDefaultModel') as DefaultModelLike | undefined
        const selection = defaultModel?.currentSelection() ?? {}
        const agentOptions = {
          ...(selection.provider === undefined ? {} : { provider: selection.provider }),
          ...(selection.model === undefined ? {} : { model: selection.model }),
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        }
        let handle: HandleLike
        try {
          handle = await agents.resume({
            resumeSessionId: sessionId,
            ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
            setup: this.setupApproval(resolved === undefined ? undefined : async (agentCtx: Context) => { await presets?.mount(agentCtx, resolved.id) }),
          })
        } catch (error) {
          const name = (error as { name?: string } | undefined)?.name
          if (name === 'SessionAlreadyOwnedError') {
            return { managed: false, fallback: 'restart', reason: 'another writer already holds this session (unmanaged)' }
          }
          throw new PluginError('agent-compose-failed', `resume failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.handles.set(sessionId, { handle, ...(resolved === undefined ? {} : { agentPreset: resolved.id }) })
        return this.result(sessionId)
      } finally {
        observation[Symbol.dispose]?.()
      }
    } finally {
      this.preparing.delete(sessionId)
    }
  }

  /**
   * Create one server-mode blank session whose handle stays with this plugin.
   *
   * This mirrors the official `ApiSessionAgentController.createMinted` path
   * without going through `sessionController.create` (which would publish a
   * live agent whose handle it drops).
   */
  async createServerBlank(sessionId: string, cwd: string, presetId?: string): Promise<{ agentPreset?: string }> {
    const agents = this.ctx.get('agents') as AgentsLike | undefined
    if (agents === undefined) throw new PluginError('agent-compose-failed', 'the profile has no agents service')
    if (agents.get(sessionId) !== undefined) throw new PluginError('internal', `session "${sessionId}" already has a live agent`)
    const presets = this.ctx.get('agentPresets') as PresetsLike | undefined
    let resolved: { id: string; broken?: string } | undefined
    try {
      resolved = presets === undefined ? undefined : await presets.resolve(presetId)
    } catch (error) {
      throw new PluginError('agent-compose-failed', `cannot resolve agent preset: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (resolved?.broken !== undefined) throw new PluginError('agent-compose-failed', `agent preset is broken: ${resolved.broken}`, { agentPreset: resolved.id })
    const defaultModel = this.ctx.get('agentDefaultModel') as DefaultModelLike | undefined
    const selection = defaultModel?.currentSelection() ?? {}
    const agentOptions = {
      ...(selection.provider === undefined ? {} : { provider: selection.provider }),
      ...(selection.model === undefined ? {} : { model: selection.model }),
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    }
    let handle: HandleLike
    try {
      handle = await agents.create({
        sessionId,
        meta: { cwd, ...(resolved === undefined ? {} : { agentPreset: resolved.id }) },
        ...(Object.keys(agentOptions).length === 0 ? {} : { agentOptions }),
        setup: this.setupApproval(resolved === undefined ? undefined : async (agentCtx: Context) => { await presets?.mount(agentCtx, resolved.id) }),
      })
    } catch (error) {
      throw new PluginError('agent-compose-failed', `blank session creation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.handles.set(sessionId, { handle, ...(resolved === undefined ? {} : { agentPreset: resolved.id }) })
    return resolved === undefined ? {} : { agentPreset: resolved.id }
  }

  /** Whether a live agent exists but the plugin does not own its handle. */
  unmanaged(sessionId: string): boolean {
    const agents = this.ctx.get('agents') as AgentsLike | undefined
    return this.handles.has(sessionId) === false && agents?.get(sessionId) !== undefined
  }

  /** Release the managed handle (cancel + whenIdle + close) and flush the log. */
  async dispose(sessionId: string): Promise<boolean> {
    const entry = this.handles.get(sessionId)
    if (entry === undefined) return false
    this.handles.delete(sessionId)
    await entry.handle.dispose().catch(error => {
      console.error(`[dsh-remote-workspace-server] managed agent dispose failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    })
    const persistence = this.ctx.get('sessionPersistence') as PersistenceLike | undefined
    await persistence?.flush().catch(() => {})
    return true
  }

  /** Switch helper used by executor/switch (server→local). */
  async releaseForSwitch(sessionId: string, to: 'local' | 'server'): Promise<{ restartRequired: boolean; disposed: boolean }> {
    if (to === 'server') return { restartRequired: false, disposed: false }
    if (this.handles.has(sessionId)) {
      const disposed = await this.dispose(sessionId)
      await this.onSwitch(sessionId, 'local')
      return { restartRequired: false, disposed }
    }
    if (this.unmanaged(sessionId)) {
      await this.onSwitch(sessionId, 'local')
      return { restartRequired: true, disposed: false }
    }
    await this.onSwitch(sessionId, 'local')
    return { restartRequired: false, disposed: false }
  }

  /** Dispose every managed handle (plugin unload / profile shutdown). */
  async disposeAll(): Promise<void> {
    for (const sessionId of [...this.handles.keys()]) await this.dispose(sessionId)
  }

  /** Diagnostic list for handshake/profile status. */
  list(): Array<{ sessionId: string; agentPreset?: string }> {
    return [...this.handles].map(([sessionId, entry]) => ({ sessionId, ...(entry.agentPreset === undefined ? {} : { agentPreset: entry.agentPreset }) }))
  }

  private result(sessionId: string): PrepareResult {
    const entry = this.handles.get(sessionId)
    return { managed: true, ...(entry?.agentPreset === undefined ? {} : { agentPreset: entry.agentPreset }) }
  }
}
