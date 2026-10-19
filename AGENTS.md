# AGENTS.md — dsh-remote-workspace-server

**开发约束，只写给改这个仓库的人（和 agent）。** 使用者文档在 [`README.md`](README.md)：手动
部署、配置字段、排障、兼容性属于那里；方法表、内部不变量、发布流程只属于本文件。

本插件跑在 SSH 主机上的 DSH 运行时里（由 client 的 provisioner 挂载，或用户自装）。它应答
官方 SSH 执行世界方法集，叠加 Remote Session RPC，并把会话日志留在远端。

## 身份与推送

- 仓库：<https://github.com/graydovee/dsh-remote-workspace-server>；client 半边：
  <https://github.com/graydovee/dsh-remote-workspace>。
- commit 身份用仓库**局部** git config：`graydovee / graydovee@foxmail.com`。
- 直接 `git push` 会 403，用：

  ```bash
  git push "https://x-access-token:$(gh auth token --user graydovee)@github.com/graydovee/dsh-remote-workspace-server.git" main
  ```

## 命令

```bash
pnpm install
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run（session-store 投影、所有权透传、titles、rename）
pnpm build        # tsdown → lib/（server + protocol）
node scripts/build-server-package.mjs --platform linux --arch x64 --libc gnu --out dist-server
node scripts/build-server-package.mjs --all --dsh-version 0.2.1-rc.2   # CI 同款矩阵
```

`lib/` 是入库产物，不要手改。发行包才是本项目的交付物：`dsh-remote-server-<dshVersion>-<platform>.tar.gz`
（自带 `@deepseek-ai/dsh` 依赖树 + 目标平台原生绑定）。

## 同步契约（与 client 仓库，最重要）

`src/protocol.ts`、`src/server/**`、`src/frame/**`、`src/provision/package-build.ts` 与
`../dsh-remote-workspace` 逐字节相同。改任何一处必须两边同一次提交/发布一起改并对齐：

```bash
for f in protocol.ts server/controller.ts server/session-store.ts server/index.ts server/processes.ts; do
  cmp -s "src/$f" "../dsh-remote-workspace/src/$f" || echo "DIFF: $f"
done
```

推论：改了 `src/server/**` 必须在 client 侧 bump 并重新部署，否则远端 bundle 不会更新
（provisioner 按摘要比对）。

协议版本 3（`REMOTE_SESSION_PROTOCOL = 3`；官方执行世界 RPC 仍是 v1）。协议变化要同步
`status.json` 与 `server.hello` 报告的值，否则 client 会拿着不匹配的协议静默降级（不允许）。

## 架构

- **单一 tsdown 配置**：entries `server` + `protocol`；**自包含 bundle**——只 external
  `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`，其余（含 `dsh-ssh/protocol|/schemas`、
  zod）全部内联。多一份 cordis 拷贝会拆散服务注册表。
- **`src/server/index.ts`**：行名 `remote-workspace-server`；inject
  `fs/subprocess/sandbox/sessionPersistence`；写 `status.json`（0600 发现清单：
  serverId/installationId/version/protocol/transport/pid）。**进程自持**：keep-alive 句柄
  （宿主把 stdin 与 timer 全 unref，事件循环一空就退出）；`close` 的响应必须先刷出再退出
  （`process.exit` 会丢排队写，unref 的 timer 也等不到）；`exitOnClose` 默认 true。
- **`src/server/controller.ts`**：官方方法集 + Remote Session RPC 的分发；wire 边界一律 zod
  校验；官方整文/读取上限（如 `MAX_TEXT_BYTES` 8 MiB）在这侧重放。`hello` 形状跟 `dsh-ssh`
  走：`{ protocol, hash, kind: 'node-script', platform, nodeVersion, executable, root, workspace, bootstrapHash? }`，
  schema 是 `$strict`，本行由部署的 node 执行 `lib/server.js`，所以
  `kind: 'node-script'` + `executable: process.execPath`。
- **`src/server/session-store.ts`**：官方 persistence 与 workspaceRegistry（或 standalone
  `workspaces.json`）之上的适配层。`workspaceId = sha256(serverId + NUL + 远端规范路径)`，
  跨设备稳定；**`serverId` 经 `identityFile` 持久化、绝不能变**（它是 workspaceId 的组成）。
  - `createSession`：先把 header 的 cwd 覆盖成工作区路径，再交给官方后端；
    **`inheritedEventCount` 必须原样传下去**——fork 出来的子会话 header 是 `isSeeded`，官方
    后端缺该计数会拒（`seeded session header requires an inherited event count`）。
    `openSession` 同样把 `handle.inheritedEventCount` 回给 client。
  - `titles`：对工作区内每个会话取 `read` handle 读日志、fold 最后一个 `session/title`
    （log-only，latest wins）取 `data.title`，用最后一个事件的 `time` 作 `updatedAt`；按
    `(id, sizeBytes)` 记忆化、并发上限 4、单会话失败只丢它自己。
  - `rename`：**不打开会话**，取写 handle → 读日志长度得连续 next `seq` → 追加官方形状的
    `session/title`（`{title, messageSeqs: [], source: {kind: 'user'}}`）→ `flush` → 放租约，
    并失效标题缓存；工作区归属校验保留，写租约冲突留给官方后端报错。client 负责用
    `normalizeSessionTitle` 归一化文本。
- **`src/server/processes.ts`**：远端进程句柄；心跳租约丢失即释放全部被持有进程。
- **`src/frame/`**：`type(1B)+len(4BE)+payload` 分帧、`FrameMux`、credit 窗口。
- **`cordis.patch.yml`**（client 的 `src/provision/profile.ts` 生成同款）：只 insert 两行——
  `remote-session-persistence`（官方 JSONL 后端，root `dshHomePath('remote-server-sessions')`、
  `compression: zstd`，已有 `sessionPersistence` 时 disabled）与插件行（identity/status 走
  `dshHomePath('remote-server/…')`，`exitOnClose: true`）。远端 profile **不挂 session-title**：
  标题由本机 dsh 生成、经 `persist.append` 写入远端日志，所以读日志是拿到标题的唯一办法。

## 方法参考

官方执行世界（`dsh-fs-ssh` / `dsh-subprocess-ssh` / `dsh-sandbox-ssh` 零改动直连）：
`hello`、`heartbeat`、`close`、`executable`、`fs.resolve|lstat|stat|list|readText|stream|next|streamClose|readBytes|readRange|write|edit`、
`process.prepare|start|wait|done|terminate`、
`terminal.environment|write|inspect|activity|resize|signal`、`sandbox`。

Remote Session RPC（协议 3）：`server.hello`、`reg.list|create|rename|delete`、
`persist.list|titles|rename|create|open|append|flush|close|locate`。

## 硬约束

- **远端没有凭据/模型/agent loop**：只有执行世界与会话存储。
- **不引入第二会话格式或锁协议**：写所有权就是官方 `SessionHandle` 的租约；
  `SessionAlreadyOwnedError` 不包装、原样透传。`persist.rename` 借的也是官方写 handle。
- **`persist.append` 服务端 fail-closed 校验**：不信 client，按官方 storage-contract 词表
  校验后才落盘。
- **mux 宽容规则**：未知流的 `CREDIT/END/ABORT/OPEN_OK/OPEN_FAIL` 忽略（迟到消息），只有未知
  流的 `DATA` 是致命帧失步。
- 官方 `spawnSchema` 不允许 `stdio.stderr: 'ignore'`（只有 `pipe|inherit|collect`）。
- wire 边界全部显式校验；`serverId`/`installationId` 稳定持久化。
- handle 表在进程内存里，重启即清空；client 侧自愈一次，**不要**在 server 侧加"持久 handle"。
- **`engines.dsh` 与全部 `@deepseek-ai/dsh-*` peer 写精确值 `0.2.1-rc.2`**，不写区间：只有这一版
  实测过（`hello` 严格形状 + `apply()` 挂载式 JSONL 后端）。替 0.2.2 提前担保就是把未测版本
  当已测。不 vendor 官方源码，改为 peer 依赖 + profile patch 挂官方包。
- **`zod` 与 harness 用同一个确切版本（`4.4.3`，不写 `^`）**：两份 zod 会让 `z.infer` 跨副本
  推导，任何 typecheck 都会 OOM。

编码规约：TS strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` +
`allowImportingTsExtensions`（相对导入带 `.ts`）；type-only 用 `import type`；可选 wire 字段
沿用 `...(x === undefined ? {} : { x })`；注释写**实测约束**，适用时注明 PLAN 偏差编号。
`session/title` 这类官方投影事件的类型在本包 `SessionEvent` 联合里可能不存在（投影插件未挂载），
读日志用局部松散类型 `{type, time, data}`，不要去拓宽官方类型。生命周期资源一律 `ctx.effect`。

## 测试

`tests/session-store.test.ts`：工作区投影、写所有权错误透传、`titles` 的 latest-wins 与
`(id,sizeBytes)` 失效、`rename` 的追加形状与跨工作区拒绝。重量级回归在 client 仓库
（conformance、frame、deploy、remote-persistence、routing-persistence、profile 冒烟）。改了
共享代码后**两边**的 `pnpm typecheck && pnpm test` 都要跑，并 `cmp` 复核同步文件。

## 发布流程

运行时包**在本仓库**构建与发布：`.github/workflows/server-release.yml`，
`push: tags: ['server-v*']`，矩阵 `linux-x64/arm64（glibc）、darwin-x64/arm64`，每个组合产出
`dsh-remote-server-<dshVersion>-<platform-arch>[-libc].tar.gz` + `.sha256` + `.manifest.json`，
挂到该 tag 的 release。

- tag 是 `server-v<dsh 版本>`（例如 `server-v0.2.1-rc.2`），因为包是**按 dsh 版本**构建的；
  插件自己的 tag 在 client 仓库，`server` 包不挂在插件 release 上。
- **没有 Windows 矩阵项**：远端世界是 POSIX，`artifactTag()` 只接受 `linux | darwin`。
- 打包会丢可执行位（NTFS 无 +x）：安装脚本用 `test -e` + `chmod +x`，判据是 `--version` 输出。
- `packageFiles` 的 path 必须是**远端 POSIX 路径**（Windows 上 `join('lib', …)` 会写成
  `libserver.js`，症状是握手报 `Invalid input: expected 1`）。

## 版本规则

与 client 对齐：**仓库里的版本 = 发布版本，当前 `v0.1.0-alpha1`**，两仓一致。本地调试部署
只加修订后缀 `0.1.0-alpha1.x`（`status.json` 与 `server.hello.version` 报它），必须在
`pnpm build` 之前加，**永不推送**：不提交、不 push、不打 tag、不发布；部署完用
`git checkout -- package.json src/server/index.ts && pnpm build` 还原。这套规则只写在本文件，
README 不出现开发号。

## 已知缺口

- 远端没有 `session-title` 插件：标题只能靠读日志 fold。
- 会话删除没有 RPC：只能在主机上手动删目录。
- 工作区清单是文件 + 轮询式跨进程收敛（`stat {mtimeMs,size}` 后才重读），并发写同一清单时
  标题最后写覆盖，但条目不会丢。
- `status.json` 只是发现清单，没有心跳续期；进程退出时删除。
