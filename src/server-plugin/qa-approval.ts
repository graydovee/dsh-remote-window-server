/**
 * QA-only deterministic approval gate.
 *
 * Disabled unless the per-client state directory contains
 * `remote-window/<clientId>/qa-approval-tool` with a tool name (or `*`).
 * When enabled, the named tool's `tools/pre-execute` waterfall returns `ask`
 * before dispatch, so the official tool registry + ApprovalService produce a
 * real `approval/asked` / `approval/decided` pair and the v2 hub has a pending
 * approval to hold. This file is intentionally absent from package defaults;
 * normal deployments never see different behavior.
 */
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

interface PreExecuteExec {
  readonly name?: unknown
}

type PreExecuteDecision = { readonly kind: 'ask'; readonly reason: string; readonly displayReason: { readonly en: string; readonly zh: string } } | { readonly kind: 'allow' } | { readonly kind: 'deny'; readonly reason: string } | { readonly kind: 'cancel' }

type PreExecuteNext = () => Promise<PreExecuteDecision>

/**
 * Read the QA gate marker; a missing/blank/bad file disables the gate.
 * @param path - marker file path inside the per-client state directory.
 * @returns the tool name, `*`, or undefined.
 */
export function readQaApprovalTool(path: string): string | undefined {
  try {
    const value = readFileSync(path, 'utf8').trim()
    if (value === '' || value.length > 128 || /[\u0000-\u001f]/u.test(value)) return undefined
    return value
  } catch {
    return undefined
  }
}

/** Install the QA-only pre-execute gate; no marker means no listener. */
export function installQaApprovalGate(ctx: Context, tool: string | undefined): () => void {
  if (tool === undefined) return () => {}
  const on = (ctx as unknown as {
    on(event: 'tools/pre-execute', listener: (exec: PreExecuteExec, next: PreExecuteNext) => Promise<PreExecuteDecision>): () => void
  }).on
  const off = on.call(ctx, 'tools/pre-execute', async (exec, next) => {
    if (tool !== '*' && exec.name !== tool) return await next()
    return {
      kind: 'ask',
      reason: `QA approval probe for ${String(exec.name ?? 'tool')}`,
      displayReason: {
        en: `Allow the QA approval probe to run "${String(exec.name ?? 'tool')}" once?`,
        zh: `允许 QA 审批测试执行一次“${String(exec.name ?? 'tool')}”？`,
      },
    }
  })
  return () => { off?.() }
}
