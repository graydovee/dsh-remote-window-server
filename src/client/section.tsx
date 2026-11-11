/**
 * The server profile's 「远程连接」 surface.
 *
 * Two slot contributions, both declared (no DOM injection):
 *
 * - `sidebar.panellist`: one native sidebar row (`id: 'dsh-remote-workspace'`,
 *   `order: 100`, last in the panellist). The shell passes `{ size, active }`; the row renders only an
 *   icon, exactly like every other panellist entry.
 * - `main`: the page under the same key. It lists the connections the client
 *   published (`client/targets`), highlights the target this frame shows
 *   (`dshRwTarget`) and turns a click into one versioned command the client page
 *   executes (protocol §16.14).
 *
 * The panel never mutates anything itself: it has no access to the client's
 * store, and the frame must not change its own `src`.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconGlobeOutlineRegular, IconPlusOutlineRegular,
  IconRefreshOutlineRegular, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RwClientTarget, RwClientTargetPhase } from '../protocol.ts'
import { isEmbedded, portalCommandTarget, requestClosePortal, requestNewConnection, switchToTarget } from './commands.ts'
import { targetsFeed, type TargetsFeedState, type TargetsSync } from './data.ts'
import { t } from './locales.ts'
import { formatEndpoint, phaseLabel, selectActiveTargetId } from './targets-model.ts'

/** The panel id shared by the `sidebar.panellist` row and the `main` entry. */
export const CONNECTIONS_PANEL_ID = 'dsh-remote-workspace'

/** Dot appearance per phase: live = green, degraded = warning, gone = idle. */
const PHASE_DOTS: Record<RwClientTargetPhase, StateDotState> = {
  connecting: 'ongoing',
  ready: 'done',
  degraded: 'warning',
  failed: 'error',
  stopped: 'idle',
  disconnected: 'idle',
}

/** Props the shell passes to a `sidebar.panellist` contribution. */
export interface PanellistRowProps {
  /** Icon edge length the shell asks for. */
  readonly size?: number
  /** Whether this row's panel is the selected main entry. */
  readonly active?: boolean
}

/**
 * The sidebar row contribution: **the icon only**.
 *
 * The shell owns the row's button chrome, label and selection, and opens the
 * `main` entry registered under the same id when the row is chosen. Rendering a
 * `<button>` here would nest one button inside the shell's and intercept its
 * selection handling, so this component stays a bare icon.
 * @param props - shell-provided icon size and selection flag.
 * @returns the row glyph.
 */
export function ConnectionsNavRow(props: PanellistRowProps): ReactElement {
  return (
    <span
      className="dsh-rws-nav-icon"
      data-testid="dsh-rws-nav-row"
      data-panel={CONNECTIONS_PANEL_ID}
      data-active={props.active === true ? 'true' : undefined}
      title={t('connections.row')}
    >
      <IconGlobeOutlineRegular size={props.size ?? 16} />
    </span>
  )
}

/** Current `location.search`, or '' outside a browser. */
function currentSearch(): string {
  if (typeof window === 'undefined') return ''
  return window.location?.search ?? ''
}

/**
 * Whether this page can drive the client (it is inside the client's frame).
 * @returns true when a parent window with a postMessage sink exists.
 */
function canCommand(): boolean {
  if (typeof window === 'undefined') return false
  return isEmbedded(window)
}

/** One connection row. */
function ConnectionRow(props: {
  readonly target: RwClientTarget
  readonly active: boolean
  readonly enabled: boolean
  readonly onSwitch: (targetId: string) => void
}): ReactElement {
  const { target, active, enabled } = props
  return (
    <li className="dsh-rws-row" data-active={active ? 'true' : undefined} data-target-id={target.targetId}>
      <button
        type="button"
        className="dsh-rws-open"
        data-testid="dsh-rws-row"
        data-phase={target.phase}
        disabled={!enabled}
        aria-current={active ? 'true' : undefined}
        aria-label={t('connections.activate', { label: target.label })}
        title={enabled ? t('connections.activate', { label: target.label }) : t('connections.standalone')}
        onClick={() => { props.onSwitch(target.targetId) }}
      >
        <span className="dsh-rws-dot"><StateDot state={PHASE_DOTS[target.phase]} size={8} /></span>
        <span className="dsh-rws-label">
          <span className="dsh-rws-name">{target.label}</span>
          <span className="dsh-rws-meta">{`${formatEndpoint(target)} · ${phaseLabel(target.phase)}`}</span>
        </span>
        {active && <span className="dsh-rws-badge">{t('connections.active')}</span>}
      </button>
    </li>
  )
}

/** The sync/problem note above the list, or nothing when everything is fine. */
function Notice(props: { readonly sync: TargetsSync; readonly standalone: boolean }): ReactElement | null {
  if (props.sync === 'stale') {
    return <p className="dsh-rws-note" data-kind="warn" role="status" data-testid="dsh-rws-stale">{t('connections.stale')}</p>
  }
  if (props.standalone) {
    return <p className="dsh-rws-note" data-testid="dsh-rws-standalone">{t('connections.standalone')}</p>
  }
  return null
}

/**
 * The connection list page (`main` slot).
 * @returns the page.
 */
export function ConnectionsPanel(): ReactElement {
  const feed: TargetsFeedState = useSyncExternalStore(targetsFeed.subscribe, () => targetsFeed.snapshot(), () => targetsFeed.snapshot())
  const [pendingId, setPendingId] = useState<string | undefined>(undefined)
  const [embedded, setEmbedded] = useState<boolean>(() => canCommand())

  useEffect(() => {
    const stop = targetsFeed.start()
    setEmbedded(canCommand())
    return stop
  }, [])

  const commandTarget = embedded && typeof window !== 'undefined' ? portalCommandTarget(window) : undefined
  const enabled = commandTarget !== undefined
  const snapshot = feed.snapshot
  const activeId = pendingId ?? selectActiveTargetId(snapshot, currentSearch())
  const switchRow = (targetId: string): void => {
    setPendingId(targetId)
    switchToTarget(targetId, commandTarget)
  }

  return (
    <div className="dsh-rws-page" data-panel={CONNECTIONS_PANEL_ID}>
      <div className="dsh-rws-head">
        <div className="dsh-rws-heading">
          <h1 className="dsh-rws-head-title">{t('connections.title')}</h1>
          <p className="dsh-rws-subtitle">{t('connections.subtitle')}</p>
        </div>
        <div className="dsh-rws-actions">
          <Button
            data-testid="dsh-rws-new"
            variant="primary"
            size="sm"
            icon={<IconPlusOutlineRegular size={12} />}
            disabled={!enabled}
            onClick={() => { requestNewConnection(commandTarget) }}
          >
            {t('connections.new')}
          </Button>
          <Button
            data-testid="dsh-rws-back"
            variant="ghost"
            size="sm"
            icon={<IconChevronLeftOutlineRegular size={12} />}
            disabled={!enabled}
            onClick={() => { requestClosePortal(commandTarget) }}
          >
            {t('connections.back')}
          </Button>
          <Button
            data-testid="dsh-rws-refresh"
            variant="outline"
            size="sm"
            icon={<IconRefreshOutlineRegular size={12} />}
            onClick={() => { targetsFeed.refresh() }}
          >
            {t('connections.refresh')}
          </Button>
        </div>
      </div>
      <div className="dsh-rws-body">
        <Notice sync={feed.sync} standalone={!embedded} />
        {!feed.loaded && feed.sync === 'loading'
          ? <p className="dsh-rws-hint" role="status" data-testid="dsh-rws-loading">{t('connections.loading')}</p>
          : !feed.loaded
            // Every read so far failed: the warn note above already says the list
            // is unavailable, and an empty state here would read as "no
            // connections" (protocol §16.14 forbids that).
            ? null
            : snapshot.targets.length === 0
              ? (
                <div className="dsh-rws-empty" data-testid="dsh-rws-empty">
                  <p className="dsh-rws-empty-title">{t('connections.empty')}</p>
                  <p className="dsh-rws-hint">{t('connections.empty.hint')}</p>
                </div>
              )
              : (
                <ul className="dsh-rws-list" data-testid="dsh-rws-list">
                  {snapshot.targets.map(target => (
                    <ConnectionRow
                      key={target.targetId}
                      target={target}
                      active={target.targetId === activeId}
                      enabled={enabled}
                      onSwitch={switchRow}
                    />
                  ))}
                </ul>
              )}
        {feed.loaded && (
          <p className="dsh-rws-hint" data-testid="dsh-rws-count">{t('connections.count', { count: snapshot.targets.length })}</p>
        )}
      </div>
    </div>
  )
}
