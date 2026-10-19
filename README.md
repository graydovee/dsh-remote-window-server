# dsh-remote-workspace-server

**The remote half of [dsh-remote-workspace](https://github.com/graydovee/dsh-remote-workspace).**

This plugin runs *inside a DSH runtime on the SSH host*. It answers the official SSH
execution-world method set, adds the Remote Session RPCs, and keeps session logs on the
remote machine. The client keeps the agent loop, models, credentials and UI locally.

- Package `dsh-remote-workspace-server@0.1.0-alpha68` — bundle plugin, `manifestVersion: 1`
- Client half: [`dsh-remote-workspace`](https://github.com/graydovee/dsh-remote-workspace)
- Chinese: [README-zh.md](README-zh.md)

## What it provides

1. **The official execution world.** `hello`, `heartbeat`, `close`, `executable`, `fs.*`,
   `process.*` (prepare / start / wait / done / terminate), `terminal.*` (write / inspect /
   activity / resize / signal / environment) and `sandbox`. The official
   `dsh-fs-ssh`, `dsh-subprocess-ssh` and `dsh-sandbox-ssh` providers connect to it without
   modification — that is what makes a remote host a real workspace rather than a proxy.
2. **Remote Session RPCs** (protocol `3`, over the same multiplexed channel):

   | Method | Purpose |
   | --- | --- |
   | `server.hello` | Handshake: protocol, `serverId`, `installationId`, version, workspaces root, home |
   | `reg.list` / `reg.create` / `reg.rename` / `reg.delete` | The server-owned workspace catalogue (`workspaces.json`), with optional session activity |
   | `persist.list` / `persist.titles` | Sessions of one workspace; titles + last-activity time folded from the logs |
   | `persist.create` / `persist.open` | Write/read handles (both carry `inheritedEventCount`) |
   | `persist.append` / `persist.flush` / `persist.close` | Log writes by sequence |
   | `persist.locate` | Which workspace a session belongs to |
   | `persist.rename` | Append an official `session/title` event |

3. **Persistence delegation.** Everything below the RPCs is the official
   `sessionPersistence` service and the official JSONL backend
   (`@deepseek-ai/dsh-session-persistence-jsonl`, `compression: zstd`). This project defines
   **no second session file format and no second lock protocol**; `SessionAlreadyOwnedError`
   and friends are passed through untouched.

## Compatibility

### Declared in `package.json`

| What | Field | Value |
| --- | --- | --- |
| DSH host | `engines.dsh` | `0.2.1-rc.2` — exact, the only verified release |
| DSH packages | every `@deepseek-ai/dsh-*` in `peerDependencies` | `0.2.1-rc.2` — exact |
| Manifest format | `dsh.manifestVersion` | `1` |
| Node | `engines.node` | `^22.19.0 \|\| >=24.0.0` |
| Wire protocol | `REMOTE_SESSION_PROTOCOL` in `status.json` and `server.hello` | `3` |
| Verification | `devDependencies` | `@deepseek-ai/dsh-*` `0.2.1-rc.2`, `@deepseek-ai/cordis` `4.0.5` |

`engines.dsh` is what DSH reads at install time and at every profile start, and when the field
is present **that value alone decides** — the `@deepseek-ai/dsh*` peer ranges are ignored for
admission (they are pinned to the same exact string anyway, so the manifest never reads as
"0.2.x is fine"). `0.2.1-rc.2` is the only release this server has been verified against: its
`hello` must satisfy the strict `{ protocol, hash, kind, platform, nodeVersion, executable,
root, workspace, bootstrapHash? }` shape introduced there, and the JSONL backend it delegates
to became an `apply()`-mounted plugin row in that release. A newer `0.2.x` is untested, not
supported — accepting it means a new release whose `engines.dsh` names it.

On the remote this shows up at two boundaries: `dsh plugin` refuses a mismatched install before
pnpm runs, and a profile whose runtime does not match denies this plugin's row instead of
mounting it (the client then reports a failed connection). The escape hatch is a per-pair
exemption in the profile's `compatibility.json` (`dsh plugin --profile <p> allow-version
<package@version> --dsh-version <runtime> --accept-risk`), which is explicitly unsupported.

### Two artifacts, two version axes

| Artifact | Version axis | Who consumes it |
| --- | --- | --- |
| `lib/server.js` + `cordis.patch.yml` (this npm package) | `0.1.0-alphaN` (plugin version) | Uploaded by the client into the profile's `node_modules/dsh-remote-workspace` |
| `dsh-remote-server-<dshVersion>-<platform>.tar.gz` (runtime package) | `server-v<dsh version>` release tag | Downloaded by the client, or staged locally |

A runtime package is the staged `@deepseek-ai/dsh` dependency tree for **one target
platform/arch**, with that platform's native bindings installed and foreign siblings
stripped. Node is a separate deployment (a Node distribution unpacked beside it), and this
plugin arrives as the client's own upload. So **each released runtime package is pinned to
exactly one `@deepseek-ai/dsh` version**, and the tag names that version. The exact
`engines.dsh` above describes what this source tree supports; a given tarball is built against
one release, and both are advanced together in one release.

## How it is deployed

The client provisions the host in five steps (everything is `/bin/sh -c` with absolute paths;
the remote `PATH`, login shell and system npm are never used):

1. unpack a Node distribution under `~/.dsh/server/node` and the runtime package under
   `~/.dsh/server/dsh` (either uploaded or staged locally);
2. write the profile `~/.dsh/profiles/dsh-remote-server/` — `package.json`, `cordis.yml`,
   `cordis.patch.yml` and `pnpm-workspace.yaml`;
3. upload this plugin's `package.json`, `cordis.patch.yml` and `lib/*.js` into that profile's
   `node_modules/dsh-remote-workspace/`;
4. start `DSH_HOME=<remote home> PATH=<root>/node/bin:<root>/dsh/node_modules/.bin:$PATH
   exec <root>/dsh/node_modules/.bin/dsh --profile dsh-remote-server`;
5. the process's stdio becomes the multiplexed channel — there is **no listening port**.

The profile's patch layer mounts, in order: the official JSONL backend (root
`dshHomePath('remote-server-sessions')`, disabled when a `sessionPersistence` already
exists), `session-projection`, `subprocess-local`, `sandbox-local`, `sandbox-policy`,
`fs-sandbox`, and this plugin's row.

## Runtime behaviour

- **Transport**: stdio only. `status.json` is a 0600 discovery manifest
  (`serverId`, `installationId`, `version`, `protocol`, `transport: 'stdio'`, `pid`) written at
  startup and removed on dispose.
- **Leases**: the client heartbeats on the channel; when the lease lapses, every process the
  server is holding is released. `leaseMs` defaults to 30 s, `maxProcesses` to 128; both are
  configurable from the patch row.
- **Shutdown**: `exitOnClose` (default `true`) writes the close response, then leaves — the
  profile has no app of its own, so the server must not linger.
- **Framing**: `type(1B) + length(4B, big-endian) + payload` with a credit window. Unknown
  streams tolerate late `CREDIT/END/ABORT/OPEN_OK/OPEN_FAIL`; only `DATA` on an unknown stream
  is fatal (loss of frame sync).

## Session storage

```
~/.dsh/remote-server-sessions/<projectKey>/<sessionId>/   authoritative JSONL logs (zstd)
~/.dsh/remote-server/server-id                            stable server identity
~/.dsh/remote-server/workspaces.json                      server-owned workspace catalogue
~/.dsh/remote-server/status.json                          discovery manifest (0600)
```

- `workspaceId = sha256(serverId + NUL + canonical remote path)`, so it is stable across
  devices; `serverId` is persisted in `identityFile` and must never change.
- `createSession` overwrites the header cwd with the workspace path and passes
  `inheritedEventCount` through — without it the official backend rejects a forked
  (`isSeeded`) session header.
- `titles` folds the last `session/title` event per session (log-only, latest wins) and uses
  the last event's `time` as `updatedAt`; results are memoized by `(id, sizeBytes)` with a
  concurrency cap of 4, and a session that fails to read only loses its own title.
- `rename` never opens the session: it takes a write handle, reads the log length for the next
  contiguous `seq`, appends an official-shaped `session/title`, flushes and releases the lease.
- Closing a handle never deletes a log. Removing a workspace from the catalogue never touches
  `remote-server-sessions/**`.

## Sandbox on the remote

`dsh-sandbox-ssh` forwards `sandbox` requests here, so confinement is decided *on the remote
host*. When no sandbox backend is usable there (for example a WSL distro without
bubblewrap/Landlock), the server runs `argv` as requested and returns the official facts object
with `enforcement: 'partial'` — the remote world is itself the isolation boundary, and claiming
`full` would be the wrong failure direction. The returned shape is validated by the official
provider with a strict schema.

## Release process

Runtime packages are built and published **from this repository**:

```yaml
on: push: tags: ['server-v*']      # e.g. server-v0.2.1-rc.2
matrix: linux-x64/arm64 (glibc), darwin-x64/arm64
```

Each matrix entry produces `dsh-remote-server-<dshVersion>-<platform-arch>[-libc].tar.gz`
plus `.sha256` and `.manifest.json` under the tag's GitHub Release. There is deliberately **no
Windows entry**: the remote world is POSIX, and `artifactTag()` only accepts `linux | darwin`.

Local build (same code path as CI):

```bash
node scripts/build-server-package.mjs --all --dsh-version 0.2.1-rc.2
node scripts/build-server-package.mjs --platform linux --arch x64 --libc gnu --out dist-server
```

The staging code lives in `src/provision/package-build.ts`, a byte-identical copy of the
client's module: it installs `@deepseek-ai/dsh@<version>` for the target platform, pins the
native binding closure (`node-addon-require-builtin-*`,
`@deepseek-ai/node-addon-system-*`), strips foreign-platform siblings, and packs the result.

## Development

```bash
pnpm install
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run (session-store projection, ownership pass-through, titles, rename)
pnpm build        # tsdown → lib/ (server + protocol)
```

`src/protocol.ts`, `src/server/`, `src/frame/` and `src/provision/package-build.ts` are
**byte-identical** with the client repository — the client ships and tests its own copy of the
server bundle. Change any of them in both repositories, in the same release.

## License

MIT
