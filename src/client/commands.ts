/**
 * The three iframe → parent commands (protocol §9.3 / §16.14).
 *
 * The embedded page never changes the frame's `src` and never touches the
 * client's store: it posts one versioned command to its parent and the client
 * page decides what "switch", "new connection" and "back to local" mean. The
 * vocabulary and its validator are shared with the client through
 * `../protocol.ts`, so there is exactly one definition of what a legal command
 * is.
 *
 * Every builder takes the target window/post function explicitly, which keeps
 * this module Node-testable and keeps `window` out of the protocol layer.
 */
import {
  rwPortalClosePortal,
  rwPortalOpenConnectDialog,
  rwPortalSwitchTarget,
  type RwPortalCommand,
} from '../protocol.ts'

/** The subset of `window` a command needs. */
export interface PortalWindowLike {
  readonly parent?: unknown
  readonly location?: { readonly origin?: string }
}

/** Delivery seam for tests; production passes the real `postMessage`. */
export type PortalPost = (message: unknown, targetOrigin: string) => void

/** Where one command goes: the parent window and the origin to pin it to. */
export interface PortalCommandTarget {
  readonly post: PortalPost
  readonly origin: string
}

/**
 * Whether the page runs inside a parent frame.
 *
 * When the profile's UI is opened directly (`window.parent === window`) there is
 * no client page to act on a command, so the panel renders the list read-only
 * (protocol §16.14 "失败语义").
 * @param win - the page's `window` (or a test double).
 * @returns true when a distinct parent exists.
 */
export function isEmbedded(win: PortalWindowLike): boolean {
  return win.parent !== undefined && win.parent !== win
}

/**
 * Resolve the `postMessage` sink and the origin to pin it to.
 *
 * The origin is the page's own origin: the client page is same-origin with the
 * embedded frame (both are served through the client host's portal), so pinning
 * to `location.origin` is both correct and the narrowest target.
 * @param win - the page's `window`.
 * @returns the delivery target, or undefined when there is no parent/origin.
 */
export function portalCommandTarget(win: PortalWindowLike): PortalCommandTarget | undefined {
  if (!isEmbedded(win)) return undefined
  const origin = win.location?.origin
  if (origin === undefined || origin === '') return undefined
  const parent = win.parent as { postMessage?: unknown } | undefined
  const postMessage = parent?.postMessage
  if (typeof postMessage !== 'function') return undefined
  return {
    post: (message: unknown, targetOrigin: string) => {
      ;(postMessage as (message: unknown, targetOrigin: string) => void).call(parent, message, targetOrigin)
    },
    origin,
  }
}

/**
 * Deliver one command to the client page.
 * @param command - a builder result from `../protocol.ts`.
 * @param target - delivery target; when omitted the command is dropped.
 * @returns whether a command was posted.
 */
export function postPortalCommand(command: RwPortalCommand, target: PortalCommandTarget | undefined): boolean {
  if (target === undefined) return false
  target.post(command, target.origin)
  return true
}

/**
 * Ask the client to activate one target (and remount the frame).
 * @param targetId - the row's target id.
 * @param target - delivery target.
 * @returns whether a command was posted.
 */
export function switchToTarget(targetId: string, target: PortalCommandTarget | undefined): boolean {
  if (targetId === '') return false
  return postPortalCommand(rwPortalSwitchTarget(targetId), target)
}

/**
 * Ask the client to open its connection dialog (the dialog lives in the client
 * shell, outside the frame, so it can sit above the frame).
 * @param target - delivery target.
 * @returns whether a command was posted.
 */
export function requestNewConnection(target: PortalCommandTarget | undefined): boolean {
  return postPortalCommand(rwPortalOpenConnectDialog(), target)
}

/**
 * Ask the client to drop the frame and show its own connection list again.
 * @param target - delivery target.
 * @returns whether a command was posted.
 */
export function requestClosePortal(target: PortalCommandTarget | undefined): boolean {
  return postPortalCommand(rwPortalClosePortal(), target)
}
