//#region src/protocol.ts
/**
* v1 profile-plugin protocol shared by dsh-remote-workspace and
* dsh-remote-workspace-server.
*
* Wire contract: doc/refactor-v1-protocol.md (frozen §16). Keep this file
* byte-for-byte identical in both repositories.
*/
/** v1 client host ↔ profile server plugin protocol revision. */
const REMOTE_WORKSPACE_PLUGIN_PROTOCOL = 1;
/** Plugin version this client build expects; the server package must match exactly. */
const REMOTE_WORKSPACE_PLUGIN_VERSION = "0.1.0-alpha.7";
/** Base path of the P1 plugin API on the profile server. */
const RW_ROUTE_PREFIX = "/dsh-remote-workspace-server";
/** Exact P1 routes (protocol §4.1 / §6 / §7 / §9). */
const RW_PATHS = {
	handshake: `${RW_ROUTE_PREFIX}/api/handshake`,
	rpc: `${RW_ROUTE_PREFIX}/api/rpc`,
	events: `${RW_ROUTE_PREFIX}/api/events`,
	mux: `${RW_ROUTE_PREFIX}/api/mux`,
	bootstrap: `${RW_ROUTE_PREFIX}/embed/bootstrap.js`,
	embedCss: `${RW_ROUTE_PREFIX}/embed/embed.css`,
	sessionEvents: `${RW_ROUTE_PREFIX}/api/session/events`,
	clientTargets: `${RW_ROUTE_PREFIX}/api/client/targets`
};
/** P1 request headers identifying the lease owner. */
const RW_HEADERS = {
	client: "x-dsh-rw-client",
	instance: "x-dsh-rw-instance",
	protocol: "x-dsh-rw-protocol"
};
/** P1 RPC method names (protocol §4.2 + §16). Frozen by protocol §16. */
const RW_METHODS = {
	heartbeat: "profile/heartbeat",
	release: "profile/release",
	status: "profile/status",
	cancelAll: "profile/cancel-all",
	workspaceList: "workspace/list",
	workspaceCreate: "workspace/create",
	workspaceRename: "workspace/rename",
	workspaceDelete: "workspace/delete",
	workspaceReorder: "workspace/reorder",
	sessionList: "session/list",
	sessionCreate: "session/create",
	sessionPrepareServer: "session/prepare-server",
	sessionRename: "session/rename",
	sessionFork: "session/fork",
	sessionPin: "session/pin",
	sessionArchive: "session/archive",
	sessionCancel: "session/cancel",
	sessionReorder: "session/reorder",
	persistList: "persist/list",
	persistStat: "persist/stat",
	persistCreate: "persist/create",
	persistOpen: "persist/open",
	persistRead: "persist/read",
	persistAppend: "persist/append",
	persistFlush: "persist/flush",
	persistClose: "persist/close",
	persistLocate: "persist/locate",
	executorGet: "executor/get",
	executorAssign: "executor/assign",
	executorPlanSwitch: "executor/plan-switch",
	executorSwitch: "executor/switch",
	executorRelease: "executor/release",
	registryStatus: "registry/status",
	registryRefresh: "registry/refresh",
	fsList: "fs/list",
	sessionTimeline: "session/timeline",
	sessionPrompt: "session/prompt",
	sessionCommands: "session/commands",
	sessionCommand: "session/command",
	sessionModelCatalog: "session/modelCatalog",
	sessionSelectModel: "session/selectModel",
	sessionApproval: "session/approval",
	sessionStatus: "session/status",
	clientTargets: "client/targets"
};
/** Stable error codes (protocol §12 + §16.12). */
const RW_ERROR_CODES = [
	"bad-request",
	"unauthorized",
	"forbidden",
	"lease-mismatch",
	"plugin-missing",
	"plugin-protocol-mismatch",
	"plugin-version-mismatch",
	"profile-mismatch",
	"profile-foreign-client",
	"profile-in-use",
	"profile-start-timeout",
	"profile-start-failed",
	"bootstrap-timeout",
	"registry-stale",
	"registry-unavailable",
	"registry-reload-failed",
	"registry-write-guard-unavailable",
	"workspace-path-invalid",
	"workspace-unknown",
	"workspace-not-empty",
	"session-not-found",
	"session/writer-held",
	"session/agent-busy",
	"session/archived-pin",
	"session/archive-activity",
	"executor-held",
	"executor-mode-conflict",
	"executor-assign-failed",
	"executor-switch-confirm-required",
	"executor-switch-busy",
	"handle-not-found",
	"persist-read-only",
	"persist-create-exists",
	"fs-error",
	"tunnel-unavailable",
	"upstream-timeout",
	"target-not-connected",
	"timeout",
	"internal",
	"profile-restart-preview-failed",
	"profile-locked",
	"mode-switch/preview-failed",
	"mode-switch/other-turns-cancelled-required",
	"mode-switch/cancel-failed",
	"mode-switch/preview-stale",
	"agent-compose-failed",
	"session-reveal-timeout",
	"shutdown-flush-timeout",
	"session-create-failed",
	"title-fold-failed",
	"agent-unavailable"
];
/** Embed ↔ client-page command revision (protocol §9.3 / §16.14). */
const RW_PORTAL_MESSAGE_VERSION = 1;
/** Query parameter naming the target currently mounted in the frame (protocol §9.3). */
const RW_EMBED_TARGET_PARAM = "dshRwTarget";
/** Longest accepted `targetId` in a portal command (target ids are opaque). */
const RW_PORTAL_TARGET_ID_MAX = 200;
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
/**
* Validate one iframe→parent message body.
*
* Accepts only the versioned command vocabulary; the caller still checks that
* the event origin matches and the source is the mounted frame.
* @param data - raw `MessageEvent.data`.
* @returns the command, or undefined for anything unrecognized.
*/
function parseRwPortalCommand(data) {
	if (data === null || typeof data !== "object") return void 0;
	const frame = data;
	if (frame["v"] !== 1) return void 0;
	switch (frame["type"]) {
		case "dsh-rw/switch-target": {
			const targetId = frame["targetId"];
			if (typeof targetId !== "string" || targetId.length === 0 || targetId.length > RW_PORTAL_TARGET_ID_MAX) return void 0;
			return rwPortalSwitchTarget(targetId);
		}
		case "dsh-rw/open-connect-dialog": return rwPortalOpenConnectDialog();
		case "dsh-rw/close-portal": return rwPortalClosePortal();
		default: return;
	}
}
//#endregion
export { REMOTE_WORKSPACE_PLUGIN_PROTOCOL, REMOTE_WORKSPACE_PLUGIN_VERSION, RW_EMBED_TARGET_PARAM, RW_ERROR_CODES, RW_HEADERS, RW_METHODS, RW_PATHS, RW_PORTAL_MESSAGE_VERSION, RW_ROUTE_PREFIX, parseRwPortalCommand, rwPortalClosePortal, rwPortalOpenConnectDialog, rwPortalSwitchTarget };
