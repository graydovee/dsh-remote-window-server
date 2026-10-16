# AGENTS.md — dsh-remote-workspace-server（server 半边）

DSH（DeepSeek Harness）远端 server 插件：跑在 SSH 主机上（由 client 的
provisioner 生成的远程 profile 挂载，或用户自装 dsh + 本插件）。它应答**官方 SSH
helper 的执行世界方法集**（fs/subprocess/sandbox/shell，协议 v1，官方
`dsh-fs-ssh`/`dsh-subprocess-ssh`/`dsh-sandbox-ssh` 可零改动直连）加上 **Remote
Session RPC**（协议 2）：

```
server.hello
reg.list | reg.create                    工作区注册表
persist.list   | persist.titles          列表 / 标题+最后活动时间
persist.create | persist.open            句柄（create/open 都带 inheritedEventCount）
persist.append | persist.flush | persist.close
persist.locate                           会话属于哪个工作区（client 侧路由用）
persist.rename                           改名：追加一条 session/title
```

会话持久化与单写者所有权**全部委托**给官方 `sessionPersistence` 服务与
`@deepseek-ai/dsh-session-persistence-jsonl` 后端：本插件**没有**自己的会话文件
格式、没有自己的锁文件/锁协议；`SessionAlreadyOwnedError` 原样透传给 client。

## 仓库与身份

- 本仓库：<https://github.com/graydovee/dsh-remote-workspace-server>
- 兄弟仓库：<https://github.com/graydovee/dsh-remote-workspace>（client 半边）
- commit 身份固定为 `graydovee / graydovee@foxmail.com`（两个仓库的**局部** git config）。
- 推送注意：本机 keychain 里的默认凭据是另一个账号，直接 `git push` 会 403：

  ```bash
  git push "https://x-access-token:$(gh auth token --user graydovee)@github.com/graydovee/dsh-remote-workspace-server.git" main
  ```

## 必读文档

- `../backup/legacy-project/REFACTOR-BRIEF.md` — 重构唯一权威交底（协议表、
  权威数据布局 `~/.dsh/server/`、官方 API 文件:行号索引、里程碑 P0–P5）。
- `../backup/legacy-project/PLAN.md` — d1–d12 实测偏差（本插件的 bundle/保活/
  mux 规则出处），仍然有效。
- 兄弟项目的 `AGENTS.md` — 路由持久层、标题来源、行内动词的落点在那里有完整说明。

## 命令

```bash
pnpm install
pnpm typecheck    # tsc --noEmit（无 lint 配置）
pnpm test         # vitest run（session-store 投影、所有权透传、titles、rename）
pnpm build        # tsdown → lib/（server + protocol 两个 entry）
# 发行包（staging：package.json + cordis.patch.yml + lib/server.js + lib/protocol.js
# + manifest.json{protocol:2} → tar.gz + sha256）：
node scripts/build-server-package.mjs                 # 版本取本包 package.json
node scripts/build-server-package.mjs --out <dir> --version <ver>   # 覆盖两者
# 全平台矩阵（自带 Node + dsh + 插件）在 **client** 仓库：
#   node ../dsh-remote-workspace/scripts/build-server-package.mjs --all --dsh-version <ver>
```

Node ≥ 22.19（或 ≥ 24）；只用 pnpm。`lib/` 是构建产物，不要手改。

## 与 client 项目的同步契约（最重要的规则）

`src/protocol.ts`、`src/server/`、`src/frame/` 与 `../dsh-remote-workspace` 里的
同名文件**逐字节相同**（已验证）。改任何一边必须两边同步改：client 的
conformance 测试跑的就是这份副本，且 client provisioner 当前部署的是**它自己构建的**
`lib/server.js`。

推论（部署时最重要的一条）：**改了 `src/server/` 就必须在 client 侧做一次版本 bump 并重新部署**，
否则远端的 bundle 不会更新——provisioner 按摘要比对，只有 client 包变了才会重新上传。
协议版本 2（`REMOTE_SESSION_PROTOCOL = 2`），改协议要同步
`scripts/build-server-package.mjs` manifest 里的 `protocol` 字段。

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
  分）。三个非平凡能力：
  - `createSession(workspaceId, header, inheritedEventCount?)`：把 header 的 cwd 覆盖成
    工作区路径后交给官方后端；**`inheritedEventCount` 必须原样传下去**——fork 出来的
    子会话 header 是 `isSeeded`，官方后端拒绝在没有该计数时存储
    （`seeded session header requires an inherited event count`，这就是远端 fork 之前失败的原因）。
    `openSession` 同样要把 `handle.inheritedEventCount` 回给 client。
  - `titles(workspaceId)`：对工作区内每个会话取 `read` handle 读日志、fold 最后一个
    `session/title`（log-only，latest wins）取 `data.title`，并用最后一个事件的 `time`
    作为 `updatedAt`；按 `(id, sizeBytes)` 记忆化、并发上限 4、单会话失败只丢它自己。
  - `rename(workspaceId, sessionId, title)`：**不打开任何会话**，直接取写 handle → 读日志
    长度拿到连续的 next `seq` → 追加一条官方形状的
    `session/title`（`{title, messageSeqs: [], source: {kind: 'user'}}`）→ `flush` → 放租约，
    并失效标题缓存。工作区归属校验保留（别的会话 id 会被拒），写租约冲突留给官方后端报错。
    client 负责用官方 `normalizeSessionTitle` 归一化文本。
- `src/server/processes.ts`：远端进程句柄；client 心跳租约丢失即释放全部被持有
  进程。
- `src/frame/`：`type(1B)+len(4BE)+payload` 分帧、`FrameMux`、credit 窗口。
- `cordis.patch.yml`（client 的 `src/provision/profile.ts` 生成同款）：只 insert
  两行——`remote-session-persistence`（官方 JSONL 后端，
  `root: dshHomePath('remote-server-sessions')`、`compression: zstd`，已有
  `sessionPersistence` 时 disabled）与插件行（identity/status 文件走
  `dshHomePath('remote-server/…')`，`exitOnClose: true`）。
  注意远端 profile **不挂 session-title**：标题由本机 dsh 生成、经 `persist.append`
  写进远端日志，所以 server 侧读日志是唯一能拿到标题的办法。

## 不变量 — 不要破坏

- **远端没有凭据/模型/agent loop**：只有执行世界与会话存储。
- **不引入第二会话格式或锁协议**：写所有权就是官方后端 SessionHandle 的租约；
  `SessionAlreadyOwnedError` 不包装、原样透传。`persist.rename` 也一样——它借的是
  官方写 handle 的租约，不是自己造的锁。
- **`persist.append` 服务端 fail-closed 校验**：不信 client，用官方 storage-contract
  词表校验后才落盘。
- **mux 宽容规则**（PLAN d6）：未知流的 `CREDIT/END/ABORT/OPEN_OK/OPEN_FAIL`
  忽略（迟到消息），仅未知流 `DATA` 是致命帧失步。
- 官方 `spawnSchema` 不允许 `stdio.stderr: 'ignore'`（只有 `pipe|inherit|collect`）。
- wire 边界全部显式校验；`serverId`/`installationId` 稳定持久化。
- handle 表在进程内存里，重启即清空；client 侧对此自愈一次，别在 server 侧加"持久
  handle"之类的补丁。

## 编码规约

- TS strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` +
  `allowImportingTsExtensions`：相对导入带 `.ts` 后缀；type-only 用 `import type`。
- 可选 wire 字段沿用条件展开惯用法 `...(x === undefined ? {} : { x })`。
- 注释解释**实测约束**；适用时注明对应的 PLAN 偏差编号。
- peer 依赖是官方 `>=0.2.0-rc.1 <0.3.0` 包；不 vendor 官方源码（REFACTOR-BRIEF
  §3.2 的 vendor 方案最终未采用，改为 peer 依赖 + profile patch 挂官方包）。
- `session/title` 这类**官方投影事件**的类型在本包的 `SessionEvent` 联合里可能不存在
  （投影插件未挂载），读日志时用局部松散类型（`{type, time, data}`）而不是去拓宽官方类型。
- 生命周期资源一律 `ctx.effect` 注册，随 fiber 销毁。

## 测试

本项目 `tests/session-store.test.ts`：工作区投影、写所有权错误透传、`titles` 的
latest-wins 与 `(id,sizeBytes)` 失效、`rename` 追加的事件形状与跨工作区拒绝。
重量级回归在 **client 项目**：conformance（官方 provider 对副本内存跑）、frame、
deploy、remote-persistence、routing-persistence、profile 冒烟。改了共享代码后，
**两边的 `pnpm typecheck && pnpm test` 都要跑**，并且用
`diff -q` 确认三个同步文件仍然逐字节相同：

```bash
for f in protocol.ts server/controller.ts server/session-store.ts server/index.ts server/processes.ts; do
  diff -q "src/$f" "../dsh-remote-workspace/src/$f" || echo "DIFF: $f"
done
```

## 版本策略

与 client 对齐：未发版前一律 `0.1.0-alphaN`（不要 `0.x.y`），两边的版本号保持一致。
发布后再打 tag / release；目前两个仓库都**没有** tag（也没建 release）。
