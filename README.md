# dsh-remote-workspace-server

The server half of the DeepSeek Harness Remote Session plugin. It runs on the SSH host, provides the official remote execution helpers, exposes workspace/session RPCs, and keeps session logs on the remote machine.

The server delegates persistence and single-writer ownership to the official DSH `sessionPersistence` service and JSONL backend. It does not implement a second session format or lock protocol.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The client half lives in [`../dsh-remote-workspace`](../dsh-remote-workspace). Keep `src/protocol.ts` synchronized between the two projects.
