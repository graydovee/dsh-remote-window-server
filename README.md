# dsh-remote-workspace-server

English | [中文](README-zh.md)

**The remote half of [dsh-remote-workspace](https://github.com/graydovee/dsh-remote-workspace).**
This plugin runs *inside a DSH runtime on the SSH host*: it answers the official SSH
execution-world method set, adds the Remote Session RPCs, and keeps session logs on the remote
machine. The client keeps the agent loop, models, credentials and UI locally.

- You normally never install this by hand — the client deploys a runtime, uploads this package
  and starts it over stdio.
- Verified against **DSH `0.2.1-rc.2`** only; the exact `engines.dsh` pin says so.

## Quick start

### 1. Requirements

| Where | Requirement |
| --- | --- |
| Remote host | POSIX with `/bin/sh`, `tar`, `chmod` and a writable `$HOME` |
| Runtime | `@deepseek-ai/dsh` `0.2.1-rc.2` plus a Node distribution, both deployed into `~/.dsh/server` by the client |
| Node on the host | **Not required** — the deployed Node runs the deployed `dsh` |

### 2. Run it by hand (debugging only)

The client performs these steps for you; they are listed so a manual run reproduces exactly what
it does.

1. Stage a runtime package (same code path as CI):

   ```bash
   node scripts/build-server-package.mjs --platform linux --arch x64 --libc gnu --out dist-server
   ```

2. On the host, unpack the tarball into `~/.dsh/server/dsh` and a Node distribution into
   `~/.dsh/server/node`.
3. Write the profile `~/.dsh/profiles/dsh-remote-server/` — `package.json`, `cordis.yml`,
   `cordis.patch.yml` (the client generates all three; its `cordis.patch.yml` is the source of
   the rows below) — and put this package under
   `node_modules/dsh-remote-workspace/`.
4. Start it on stdio:

   ```bash
   DSH_HOME="$HOME" \
   PATH="$HOME/.dsh/server/node/bin:$HOME/.dsh/server/dsh/node_modules/.bin:$PATH" \
   exec "$HOME/.dsh/server/dsh/node_modules/.bin/dsh" --profile dsh-remote-server
   ```

There is **no listening port**: the process speaks the multiplexed protocol on stdin/stdout, and
`~/.dsh/remote-server/status.json` (mode 0600) announces `serverId`, `installationId`,
`version`, `protocol`, `transport: 'stdio'` and `pid`. A manual run that prints nothing and
exits is usually a missing `sessionPersistence` provider — the profile's patch layer must mount
the official JSONL backend first.

### 3. Configure

The client writes these into the `remote-workspace-server` row of the remote profile's
`cordis.patch.yml`; set them by hand only for a custom deployment.

| Field | Default | Meaning |
| --- | --- | --- |
| `workspace` | `process.cwd()` | Workspace reported when the client does not name one |
| `leaseMs` | `30000` | Client lease in ms, refreshed by `heartbeat`; when it lapses every owned process is released |
| `maxProcesses` | `128` | Maximum prepared or running process handles |
| `exitOnClose` | `true` | Exit the process after a `close` request (a dedicated server profile wants this) |
| `serverId` | generated | Stable server identity; part of every `workspaceId` — **never change it** |
| `installationId` | generated | Installation identity used for multi-instance discovery |
| `identityFile` | empty | File holding the stable `serverId` |
| `workspaceIndex` | empty | Standalone workspace list; ignored when `workspaceRegistry` exists |
| `statusFile` | empty | Discovery manifest path |
| `version` | package version | Reported by `server.hello` and `status.json` |

### 4. What it serves

Official execution-world methods (the `dsh-fs-ssh` / `dsh-subprocess-ssh` /
`dsh-sandbox-ssh` providers connect to these unchanged):

| Group | Methods |
| --- | --- |
| Session of the channel | `hello`, `heartbeat`, `close` |
| Filesystem | `fs.resolve`, `fs.lstat`, `fs.stat`, `fs.list`, `fs.readText`, `fs.stream`, `fs.next`, `fs.streamClose`, `fs.readBytes`, `fs.readRange`, `fs.write`, `fs.edit` |
| Processes | `executable`, `process.prepare`, `process.start`, `process.wait`, `process.done`, `process.terminate` |
| Terminals | `terminal.environment`, `terminal.write`, `terminal.inspect`, `terminal.activity`, `terminal.resize`, `terminal.signal` |
| Sandbox | `sandbox` |

Remote Session RPCs (wire protocol `3`, same channel):

| Method | Purpose |
| --- | --- |
| `server.hello` | Protocol, `serverId`, `installationId`, version, workspaces root, home |
| `reg.list` / `reg.create` / `reg.rename` / `reg.delete` | The server-owned workspace catalogue (`workspaces.json`), with optional session activity |
| `persist.list` / `persist.titles` | Sessions of one workspace; titles + last activity folded from the logs |
| `persist.create` / `persist.open` | Write/read handles (both carry `inheritedEventCount`) |
| `persist.append` / `persist.flush` / `persist.close` | Log writes by sequence |
| `persist.locate` | Which workspace a session belongs to |
| `persist.rename` | Append an official `session/title` event |

### 5. Day-to-day

- **One server process per target.** `persist.create` returns an in-memory handle, so every
  `persist.*` for that workspace must reach the same process; the client keeps one channel per
  target for this reason.
- **The handle table is in memory.** A restart (idle lease, explicit stop, or a redeploy after a
  plugin update) loses it; the client re-opens once on `unknown remote session handle`.
- **Closing never deletes.** A session log survives `persist.close`, removing a workspace, and
  a stopped server.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| The row is denied and the client reports a failed connection | The runtime's DSH version does not match this plugin's exact `engines.dsh` | Deploy the `0.2.1-rc.2` runtime, or exempt the pair — see [Compatibility](#compatibility) |
| `session "…" not found` right after a restart | The in-memory handle table is gone | Re-open the session; the client retries once automatically |
| Long-running commands are killed while idle | The client stopped heartbeating, so the lease lapsed | Keep the connection open; raise `leaseMs` only for a custom client |
| `status.json` is absent | `statusFile` was not configured, or the process already exited | Check the profile row; check the process |
| `process.done` output looks like gibberish | `collected.stdout.tail` is base64 | Decode it |
| Commands report `enforcement: 'partial'` | The remote host has no sandbox backend (no bubblewrap/Landlock) | Expected — the remote world is the isolation boundary |

## Compatibility

| What | Field | Value |
| --- | --- | --- |
| DSH host | `engines.dsh` | `0.2.1-rc.2` — exact, the only verified release |
| DSH packages | every `@deepseek-ai/dsh-*` in `peerDependencies` | `0.2.1-rc.2` — exact |
| Manifest format | `dsh.manifestVersion` | `1` |
| Node | `engines.node` | `^22.19.0 \|\| >=24.0.0` |
| Wire protocol | `REMOTE_SESSION_PROTOCOL` in `status.json` and `server.hello` | `3` |
| Verification | `devDependencies` | `@deepseek-ai/dsh-*` `0.2.1-rc.2`, `@deepseek-ai/cordis` `4.0.5` |

DSH reads `engines.dsh` at install time and at every profile start, and when the field is present
**that value alone decides** — the peers are ignored for admission (they are pinned to the same
exact string anyway, so the manifest never reads as "0.2.x is fine"). `0.2.1-rc.2` is the only
release this server has been verified against: its `hello` must satisfy the strict
`{ protocol, hash, kind, platform, nodeVersion, executable, root, workspace, bootstrapHash? }`
shape introduced there, and the JSONL backend it delegates to became an `apply()`-mounted plugin
row in that release. A newer `0.2.x` is untested, not supported.

On the remote this shows up at two boundaries: `dsh plugin` refuses a mismatched install before
pnpm runs, and a profile whose runtime does not match denies this plugin's row instead of
mounting it. The escape hatch is a per-pair exemption in the profile's `compatibility.json`
(`dsh plugin --profile <p> allow-version <package@version> --dsh-version <runtime>
--accept-risk`), which is explicitly unsupported.

### Two artifacts, two version axes

| Artifact | Version axis | Who consumes it |
| --- | --- | --- |
| `lib/server.js` + `cordis.patch.yml` (this npm package) | the plugin release (`v0.1.0-alpha1`) | Uploaded by the client into the profile's `node_modules/dsh-remote-workspace` |
| `dsh-remote-server-<dshVersion>-<platform>.tar.gz` (runtime package) | `server-v<dsh version>` release tag | Downloaded by the client, or staged locally |

A runtime package is the staged `@deepseek-ai/dsh` dependency tree for **one target
platform/arch**, with that platform's native bindings installed and foreign siblings stripped.
Node is a separate deployment, and this plugin arrives as the client's own upload. So **each
released runtime package is pinned to exactly one `@deepseek-ai/dsh` version**, and the tag names
that version.

## How it is deployed

The client provisions the host in five steps (everything is `/bin/sh -c` with absolute paths; the
remote `PATH`, login shell and system npm are never used):

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
`dshHomePath('remote-server-sessions')`, disabled when a `sessionPersistence` already exists),
`session-projection`, `subprocess-local`, `sandbox-local`, `sandbox-policy`, `fs-sandbox`, and
this plugin's row.

## Data and storage

```
~/.dsh/remote-server-sessions/<projectKey>/<sessionId>/   authoritative JSONL logs (zstd)
~/.dsh/remote-server/server-id                            stable server identity
~/.dsh/remote-server/workspaces.json                      server-owned workspace catalogue
~/.dsh/remote-server/status.json                          discovery manifest (0600)
```

- `workspaceId = sha256(serverId + NUL + canonical remote path)`, so it is stable across devices;
  `serverId` is persisted in `identityFile` and must never change.
- `createSession` overwrites the header cwd with the workspace path and passes
  `inheritedEventCount` through — without it the official backend rejects a forked (`isSeeded`)
  session header.
- `titles` folds the last `session/title` event per session (log-only, latest wins) and uses the
  last event's `time` as `updatedAt`; memoized by `(id, sizeBytes)`, concurrency cap 4, and a
  session that fails to read only loses its own title.
- `rename` never opens the session: it takes a write handle, reads the log length for the next
  contiguous `seq`, appends an official-shaped `session/title`, flushes and releases the lease.
- Closing a handle never deletes a log; removing a catalogue entry never touches
  `remote-server-sessions/**`.

## Release process

Runtime packages are built and published **from this repository**:

```yaml
on: push: tags: ['server-v*']      # e.g. server-v0.2.1-rc.2
matrix: linux-x64/arm64 (glibc), darwin-x64/arm64
```

Each matrix entry produces `dsh-remote-server-<dshVersion>-<platform-arch>[-libc].tar.gz` plus
`.sha256` and `.manifest.json` under the tag's GitHub Release. There is deliberately **no Windows
entry**: the remote world is POSIX, and `artifactTag()` only accepts `linux | darwin`.

Local build (same code path as CI):

```bash
node scripts/build-server-package.mjs --all --dsh-version 0.2.1-rc.2
node scripts/build-server-package.mjs --platform linux --arch x64 --libc gnu --out dist-server
```

The staging code lives in `src/provision/package-build.ts`, a byte-identical copy of the client's
module: it installs `@deepseek-ai/dsh@<version>` for the target platform, pins the native binding
closure (`node-addon-require-builtin-*`, `@deepseek-ai/node-addon-system-*`), strips
foreign-platform siblings, and packs the result.

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
