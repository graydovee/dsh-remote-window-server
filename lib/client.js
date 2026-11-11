window.__ModuleLoader__.load({
	id: "dsh-remote-workspace-server",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/locales.ts
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
		const zh = {
			"connections.row": "远程连接",
			"connections.title": "远程连接",
			"connections.subtitle": "这些连接由客户端管理，点击即可切换。",
			"connections.empty": "还没有远程连接",
			"connections.empty.hint": "在客户端界面点「新建连接」添加一台远程主机。",
			"connections.loading": "正在读取连接…",
			"connections.stale": "同步不可用，正在显示上一次的连接列表。",
			"connections.standalone": "直接打开时无法切换连接；请从客户端界面进入。",
			"connections.count": "共 {count} 个连接",
			"connections.active": "当前",
			"connections.activate": "切换到 {label}",
			"connections.new": "新建连接",
			"connections.back": "返回本地界面",
			"connections.refresh": "刷新",
			"connections.endpoint": "{username}@{host}:{port}",
			"connections.endpoint.hostOnly": "{host}:{port}",
			"connections.endpoint.wsl": "WSL",
			"connections.endpoint.wslDistro": "WSL · {distro}",
			"remote.phase.connecting": "连接中",
			"remote.phase.ready": "已连接",
			"remote.phase.degraded": "已连接（受限）",
			"remote.phase.failed": "连接失败",
			"remote.phase.stopped": "已停止",
			"remote.phase.disconnected": "未连接"
		};
		/** The dictionaries by language. */
		const dictionaries = {
			zh,
			en: {
				"connections.row": "Remote connections",
				"connections.title": "Remote connections",
				"connections.subtitle": "These connections are managed by the client; click one to switch.",
				"connections.empty": "No remote connections yet",
				"connections.empty.hint": "Use “New connection” in the client window to add a remote host.",
				"connections.loading": "Reading connections…",
				"connections.stale": "Sync is unavailable; showing the last known connection list.",
				"connections.standalone": "Opened directly: switching connections needs the client window.",
				"connections.count": "{count} connections",
				"connections.active": "Current",
				"connections.activate": "Switch to {label}",
				"connections.new": "New connection",
				"connections.back": "Back to local",
				"connections.refresh": "Refresh",
				"connections.endpoint": "{username}@{host}:{port}",
				"connections.endpoint.hostOnly": "{host}:{port}",
				"connections.endpoint.wsl": "WSL",
				"connections.endpoint.wslDistro": "WSL · {distro}",
				"remote.phase.connecting": "Connecting",
				"remote.phase.ready": "Connected",
				"remote.phase.degraded": "Connected (limited)",
				"remote.phase.failed": "Connection failed",
				"remote.phase.stopped": "Stopped",
				"remote.phase.disconnected": "Disconnected"
			}
		};
		let activeLocale = "zh";
		/**
		* Map one `<html lang>` value onto a supported language.
		* @param lang - `document.documentElement.lang`, or undefined when absent.
		* @returns the language to serve from {@link t}.
		*/
		function localeOf(lang) {
			if (lang === void 0) return "zh";
			return lang.toLowerCase().startsWith("en") ? "en" : "zh";
		}
		/**
		* Adopt the language announced by the document (`<html lang>`).
		* @param lang - `document.documentElement.lang`; omitted in non-DOM callers.
		* @returns the language now active.
		*/
		function adoptDocumentLocale(lang) {
			activeLocale = localeOf(lang);
			return activeLocale;
		}
		/**
		* Translate one dictionary key, interpolating `{name}` parameters.
		* @param key - dictionary key.
		* @param params - `{name}` values; an unknown name keeps its placeholder.
		* @returns the localized string (never empty: falls back to `zh`, then the key).
		*/
		function t(key, params) {
			const template = dictionaries[activeLocale][key] ?? zh[key] ?? key;
			if (params === void 0) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => {
				const value = params[name];
				return value === void 0 || value === null ? match : String(value);
			});
		}
		/**
		* Build the command a server-side list row sends when it is clicked.
		* @param targetId - the target the client page should activate.
		* @returns the versioned command payload.
		*/
		function rwPortalSwitchTarget(targetId) {
			return {
				v: 1,
				type: "dsh-rw/switch-target",
				targetId
			};
		}
		/** @returns the command asking the client page to open its connect dialog. */
		function rwPortalOpenConnectDialog() {
			return {
				v: 1,
				type: "dsh-rw/open-connect-dialog"
			};
		}
		/** @returns the command asking the client page to drop the frame. */
		function rwPortalClosePortal() {
			return {
				v: 1,
				type: "dsh-rw/close-portal"
			};
		}
		//#endregion
		//#region src/client/commands.ts
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
		/**
		* Whether the page runs inside a parent frame.
		*
		* When the profile's UI is opened directly (`window.parent === window`) there is
		* no client page to act on a command, so the panel renders the list read-only
		* (protocol §16.14 "失败语义").
		* @param win - the page's `window` (or a test double).
		* @returns true when a distinct parent exists.
		*/
		function isEmbedded(win) {
			return win.parent !== void 0 && win.parent !== win;
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
		function portalCommandTarget(win) {
			if (!isEmbedded(win)) return void 0;
			const origin = win.location?.origin;
			if (origin === void 0 || origin === "") return void 0;
			const parent = win.parent;
			const postMessage = parent?.postMessage;
			if (typeof postMessage !== "function") return void 0;
			return {
				post: (message, targetOrigin) => {
					postMessage.call(parent, message, targetOrigin);
				},
				origin
			};
		}
		/**
		* Deliver one command to the client page.
		* @param command - a builder result from `../protocol.ts`.
		* @param target - delivery target; when omitted the command is dropped.
		* @returns whether a command was posted.
		*/
		function postPortalCommand(command, target) {
			if (target === void 0) return false;
			target.post(command, target.origin);
			return true;
		}
		/**
		* Ask the client to activate one target (and remount the frame).
		* @param targetId - the row's target id.
		* @param target - delivery target.
		* @returns whether a command was posted.
		*/
		function switchToTarget(targetId, target) {
			if (targetId === "") return false;
			return postPortalCommand(rwPortalSwitchTarget(targetId), target);
		}
		/**
		* Ask the client to open its connection dialog (the dialog lives in the client
		* shell, outside the frame, so it can sit above the frame).
		* @param target - delivery target.
		* @returns whether a command was posted.
		*/
		function requestNewConnection(target) {
			return postPortalCommand(rwPortalOpenConnectDialog(), target);
		}
		/**
		* Ask the client to drop the frame and show its own connection list again.
		* @param target - delivery target.
		* @returns whether a command was posted.
		*/
		function requestClosePortal(target) {
			return postPortalCommand(rwPortalClosePortal(), target);
		}
		//#endregion
		//#region src/client/targets-model.ts
		/**
		* Pure view-model helpers for the server profile's connection list.
		*
		* Everything here is DOM-free so the wire contract, the row selection and the
		* row copy can be asserted in Node (`tests/client-connections-section.test.ts`)
		* without a browser or React. The React panel composes these functions; the
		* polling transport lives in `data.ts`.
		*/
		/** Profile-relative route serving the published snapshot (protocol §16.14). */
		const CLIENT_TARGETS_ROUTE = "dsh-remote-workspace-server/api/client/targets";
		/** Empty value served before the client publishes anything. */
		function emptySnapshot() {
			return {
				clientId: "",
				updatedAt: 0,
				targets: []
			};
		}
		/**
		* The URL the panel fetches.
		*
		* Relative on purpose: the embedded page is served through the client host's
		* portal, so a leading slash would escape the mount and a bare path stays on the
		* profile's own origin (`<mount>/dsh-remote-workspace-server/api/client/targets`).
		* @returns the relative request path.
		*/
		function targetsRequestPath() {
			return CLIENT_TARGETS_ROUTE;
		}
		/** Whether a value is a usable target id string. */
		function isTargetId(value) {
			return typeof value === "string" && value.length > 0;
		}
		/**
		* Narrow one row, dropping anything this version cannot render.
		* @param value - one `targets[]` entry.
		* @returns the row, or undefined when required fields are missing.
		*/
		function parseTargetRow(value) {
			if (value === null || typeof value !== "object") return void 0;
			const row = value;
			if (!isTargetId(row["targetId"])) return void 0;
			if (row["kind"] !== "ssh" && row["kind"] !== "wsl") return void 0;
			const phase = row["phase"];
			if (!isPhase(phase)) return void 0;
			const label = typeof row["label"] === "string" && row["label"] !== "" ? row["label"] : row["targetId"];
			return {
				targetId: row["targetId"],
				label,
				kind: row["kind"],
				...typeof row["host"] === "string" && row["host"] !== "" ? { host: row["host"] } : {},
				...typeof row["port"] === "number" && Number.isSafeInteger(row["port"]) ? { port: row["port"] } : {},
				...typeof row["username"] === "string" && row["username"] !== "" ? { username: row["username"] } : {},
				phase,
				...row["active"] === true ? { active: true } : {}
			};
		}
		/** Whether a value is one of the phases the panel knows. */
		function isPhase(value) {
			return value === "connecting" || value === "ready" || value === "degraded" || value === "failed" || value === "stopped" || value === "disconnected";
		}
		/**
		* Parse one `GET api/client/targets` body.
		*
		* Accepts the P1 envelope (`{ ok, value }`) and a bare value, so a proxy or a
		* test fixture cannot change the shape of what the panel can read.
		* @param payload - parsed JSON (or anything).
		* @returns the snapshot, or undefined when the payload is unusable.
		*/
		function parseTargetsValue(payload) {
			if (payload === null || typeof payload !== "object") return void 0;
			const envelope = payload;
			const source = envelope["ok"] === true && envelope["value"] !== void 0 ? envelope["value"] : payload;
			if (source === null || typeof source !== "object") return void 0;
			const value = source;
			if (!Array.isArray(value["targets"])) return void 0;
			const updatedAt = typeof value["updatedAt"] === "number" && Number.isFinite(value["updatedAt"]) ? value["updatedAt"] : 0;
			const targets = [];
			for (const raw of value["targets"]) {
				const row = parseTargetRow(raw);
				if (row !== void 0) targets.push(row);
			}
			return {
				clientId: typeof value["clientId"] === "string" ? value["clientId"] : "",
				updatedAt,
				...isTargetId(value["activeTargetId"]) ? { activeTargetId: value["activeTargetId"] } : {},
				targets
			};
		}
		/**
		* Read one query parameter from a search string.
		* @param search - `location.search` (leading `?` optional).
		* @param name - parameter name.
		* @returns the decoded value, or undefined when absent/empty.
		*/
		function readSearchParam(search, name) {
			const value = new URLSearchParams(search).get(name);
			return value === null || value === "" ? void 0 : value;
		}
		/**
		* The row the panel highlights.
		*
		* The frame's own `dshRwTarget` wins (it names the target this document shows,
		* even when the snapshot is momentarily stale); the snapshot's `activeTargetId`
		* is the fallback the server can still offer without the query string.
		* @param snapshot - published snapshot.
		* @param search - `location.search`.
		* @returns the target id to highlight, or undefined.
		*/
		function selectActiveTargetId(snapshot, search) {
			return readSearchParam(search, "dshRwTarget") ?? snapshot.activeTargetId;
		}
		/**
		* The endpoint line of one row.
		*
		* SSH shows `user@host:port` (whichever parts the client published); a WSL
		* target has no reachable host name, so it shows its distribution instead.
		* @param target - one published row.
		* @returns the localized endpoint line.
		*/
		function formatEndpoint(target) {
			if (target.kind === "wsl") return target.host === void 0 ? t("connections.endpoint.wsl") : t("connections.endpoint.wslDistro", { distro: target.host });
			const parts = {
				username: target.username,
				host: target.host,
				port: target.port
			};
			if (target.username !== void 0 && target.host !== void 0 && target.port !== void 0) return t("connections.endpoint", parts);
			if (target.host !== void 0) return target.port === void 0 ? target.host : t("connections.endpoint.hostOnly", {
				host: target.host,
				port: target.port
			});
			return target.username ?? "";
		}
		/** Localized phase copy. */
		function phaseLabel(phase) {
			return t(PHASE_LABEL_KEYS[phase]);
		}
		/** Phase → dictionary key. */
		const PHASE_LABEL_KEYS = {
			connecting: "remote.phase.connecting",
			ready: "remote.phase.ready",
			degraded: "remote.phase.degraded",
			failed: "remote.phase.failed",
			stopped: "remote.phase.stopped",
			disconnected: "remote.phase.disconnected"
		};
		//#endregion
		//#region src/client/data.ts
		const LOADING = {
			snapshot: emptySnapshot(),
			sync: "loading",
			loaded: false
		};
		/**
		* Create one feed.
		* @param options - transport injection for tests; production uses `globalThis`.
		* @returns the feed.
		*/
		function createTargetsFeed(options = {}) {
			let state = LOADING;
			const listeners = /* @__PURE__ */ new Set();
			let subscribers = 0;
			let timer;
			let inFlight = false;
			let disposed = false;
			const publish = (next) => {
				state = next;
				for (const listener of listeners) listener();
			};
			const read = async () => {
				if (inFlight || disposed) return;
				inFlight = true;
				try {
					const doFetch = options.fetch ?? defaultFetch();
					if (doFetch === void 0) {
						publish({
							...state,
							sync: "stale"
						});
						return;
					}
					const response = await doFetch(options.path?.() ?? targetsRequestPath());
					if (!response.ok) {
						publish({
							...state,
							sync: "stale"
						});
						return;
					}
					const parsed = parseTargetsValue(await response.json());
					if (parsed === void 0) {
						publish({
							...state,
							sync: "stale"
						});
						return;
					}
					publish({
						snapshot: parsed,
						sync: "ok",
						loaded: true
					});
				} catch {
					publish({
						...state,
						sync: "stale"
					});
				} finally {
					inFlight = false;
				}
			};
			const attachWindowListeners = () => {
				const win = typeof window === "undefined" ? void 0 : window;
				const doc = typeof document === "undefined" ? void 0 : document;
				if (win === void 0 || doc === void 0) return () => {};
				const onVisibility = () => {
					if (doc.visibilityState === "visible") read();
				};
				const onFocus = () => {
					read();
				};
				doc.addEventListener("visibilitychange", onVisibility);
				win.addEventListener("focus", onFocus);
				return () => {
					doc.removeEventListener("visibilitychange", onVisibility);
					win.removeEventListener("focus", onFocus);
				};
			};
			let detachWindow;
			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				snapshot() {
					return state;
				},
				start() {
					subscribers += 1;
					if (subscribers === 1) {
						disposed = false;
						read();
						timer = setInterval(() => {
							read();
						}, options.pollMs ?? 2e3);
						detachWindow = attachWindowListeners();
					}
					let stopped = false;
					return () => {
						if (stopped) return;
						stopped = true;
						subscribers -= 1;
						if (subscribers > 0) return;
						disposed = true;
						if (timer !== void 0) clearInterval(timer);
						timer = void 0;
						detachWindow?.();
						detachWindow = void 0;
					};
				},
				refresh() {
					read();
				}
			};
		}
		/** `globalThis.fetch` when the page has one. */
		function defaultFetch() {
			const candidate = globalThis.fetch;
			if (typeof candidate !== "function") return void 0;
			return async (input) => await candidate(input);
		}
		/** The page-wide feed; one timer regardless of how many components read it. */
		const targetsFeed = createTargetsFeed();
		//#endregion
		//#region src/client/section.tsx
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
		/** The panel id shared by the `sidebar.panellist` row and the `main` entry. */
		const CONNECTIONS_PANEL_ID = "dsh-remote-workspace";
		/** Dot appearance per phase: live = green, degraded = warning, gone = idle. */
		const PHASE_DOTS = {
			connecting: "ongoing",
			ready: "done",
			degraded: "warning",
			failed: "error",
			stopped: "idle",
			disconnected: "idle"
		};
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
		function ConnectionsNavRow(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsh-rws-nav-icon",
				"data-testid": "dsh-rws-nav-row",
				"data-panel": CONNECTIONS_PANEL_ID,
				"data-active": props.active === true ? "true" : void 0,
				title: t("connections.row"),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconGlobeOutlineRegular, { size: props.size ?? 16 })
			});
		}
		/** Current `location.search`, or '' outside a browser. */
		function currentSearch() {
			if (typeof window === "undefined") return "";
			return window.location?.search ?? "";
		}
		/**
		* Whether this page can drive the client (it is inside the client's frame).
		* @returns true when a parent window with a postMessage sink exists.
		*/
		function canCommand() {
			if (typeof window === "undefined") return false;
			return isEmbedded(window);
		}
		/** One connection row. */
		function ConnectionRow(props) {
			const { target, active, enabled } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
				className: "dsh-rws-row",
				"data-active": active ? "true" : void 0,
				"data-target-id": target.targetId,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dsh-rws-open",
					"data-testid": "dsh-rws-row",
					"data-phase": target.phase,
					disabled: !enabled,
					"aria-current": active ? "true" : void 0,
					"aria-label": t("connections.activate", { label: target.label }),
					title: enabled ? t("connections.activate", { label: target.label }) : t("connections.standalone"),
					onClick: () => {
						props.onSwitch(target.targetId);
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-rws-dot",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
								state: PHASE_DOTS[target.phase],
								size: 8
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsh-rws-label",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-rws-name",
								children: target.label
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsh-rws-meta",
								children: `${formatEndpoint(target)} · ${phaseLabel(target.phase)}`
							})]
						}),
						active && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsh-rws-badge",
							children: t("connections.active")
						})
					]
				})
			});
		}
		/** The sync/problem note above the list, or nothing when everything is fine. */
		function Notice(props) {
			if (props.sync === "stale") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-rws-note",
				"data-kind": "warn",
				role: "status",
				"data-testid": "dsh-rws-stale",
				children: t("connections.stale")
			});
			if (props.standalone) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "dsh-rws-note",
				"data-testid": "dsh-rws-standalone",
				children: t("connections.standalone")
			});
			return null;
		}
		/**
		* The connection list page (`main` slot).
		* @returns the page.
		*/
		function ConnectionsPanel() {
			const feed = (0, react.useSyncExternalStore)(targetsFeed.subscribe, () => targetsFeed.snapshot(), () => targetsFeed.snapshot());
			const [pendingId, setPendingId] = (0, react.useState)(void 0);
			const [embedded, setEmbedded] = (0, react.useState)(() => canCommand());
			(0, react.useEffect)(() => {
				const stop = targetsFeed.start();
				setEmbedded(canCommand());
				return stop;
			}, []);
			const commandTarget = embedded && typeof window !== "undefined" ? portalCommandTarget(window) : void 0;
			const enabled = commandTarget !== void 0;
			const snapshot = feed.snapshot;
			const activeId = pendingId ?? selectActiveTargetId(snapshot, currentSearch());
			const switchRow = (targetId) => {
				setPendingId(targetId);
				switchToTarget(targetId, commandTarget);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsh-rws-page",
				"data-panel": CONNECTIONS_PANEL_ID,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-rws-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-rws-heading",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
							className: "dsh-rws-head-title",
							children: t("connections.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-rws-subtitle",
							children: t("connections.subtitle")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsh-rws-actions",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								"data-testid": "dsh-rws-new",
								variant: "primary",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 12 }),
								disabled: !enabled,
								onClick: () => {
									requestNewConnection(commandTarget);
								},
								children: t("connections.new")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								"data-testid": "dsh-rws-back",
								variant: "ghost",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconChevronLeftOutlineRegular, { size: 12 }),
								disabled: !enabled,
								onClick: () => {
									requestClosePortal(commandTarget);
								},
								children: t("connections.back")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								"data-testid": "dsh-rws-refresh",
								variant: "outline",
								size: "sm",
								icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineRegular, { size: 12 }),
								onClick: () => {
									targetsFeed.refresh();
								},
								children: t("connections.refresh")
							})
						]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsh-rws-body",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Notice, {
							sync: feed.sync,
							standalone: !embedded
						}),
						!feed.loaded && feed.sync === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-rws-hint",
							role: "status",
							"data-testid": "dsh-rws-loading",
							children: t("connections.loading")
						}) : !feed.loaded ? null : snapshot.targets.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsh-rws-empty",
							"data-testid": "dsh-rws-empty",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsh-rws-empty-title",
								children: t("connections.empty")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dsh-rws-hint",
								children: t("connections.empty.hint")
							})]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							className: "dsh-rws-list",
							"data-testid": "dsh-rws-list",
							children: snapshot.targets.map((target) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConnectionRow, {
								target,
								active: target.targetId === activeId,
								enabled,
								onSwitch: switchRow
							}, target.targetId))
						}),
						feed.loaded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "dsh-rws-hint",
							"data-testid": "dsh-rws-count",
							children: t("connections.count", { count: snapshot.targets.length })
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/styles.ts
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
		const STYLE_PLUGIN_ID = "dsh-remote-workspace-server";
		/** The complete stylesheet. */
		const STYLE_TEXT = `
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
`;
		let installed = false;
		/**
		* Insert the stylesheet once per document.
		* @returns a disposer that removes the tag when the plugin is disposed.
		*/
		function ensureStyles() {
			if (typeof document === "undefined") return () => {};
			const selector = `style[data-plugin="${STYLE_PLUGIN_ID}"]`;
			if (installed && document.querySelector(selector) !== null) return () => {};
			document.querySelector(selector)?.remove();
			const style = document.createElement("style");
			style.setAttribute("data-plugin", STYLE_PLUGIN_ID);
			style.textContent = STYLE_TEXT;
			document.head.appendChild(style);
			installed = true;
			return () => {
				style.remove();
				installed = false;
			};
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* Row order in the shell's sidebar panellist.
		*
		* Ascending, after the shipped rows (插件 0, 自动化任务 10) so the row sits at the
		* bottom of the navigation list, directly above the trailing 更多 menu.
		*/
		const SIDEBAR_ORDER = 100;
		/** Client services this plugin needs: `slots` only. */
		const inject = ["slots"];
		/**
		* Plugin body: stylesheet, the sidebar row and the connection list page.
		* @param ctx - the client context.
		*/
		function apply(ctx) {
			adoptDocumentLocale(typeof document === "undefined" ? void 0 : document.documentElement.lang);
			ctx.effect(() => ensureStyles(), "dsh-remote-workspace-server: stylesheet");
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: CONNECTIONS_PANEL_ID,
				order: SIDEBAR_ORDER,
				label: () => t("connections.row"),
				registrant: "dsh-remote-workspace-server"
			}, ConnectionsNavRow));
			try {
				ctx.slots.inject("main", () => ctx.slots.register({
					name: "main",
					key: CONNECTIONS_PANEL_ID,
					label: () => t("connections.title")
				}, ConnectionsPanel));
			} catch (error) {
				console.error("[dsh-remote-workspace-server] connections main panel registration failed", error);
			}
		}
		//#endregion
		exports.CONNECTIONS_PANEL_ID = CONNECTIONS_PANEL_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
