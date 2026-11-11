/**
 * Browser half of `dsh-remote-workspace-server`.
 *
 * Runs inside the server profile's official DSH UI — both when that UI is shown
 * directly and when the client embeds it full-screen through its portal. It
 * contributes exactly two declared slots (protocol §16.14):
 *
 * - `sidebar.panellist` row `id: 'dsh-remote-workspace'`, `order: 100`: the
 *   「远程连接」 navigation row, icon only (the shell passes `{ size, active }`);
 * - `main` entry `key: 'dsh-remote-workspace'`: the connection list page. Its data
 *   is the snapshot the client host publishes with the `client/targets` RPC; a
 *   row click posts one versioned command to the parent and the client page
 *   performs the switch.
 *
 * Nothing here touches `sidebar`/`sidebar.workspaces` (single-occupancy slots:
 * registering into them would replace the official column) or injects DOM.
 */
import type { ClientContext } from './context.ts'
import { adoptDocumentLocale, t } from './locales.ts'
import { CONNECTIONS_PANEL_ID, ConnectionsNavRow, ConnectionsPanel } from './section.tsx'
import { ensureStyles } from './styles.ts'

/**
 * Row order in the shell's sidebar panellist.
 *
 * Ascending, after the shipped rows (插件 0, 自动化任务 10) so the row sits at the
 * bottom of the navigation list, directly above the trailing 更多 menu.
 */
const SIDEBAR_ORDER = 100

/** Client services this plugin needs: `slots` only. */
export const inject = ['slots']

/** Panel id shared by the sidebar row and the `main` entry. */
export { CONNECTIONS_PANEL_ID }

/**
 * Plugin body: stylesheet, the sidebar row and the connection list page.
 * @param ctx - the client context.
 */
export function apply(ctx: ClientContext): void {
  // The embed bootstrap already applied `dshRwLang`; read it once so every label
  // resolves in the profile UI's own language.
  adoptDocumentLocale(typeof document === 'undefined' ? undefined : document.documentElement.lang)
  ctx.effect(() => ensureStyles(), 'dsh-remote-workspace-server: stylesheet')

  // One native sidebar row in the panellist group, between 插件 (0) and
  // 自动化任务 (10). The shell owns the row's button/label/selection; the
  // contribution renders the icon and shares its id with the `main` entry below.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: CONNECTIONS_PANEL_ID,
    order: SIDEBAR_ORDER,
    label: () => t('connections.row'),
    registrant: 'dsh-remote-workspace-server',
  }, ConnectionsNavRow))

  // The page under the same key. Registered defensively: an option mismatch on
  // this slot must not silently remove the sidebar row.
  try {
    ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: CONNECTIONS_PANEL_ID,
      label: () => t('connections.title'),
    }, ConnectionsPanel))
  } catch (error) {
    console.error('[dsh-remote-workspace-server] connections main panel registration failed', error)
  }
}
