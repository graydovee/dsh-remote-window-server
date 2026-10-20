# dsh-remote-workspace-server

English | [中文](README-zh.md)

This repository is the remote half of
[dsh-remote-workspace](https://github.com/graydovee/dsh-remote-workspace). It is a headless DeepSeek
Harness plugin that runs inside a target-side DSH profile. The client starts it over stdio; the process
does not listen on a TCP port.

The server exposes the official DSH execution-world providers (filesystem, subprocess, terminal and
sandbox forwarding) and the remote session plane used by the client. It owns the workspace registry
and the JSONL session logs, while the client keeps the agent loop, model calls and credentials.

Most users never install this repository directly. The client either reuses a compatible dsh already
on the target or deploys a runtime package built and released from this repository.

## Runtime layout

A provisioned target contains:

    ~/.dsh/server/
      node/                 Node distribution used by the deployed runtime
      dsh/                  @deepseek-ai/dsh and its dependencies
    ~/.dsh/profiles/dsh-remote-server/
      package.json
      cordis.yml
      cordis.patch.yml
      node_modules/dsh-remote-workspace/
    ~/.dsh/remote-server/
      server-id             stable identity used by workspace ids
      workspaces.json       standalone registry when no official registry exists
      status.json           short-lived discovery manifest
    ~/.dsh/remote-server-sessions/
      ...                   official JSONL session storage

The client starts the profile with a command equivalent to:

    DSH_HOME="$HOME" \
    PATH="$HOME/.dsh/server/node/bin:$HOME/.dsh/server/dsh/node_modules/.bin:$PATH" \
    exec "$HOME/.dsh/server/dsh/node_modules/.bin/dsh" --profile dsh-remote-server

The server then reads and writes the framed protocol on stdin/stdout. Closing the client releases
process handles and, by default, exits the dedicated server profile.

## Requirements

| Item | Requirement |
| --- | --- |
| DSH | Exactly 0.2.1-rc.2 for the current release |
| Target OS | Linux or macOS with a POSIX shell |
| Target tools | /bin/sh, tar, chmod, and a writable $HOME |
| Node on the target | The client uploads a matching Node distribution separately; manual deployments must provide one |
| Client | A matching dsh-remote-workspace client, or a manually generated equivalent profile |

Windows is supported as a client host through WSL. This repository does not publish a native Windows
remote package.

## Manual deployment

Manual deployment is useful for protocol debugging and for inspecting a target without the client
wizard. The profile files are part of the client/server contract; copy them from a client deployment
or generate them with the client provisioner.

1. Build a target package on a machine with Node and pnpm:

       pnpm install
       pnpm build
       node scripts/build-server-package.mjs --dsh-version 0.2.1-rc.2 --platform linux --arch x64 --libc gnu --out dist-server

   Replace the platform and architecture with linux/arm64, darwin/x64 or darwin/arm64 as appropriate.
   The script emits a .tar.gz, a .sha256 file and a manifest.
2. Extract the Node distribution and DSH package under ~/.dsh/server/, and install this package's
   built lib/ files under the profile's node_modules/dsh-remote-workspace/.
3. Create ~/.dsh/profiles/dsh-remote-server/ with the matching package.json, cordis.yml,
   cordis.patch.yml and pnpm-workspace.yaml. The patch must mount the official JSONL backend at
   ~/.dsh/remote-server-sessions and this plugin's server row.
4. Start the profile using the command shown above. Ensure stdout is reserved for the protocol; use
   stderr for diagnostics.

On successful startup, status.json is written with serverId, installationId, version, protocol,
transport: "stdio" and pid, and is removed when the server shuts down.

## Configuration

The client writes these fields to the dsh-remote-workspace-server/server row in cordis.patch.yml:

| Field | Default | Meaning |
| --- | --- | --- |
| workspace | process.cwd() | Default workspace reported when a request omits one |
| leaseMs | 30000 | Heartbeat lease; expiry releases all process handles owned by the client |
| maxProcesses | 128 | Maximum prepared or running process handles |
| exitOnClose | true | Exit after the close response is flushed |
| serverId | generated | Stable identity used when identityFile is empty |
| installationId | generated | Identity for multi-instance discovery |
| identityFile | empty | File that persists serverId; keep it stable |
| workspaceIndex | empty | Standalone workspace index; ignored when an official workspace registry is available |
| statusFile | empty | Discovery manifest path; the client normally sets it |
| version | package version | Version reported in server.hello and status.json |

Changing serverId changes every derived workspace id. Do not rotate it during an upgrade.

## Protocol surface

The server supports the official DSH execution-world RPCs and Remote Session protocol revision 3.

Remote Session methods:

    server.hello
    reg.list       reg.create       reg.rename       reg.delete
    persist.list   persist.titles   persist.rename
    persist.create persist.open     persist.append
    persist.flush  persist.close    persist.locate

Session writes use the official persistence handle and lease. There is no second lock file or alternate
session format. Handles are in memory and disappear when the server restarts; the client reopens once
when it receives an unknown-handle response.

## Operational behavior

- The target's server is authoritative for workspace paths, titles and session logs.
- A workspace id is derived from the stable server identity and canonical remote path.
- Renaming a workspace changes its title; it never moves the directory.
- Removing a workspace removes the registry entry only. Its session logs remain on disk.
- Session titles are read from the latest session/title event in the log because the remote profile
  does not mount the title projection plugin.
- If no sandbox backend is available, the server returns the official facts object with
  enforcement: "partial" and runs the argv inside the remote world.
- All request payloads are validated at the wire boundary. Unknown stream control frames are tolerated
  as late messages; unknown stream data is fatal.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The client reports incompatible-version | Match both repositories to DSH 0.2.1-rc.2. |
| The process exits immediately | Check that the profile patch mounted the JSONL backend and the server row. |
| session "..." not found after a restart | Handles are memory-only; reopen the session through the client. |
| Commands stop after an idle period | The heartbeat lease expired; keep the client connection alive. |
| status.json is missing | statusFile was empty or the process has exited. |
| Protocol output is corrupted | Keep stdout dedicated to the RPC stream and send logs to stderr. |
| A sandbox request says no backend is usable | Verify the remote facts object; partial enforcement is expected on hosts without bubblewrap/Landlock. |

## Compatibility and releases

The current package is tested only with DSH 0.2.1-rc.2. Runtime packages are released from this
repository under tags such as server-v0.2.1-rc.2. Each release contains:

    dsh-remote-server-<dshVersion>-<platform>-<arch>[-<libc>].tar.gz
    <same-name>.tar.gz.sha256
    <same-name>.manifest.json

The release matrix is linux-x64-gnu, linux-arm64-gnu, darwin-x64 and darwin-arm64. The client
verifies the checksum before caching or uploading an asset.

## Development

Read AGENTS.md before editing shared protocol or server code. The client repository must carry
byte-identical copies of src/protocol.ts, src/server/**, src/frame/** and src/provision/package-build.ts.
The AGENTS file documents the comparison command, tests and tag workflow.

## License

MIT
