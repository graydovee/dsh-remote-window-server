/**
 * Plugin-owned stylesheet for the connection panel.
 *
 * The build does not process CSS for this bundle, so the browser half ships one
 * CSS string injected as a single `<style data-plugin="dsh-remote-workspace-server">`
 * element from `apply` — an effect, so hot reload disposes the tag with the rest
 * of the contribution. Colors/spacing come from the shell's `--dsw-*` tokens so
 * the panel follows the active theme and never fights the official sidebar.
 */

/** Marker attribute value for the injected `<style>` element. */
export const STYLE_PLUGIN_ID = 'dsh-remote-workspace-server'

/** The complete stylesheet. */
export const STYLE_TEXT = `
/* Page skeleton mirrors the shell's own pages: 48px gutters, an 80px header
   bar around the 960px content column, and the body as the only scroller. */
.dsh-rws-page {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 0 48px;
  color: var(--dsw-alias-label-primary);
}
.dsh-rws-head {
  flex: none;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
  max-width: 960px;
  padding: 28px 0 20px;
}
.dsh-rws-heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dsh-rws-head-title {
  margin: 0;
  font-size: 20px;
  font-weight: 500;
  line-height: 28px;
  color: var(--dsw-alias-label-primary);
}
.dsh-rws-subtitle {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rws-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  padding-top: 2px;
}
.dsh-rws-body {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  align-self: stretch;
  min-height: 0;
  overflow-y: auto;
  margin: 0 -48px;
  padding: 0 48px 48px;
}
.dsh-rws-body > * {
  width: 100%;
  max-width: 960px;
  margin-right: auto;
  margin-left: auto;
}
.dsh-rws-note {
  margin: 0;
  padding: 6px 8px;
  border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border, #e5e6eb);
  background: var(--dsw-alias-bg-secondary, #f7f8fa);
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rws-note[data-kind="warn"] {
  border-color: var(--dsw-alias-warning, #d48806);
  color: var(--dsw-alias-warning, #d48806);
}
.dsh-rws-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  list-style: none;
}
.dsh-rws-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 14px 16px;
}
.dsh-rws-row + .dsh-rws-row {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.dsh-rws-row:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-secondary));
}
.dsh-rws-row[data-active="true"] {
  background: var(--dsw-alias-bg-secondary);
}
.dsh-rws-open {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-rws-open:disabled {
  cursor: default;
  opacity: 0.72;
}
.dsh-rws-dot {
  display: inline-flex;
  flex: 0 0 auto;
}
.dsh-rws-label {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 1px;
}
.dsh-rws-name {
  font-size: 14px;
  line-height: 20px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-rws-meta {
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-rws-badge {
  align-self: center;
  flex: 0 0 auto;
  margin-left: auto;
  padding: 1px 8px;
  border-radius: 999px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-rws-empty {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 32px 16px;
  border: 1px dashed var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-lg);
  text-align: center;
}
.dsh-rws-empty-title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}
.dsh-rws-hint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-rws-nav-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: inherit;
}
.dsh-rws-nav-icon[data-active="true"] {
  color: var(--dsw-alias-label-primary);
}
`

let installed = false

/**
 * Insert the stylesheet once per document.
 * @returns a disposer that removes the tag when the plugin is disposed.
 */
export function ensureStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const selector = `style[data-plugin="${STYLE_PLUGIN_ID}"]`
  if (installed && document.querySelector(selector) !== null) return () => {}
  document.querySelector(selector)?.remove()
  const style = document.createElement('style')
  style.setAttribute('data-plugin', STYLE_PLUGIN_ID)
  style.textContent = STYLE_TEXT
  document.head.appendChild(style)
  installed = true
  return () => {
    style.remove()
    installed = false
  }
}
