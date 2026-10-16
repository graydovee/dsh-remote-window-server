# dsh-remote-workspace-server

DeepSeek Harness Remote Session 插件的 server 部分。它运行在 SSH 远端，提供官方执行世界 helper、工作区/会话 RPC，并把会话日志保存在远端机器。

server 直接复用 DSH 官方 `sessionPersistence` 服务和 JSONL backend 处理持久化与单写者 ownership，不实现第二套会话格式或锁协议。

## 开发

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

client 部分位于 [`../dsh-remote-workspace`](../dsh-remote-workspace)。两个项目的 `src/protocol.ts` 必须保持同步。
