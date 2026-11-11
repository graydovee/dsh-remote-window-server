# Connection list inside the server UI

The server profile's official DSH UI shows the client's remote connections: one `sidebar.panellist` row
(id `dsh-remote-workspace`, order 100 — below the shipped panels, above the trailing More menu) and the `main` page registered under the same key. Both are slot
contributions of this package's browser half (`src/client/`, built to `lib/client.js`); nothing is
injected into the DOM and `sidebar` / `sidebar.workspaces` are never registered into.

## Data flow

```
client host (authority)                    server profile (this plugin)
  P1  client/targets  ──────────────▶  ClientTargetsSnapshot (memory only)
                                          │  GET api/client/targets
                                          ▼  (admit(req) only, no lease headers)
                                       browser half, 2 s poll
                                          │  parent.postMessage(versioned command)
                                          ▼
                                       client page switches / opens dialog / closes frame
```

- `client/targets` is a P1 RPC method (`src/server-plugin/index.ts` dispatch). Its params are
  `RwClientTargetsValue` and the reply is `{ accepted, updatedAt, count }`. `accepted: false` is a normal
  answer for a snapshot that lost the `updatedAt` race; the client retries on its next tick.
- The read route is `GET /dsh-remote-workspace-server/api/client/targets` and answers
  `{ ok: true, value: { clientId, updatedAt, activeTargetId?, targets } }`. Before the first publication
  it answers `{ clientId: '', updatedAt: 0, targets: [] }` — an empty list, never an error.
- The route is reached through the client host's portal, so its URL must be requested **relative to the
  mount** (`dsh-remote-workspace-server/api/client/targets`); a leading slash escapes the portal prefix.

## Snapshot rules (`src/server-plugin/client-targets.ts`)

- Rows are rebuilt from a whitelist: `targetId`, `label`, `kind`, `host?`, `port?`, `username?`,
  `phase`, `active?`. Credential references, key paths, host-key fingerprints and profile names are
  dropped even if the client sends them.
- At most 64 rows; rows with an unusable id/kind/phase are dropped whole; duplicate ids keep the first.
- `updatedAt` must increase strictly; equal or older publications are dropped so a delayed publish
  cannot resurrect a stale list or an old `activeTargetId`.
- Every retained string runs through `scrubSecrets` on arrival (the client scrubs too).
- The snapshot lives in memory only and is cleared by `profile/release`. A restarted profile starts
  empty and the client republishes within its 5 s cadence.

## Commands

Three versioned messages, built and validated only in `src/protocol.ts`:

| Builder | Message | Client action |
| --- | --- | --- |
| `rwPortalSwitchTarget(id)` | `{ v: 1, type: 'dsh-rw/switch-target', targetId }` | activate that target and remount the frame |
| `rwPortalOpenConnectDialog()` | `{ v: 1, type: 'dsh-rw/open-connect-dialog' }` | open the client's connection dialog |
| `rwPortalClosePortal()` | `{ v: 1, type: 'dsh-rw/close-portal' }` | drop the frame, show the client's own list |

They are posted to `location.origin` (the client page is same-origin through the portal) and the client
page runs `parseRwPortalCommand` plus its own origin/source check before acting. When the UI is opened
directly on the target (`window.parent === window`) there is no client page, so the list renders
read-only with a note and all three commands are disabled.

## Capability and compatibility

`RwServerCapabilities.clientTargets: 1` advertises the feature. A client that does not see the bit
never publishes and the row/page stay empty — the feature is additive and silent, never a connection
failure. The browser half ships inside the plugin tarball (`exports['./client']`, `dsh.client` in
`package.json`); a profile installed from an older tarball shows no row until the plugin is reinstalled
and the profile server restarted.
