# AGENTS.md — dsh-remote-workspace-server（server 半边）

DSH（DeepSeek Harness）远端 server 插件：跑在 SSH 主机上（由 client 的
provisioner 生成的远程 profile 挂载，或用户自装 dsh + 本插件）。它应答**官方 SSH
helper 的执行世界方法集**（fs/subprocess/sandbox/shell，协议 v1，官方
`dsh-fs-ssh`/`dsh-subprocess-ssh`/`dsh-sandbox-ssh` 可零改动直连）加上 **Remote
Session RPC**（协议 2：`server.hello` / `reg.list` / `reg.create` /
`persist.list|create|open|append|flush|close`）。

会话持久化与单写者所有权**全部委托**给官方 `sessionPersistence` 服务与
`@deepseek-ai/dsh-session-persistence-jsonl` 后端：本插件**没有**自己的会话文件
格式、没有自己的锁文件/锁协议；`SessionAlreadyOwnedError` 原样透传给 client。

## 必读文档

- `../backup/legacy-project/REFACTOR-BRIEF.md` — 重构唯一权威交底（协议表、
  权威数据布局 `~/.dsh/server/`、官方 API 文件:行号索引、里程碑 P0–P5）。
- `../backup/legacy-project/PLAN.md` — d1–d12 实测偏差（本插件的 bundle/保活/
  mux 规则出处），仍然有效。
- 兄弟项目：`../dsh-remote-workspace`（client 半边，见其 AGENTS.md）。

## 命令

```bash
pnpm install
pnpm typecheck    # tsc --noEmit（无 lint 配置）
pnpm test         # vitest run（session-store 投影与所有权透传）
pnpm build        # tsdown → lib/（server + protocol 两个 entry）
# 发行包（staging：package.json + cordis.patch.yml + lib/server.js + lib/protocol.js
# + manifest.json{protocol:2} → tar.gz + sha256）：
node scripts/build-server-package.mjs --out <dir> --version 0.3.6
```

Node ≥ 22.19（或 ≥ 24）；只用 pnpm。`lib/` 是构建产物，不要手改。

## 与 client 项目的同步契约（最重要的规则）

`src/protocol.ts`、`src/server/`、`src/frame/` 与 `../dsh-remote-workspace` 里的
同名文件**逐字节相同**（已验证）。改任何一边必须两边同步改：client 的
conformance 测试跑的就是这份副本，且 client provisioner 当前部署的是它自己构建的
`lib/server.js`。`src/protocol.ts` 头部注释即此约定；协议版本 2
（`REMOTE_SESSION_PROTOCOL = 2`），改协议必须 bump 并同步 `scripts/build-server-package.mjs`
manifest 里的 `protocol` 字段。

## 架构

- **单一 tsdown 配置**：entries `server`（`src/server/index.ts`）+ `protocol`；
  **自包含 bundle**——只 external `@deepseek-ai/cordis` 与
  `@deepseek-ai/schemastery`，其余（含 `@deepseek-ai/dsh-ssh/protocol|/schemas`
  子路径导出、zod）全部内联：DSH 运行时模块拦截只解析裸包名（PLAN d2）。多一份
  cordis 拷贝会拆散服务注册表。
- `src/server/index.ts`：行名 `remote-workspace-server`；inject
  `fs/subprocess/sandbox/sessionPersistence`；写 `status.json`（0600 发现清单：
  serverId/installationId/version/port/pid）。**进程自持**：keep-alive 句柄保活
  （PLAN d3，宿主把 stdin 与 timer 全 unref，事件循环一空就退出）；`close` 的
  响应必须先于进程退出刷出（PLAN d5）；`exitOnClose` 默认 true。
- `src/server/controller.ts`：官方方法集 + Remote Session RPC 的分发；wire 边界
  一律 zod 校验；官方整文/读取上限（`MAX_TEXT_BYTES` 8 MiB 等）在这侧重放。
- `src/server/session-store.ts`：官方 persistence 与 `workspaceRegistry`（或
  standalone `workspaces.json` 索引）之上的适配层。
  `workspaceId = sha256(serverId + NUL + 远端规范路径)` —— 跨设备稳定；
  **`serverId` 经 `identityFile` 持久化、绝不能变**（它是 workspaceId 的组成部
  分）。
- `src/server/processes.ts`：远端进程句柄；client 心跳租约丢失即释放全部被持有
  进程。
- `src/frame/`：`type(1B)+len(4BE)+payload` 分帧、`FrameMux`、credit 窗口。
- `cordis.patch.yml`（client 的 `src/provision/profile.ts` 生成同款）：只 insert
  两行——`remote-session-persistence`（官方 JSONL 后端，
  `root: dshHomePath('remote-server-sessions')`、`compression: zstd`，已有
  `sessionPersistence` 时 disabled）与插件行（identity/status 文件走
  `dshHomePath('remote-server/…')`，`exitOnClose: true`）。

## 不变量 — 不要破坏

- **远端没有凭据/模型/agent loop**：只有执行世界与会话存储。
- **不引入第二会话格式或锁协议**：写所有权就是官方后端 SessionHandle 的租约；
  `SessionAlreadyOwnedError` 不包装、原样透传。
- **`persist.append` 服务端 fail-closed 校验**：不信 client，用官方 storage-contract
  词表校验后才落盘。
- **mux 宽容规则**（PLAN d6）：未知流的 `CREDIT/END/ABORT/OPEN_OK/OPEN_FAIL`
  忽略（迟到消息），仅未知流 `DATA` 是致命帧失步。
- 官方 `spawnSchema` 不允许 `stdio.stderr: 'ignore'`（只有 `pipe|inherit|collect`）。
- wire 边界全部显式校验；`serverId`/`installationId` 稳定持久化。

## 编码规约

- TS strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` +
  `allowImportingTsExtensions`：相对导入带 `.ts` 后缀；type-only 用 `import type`。
- 可选 wire 字段沿用条件展开惯用法 `...(x === undefined ? {} : { x })`。
- 注释解释**实测约束**；适用时注明对应的 PLAN 偏差编号。
- peer 依赖是官方 `>=0.2.0-rc.1 <0.3.0` 包；不 vendor 官方源码（REFACTOR-BRIEF
  §3.2 的 vendor 方案最终未采用，改为 peer 依赖 + profile patch 挂官方包）。
- 生命周期资源一律 `ctx.effect` 注册，随 fiber 销毁。

## 测试

本项目自身只有 `tests/session-store.test.ts`（工作区投影、写所有权错误透传）。
重量级回归在 **client 项目**：conformance（官方 provider 对副本内存跑）、frame、
deploy、remote-persistence、profile 冒烟。改了共享代码后，**两边的
`pnpm typecheck && pnpm test` 都要跑**。
