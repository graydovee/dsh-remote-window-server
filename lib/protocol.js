//#region src/protocol.ts
const REMOTE_SESSION_PROTOCOL = 3;
const REMOTE_METHODS = {
	hello: "server.hello",
	listWorkspaces: "reg.list",
	createWorkspace: "reg.create",
	renameWorkspace: "reg.rename",
	deleteWorkspace: "reg.delete",
	listSessions: "persist.list",
	listTitles: "persist.titles",
	renameSession: "persist.rename",
	createSession: "persist.create",
	openSession: "persist.open",
	appendSession: "persist.append",
	flushSession: "persist.flush",
	closeSession: "persist.close",
	locateSession: "persist.locate"
};
//#endregion
export { REMOTE_METHODS, REMOTE_SESSION_PROTOCOL };
