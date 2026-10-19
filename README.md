# dsh-remote-workspace-server

English | [中文](README-zh.md)

The remote half of [dsh-remote-workspace](https://github.com/graydovee/dsh-remote-workspace). It
runs inside a DeepSeek Harness runtime on the SSH host and gives that host a filesystem, a shell,
processes and session storage. You normally do not install it by hand: the client deploys a
runtime, uploads this package and starts it over stdio.

Read this file if you are deploying or debugging a remote host by hand. The method reference,
internal invariants and release rules are in [AGENTS.md](AGENTS.md).

## Requirements

| Where | Needs |
| --- | --- |
| Remote host | POSIX with `/bin/sh`, `tar`, `chmod` and a writable `$HOME` |
| Runtime | DeepSeek Harness `0.2.1-rc.2` plus a Node distribution, both under `~/.dsh/server` |
| Node on the host | Not needed — the deployed Node runs the deployed dsh |

## Run it by hand

These are the steps the client performs, in the same order.

1. Stage a runtime package for the host's platform (requires a machine with Node and pnpm):

   ```bash
   node scripts/build-server-package.mjs --platform linux --arch x64 --libc gnu --out dist-server
   ```

2. Unpack the tarball into `~/.dsh/server/dsh` and a Node distribution into `~/.dsh/server/node`.
3. Create the profile `~/.dsh/profiles/dsh-remote-server/` with `package.json`, `cordis.yml`,
   `cordis.patch.yml` and `pnpm-workspace.yaml`, and put this package under
   `node_modules/dsh-remote-workspace/`. The client generates these files; copy them from a host
   it deployed rather than writing them from scratch.
4. Start it on stdio:

   ```bash
   DSH_HOME="$HOME" \
   PATH="$HOME/.dsh/server/node/bin:$HOME/.dsh/server/dsh/node_modules/.bin:$PATH" \
   exec "$HOME/.dsh/server/dsh/node_modules/.bin/dsh" --profile dsh-remote-server
   ```

There is no listening port: the process speaks the protocol on stdin/stdout. On success it writes
`~/.dsh/remote-server/status.json` (mode 0600) with `serverId`, `installationId`, `version`,
`protocol`, `transport: 'stdio'` and `pid`.

## Configuration

The client writes these into the `remote-workspace-server` row of the profile's
`cordis.patch.yml`.

| Field | Default | Meaning |
| --- | --- | --- |
| `workspace` | `process.cwd()` | Workspace reported when the client does not name one |
| `leaseMs` | `30000` | Client lease in ms; when it lapses every process this server holds is released |
| `maxProcesses` | `128` | Maximum prepared or running process handles |
| `exitOnClose` | `true` | Exit after a `close` request |
| `serverId` | generated | Stable identity, part of every workspace id — never change it |
| `installationId` | generated | Installation identity for multi-instance discovery |
| `identityFile` | empty | File that persists `serverId` |
| `workspaceIndex` | empty | Standalone workspace list, ignored when the shell registry exists |
| `statusFile` | empty | Discovery manifest path |
| `version` | package version | Reported by `server.hello` and `status.json` |

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The client reports a failed connection and the row is denied | The runtime is not `0.2.1-rc.2`; deploy the matching one, or see [Compatibility](#compatibility) |
| The process exits immediately without output | The profile's patch layer did not mount the official JSONL backend, so nothing provides `sessionPersistence` |
| `session "…" not found` after a restart | The handle table lives in memory; reopen the session (the client retries once) |
| Idle commands get killed | The client stopped heartbeating and the lease expired; keep the connection open |
| `status.json` is missing | `statusFile` was not configured, or the process already exited |
| `process.done` output looks like gibberish | The collected stdout tail is base64 — decode it |

## Compatibility

This plugin supports **exactly one DeepSeek Harness release, `0.2.1-rc.2`** (`engines.dsh`), and
is refused by the installer and the loader on any other release. If you need to try one anyway:

```bash
dsh plugin --profile <profile> allow-version dsh-remote-workspace-server@<installed version> \
  --dsh-version <your DSH version> --accept-risk
```

Runtime packages are published per DSH release, tagged `server-v<dsh version>` for
`linux-x64`, `linux-arm64`, `darwin-x64` and `darwin-arm64`. There is no Windows package: the
remote side is POSIX, and Windows hosts are supported as WSL targets from the client.

## Contributing

Changing this repository is covered by [AGENTS.md](AGENTS.md): the method reference, the sync
contract with the client, invariants and the release process. Users do not need it.

## License

MIT
