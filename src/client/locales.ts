/**
 * Localization for the server profile's connection list.
 *
 * The official `@deepseek-ai/dsh-client-locale` package is injectable but not
 * required: this bundle owns a small `zh`/`en` dictionary and a module-level
 * {@link t} helper. `zh` is the source of truth and the default; `en` is typed
 * as `Record<LocaleKey, string>` so a missing or extra translation is a compile
 * error. The language comes from `<html lang>` (the embed bootstrap already sets
 * it from `dshRwLang`), so no shell service is needed.
 */

/** Simplified Chinese dictionary — the default and source of truth for keys. */
export const zh = {
  'connections.row': '远程连接',
  'connections.title': '远程连接',
  'connections.subtitle': '这些连接由客户端管理，点击即可切换。',
  'connections.empty': '还没有远程连接',
  'connections.empty.hint': '在客户端界面点「新建连接」添加一台远程主机。',
  'connections.loading': '正在读取连接…',
  'connections.stale': '同步不可用，正在显示上一次的连接列表。',
  'connections.standalone': '直接打开时无法切换连接；请从客户端界面进入。',
  'connections.count': '共 {count} 个连接',
  'connections.active': '当前',
  'connections.activate': '切换到 {label}',
  'connections.new': '新建连接',
  'connections.back': '返回本地界面',
  'connections.refresh': '刷新',
  'connections.endpoint': '{username}@{host}:{port}',
  'connections.endpoint.hostOnly': '{host}:{port}',
  'connections.endpoint.wsl': 'WSL',
  'connections.endpoint.wslDistro': 'WSL · {distro}',
  'remote.phase.connecting': '连接中',
  'remote.phase.ready': '已连接',
  'remote.phase.degraded': '已连接（受限）',
  'remote.phase.failed': '连接失败',
  'remote.phase.stopped': '已停止',
  'remote.phase.disconnected': '未连接',
} as const

/** Translation key union; adding a `zh` entry requires the `en` entry too. */
export type LocaleKey = keyof typeof zh

/** English dictionary; the compiler rejects a missing or extra key. */
export const en: Record<LocaleKey, string> = {
  'connections.row': 'Remote connections',
  'connections.title': 'Remote connections',
  'connections.subtitle': 'These connections are managed by the client; click one to switch.',
  'connections.empty': 'No remote connections yet',
  'connections.empty.hint': 'Use “New connection” in the client window to add a remote host.',
  'connections.loading': 'Reading connections…',
  'connections.stale': 'Sync is unavailable; showing the last known connection list.',
  'connections.standalone': 'Opened directly: switching connections needs the client window.',
  'connections.count': '{count} connections',
  'connections.active': 'Current',
  'connections.activate': 'Switch to {label}',
  'connections.new': 'New connection',
  'connections.back': 'Back to local',
  'connections.refresh': 'Refresh',
  'connections.endpoint': '{username}@{host}:{port}',
  'connections.endpoint.hostOnly': '{host}:{port}',
  'connections.endpoint.wsl': 'WSL',
  'connections.endpoint.wslDistro': 'WSL · {distro}',
  'remote.phase.connecting': 'Connecting',
  'remote.phase.ready': 'Connected',
  'remote.phase.degraded': 'Connected (limited)',
  'remote.phase.failed': 'Connection failed',
  'remote.phase.stopped': 'Stopped',
  'remote.phase.disconnected': 'Disconnected',
}

/** Supported languages; anything else reads as `zh`. */
export type Locale = 'zh' | 'en'

/** The dictionaries by language. */
const dictionaries: Record<Locale, Record<LocaleKey, string>> = { zh, en }

let activeLocale: Locale = 'zh'

/**
 * Map one `<html lang>` value onto a supported language.
 * @param lang - `document.documentElement.lang`, or undefined when absent.
 * @returns the language to serve from {@link t}.
 */
export function localeOf(lang: string | undefined): Locale {
  if (lang === undefined) return 'zh'
  return lang.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** @returns the active language. */
export function getLocale(): Locale {
  return activeLocale
}

/**
 * Switch the active language.
 * @param next - language to serve from {@link t}.
 */
export function setLocale(next: Locale): void {
  activeLocale = next
}

/**
 * Adopt the language announced by the document (`<html lang>`).
 * @param lang - `document.documentElement.lang`; omitted in non-DOM callers.
 * @returns the language now active.
 */
export function adoptDocumentLocale(lang?: string): Locale {
  activeLocale = localeOf(lang)
  return activeLocale
}

/**
 * Translate one dictionary key, interpolating `{name}` parameters.
 * @param key - dictionary key.
 * @param params - `{name}` values; an unknown name keeps its placeholder.
 * @returns the localized string (never empty: falls back to `zh`, then the key).
 */
export function t(key: LocaleKey, params?: Record<string, unknown>): string {
  const template = dictionaries[activeLocale][key] ?? zh[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined || value === null ? match : String(value)
  })
}
