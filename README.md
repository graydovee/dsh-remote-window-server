# dsh-remote-workspace-server

English | [中文](README-zh.md)

This repository is the remote half of
[dsh-remote-workspace](https://github.com/graydovee/dsh-remote-workspace). It is a normal DeepSeek
Harness plugin installed into a per-client DSH profile. It does **not** use stdio and does not listen
on a public port: the client reaches it through one SSH connection and a loopback-only DSH web server.

## Compatibility

| Server plugin | Verified DSH runtime | Status |
| --- | --- | --- |
| 0.1.0-alpha.3 | 0.2.1-rc.3 | verified |

`engines.dsh` and every `@deepseek-ai/dsh-*` peer are pinned to that exact runtime. The package manifest
records `dshVersion: 0.2.1-rc.3`; an unverified runtime is refused by the client instead of failing
halfway. `0.2.1-rc.2` is not in the verified set for this release.

## What runs where

- **Client host** — owns SSH credentials, the remote connection UI, the client native conversation
  panel, and the local-mode agent/model.
- **Server profile** — a normal `dsh web` process with this plugin. It owns the official workspace
  registry, session controller and JSONL session logs, and exposes the official filesystem/subprocess/
  sandbox execution world.
- **Execution modes** — `local` runs the agent/model on the client while files, processes and logs stay
  on the server; `server` runs the agent/model and official session UI on the server. The mode is
  recorded per session and both modes share the same server workspace and session log.

The client renders the server conversation natively in v2. The legacy embed/portal routes remain only
for v1 fallback and are not part of the normal v2 flow.

## How it is deployed

Most users never install this repository directly. The client package embeds the exact matching
`dsh-remote-workspace-server-<client-version>.tgz` and, on first connect:

1. uploads/selects a compatible Node + DSH runtime on the target;
2. creates `~/.dsh/profiles/graydovee-remote-workspace-<clientId>/` with the four profile files;
3. unpacks this tarball into the profile's `node_modules/dsh-remote-workspace-server/` offline;
4. writes a version/sha marker and starts the profile.

The profile is started with a loopback-only web server:

```sh
DSH_HOME="$HOME" \
PATH="$HOME/.dsh/remote-workspace/<clientId>/runtime/node/bin:$PATH" \
exec <dsh> --profile graydovee-remote-workspace-<clientId> \
  --host 127.0.0.1 --port 0 --no-open
```

The process prints `dsh web: http://127.0.0.1:<port>/?token=<token>` on stdout. The client parses that
line, keeps the token in host memory, and reaches the port through an SSH `forwardOut` tunnel. Never
expose the profile port or token to the network.

Each client profile has a single-writer lease (`.dsh-rw/lease.json`, 20 s TTL). A second instance gets
`profile-in-use`; another client's profile gets `profile-foreign-client`; a stale lease may be taken
over. A client disconnect cancels the profile's active turns, flushes the official JSONL log, stops the
profile process and closes the tunnel.

## Build and pack

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm pack:server-plugin
```

The pack script writes `dist/server-plugin/dsh-remote-workspace-server-<version>.tgz`, its `.sha256`
and a `.manifest.json` containing the protocol, feature list, `dshVersion`, byte length and checksum.
The client repository vendors that tarball and records the checksum in
`assets/server-plugin/checksums.json`; both repositories must use the same release version and the same
DSH runtime pin.

Manual profile construction is only for protocol debugging. Normal deployments should use the client
provisioner so the profile files, marker, runtime and lease stay consistent.

## Data locations

| Path | Content |
| --- | --- |
| `~/.dsh/profiles/graydovee-remote-workspace-<clientId>/` | per-client profile, plugin, profile files and `.dsh-rw/lease.json` |
| `~/.dsh/remote-workspace/profiles/graydovee-remote-workspace-<clientId>/` | `server.log` (0600) and `server.pid` |
| `~/.dsh/sessions/**` | authoritative official JSONL session logs (shared by both modes) |
| `~/.dsh/storages/workspace.json` | authoritative official workspace registry |
| `~/.dsh/remote-workspace/state/`, `locks/` | executor records and bootstrap locks |
| `~/.dsh/remote-workspace/<clientId>/runtime/` | optional isolated DSH runtime |

The retired `remote-server-sessions/` directory is left untouched and is not read by v2.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| `incompatible-version` | Client/server runtime is not in the verified set; install DSH `0.2.1-rc.3` or use the explicit version exemption on the client. |
| `profile-in-use` | Another live instance holds this client profile's lease. Close the other client or wait for the 20 s TTL to expire. |
| `profile-foreign-client` | The profile belongs to another `clientId`; do not reuse it. |
| `plugin-profile-not-managed` | The client refused to modify a profile it did not provision. |
| `session/writer-held` | Another agent currently holds the official JSONL writer lease. |
| `shutdown-flush-timeout` | Cancel/flush exceeded the 3 s shutdown budget; inspect `server.log`. |

## Legacy

The stdio transport, standalone server process, `status.json` discovery manifest, Remote Session
protocol v3 and `dist-runtime/` packages belong to the v1 architecture. They are kept only as
historical release artifacts and are not used by the current client. Do not build new work on them.
