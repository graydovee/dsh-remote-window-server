# AGENTS.md — dsh-remote-window-server

本文件是 server 仓库的开发契约。用户如何部署和排障请看 README.md；这里定义跨仓库同步、wire
协议、运行时行为、测试和发布规则。公共仓库中不得出现真实主机、用户名、路径、token 或私人部署信息。

## 项目职责（v2）

本仓库构建安装到 per-client DSH profile 里的 Cordis 插件。profile 本身是一个普通的 loopback
`dsh web` 进程；client 通过 SSH 隧道访问它。插件负责：

- 通过同源 HTTP/SSE/mux 暴露 P1 API（handshake、lease、RPC、timeline、prompt、cancel、approval）；
- 复用官方 `webServer`、`connection`、`fs`、`subprocess`、`sandbox`、`sessionPersistence`；
- 懒解析官方 `workspaceRegistry`、`sessionController`、`agents`，让 server 成为 workspace/会话权威；
- 在 server 模式持有 managed agent 的官方 JSONL 写租约，并复用官方 live agent；
- 提供 local 模式需要的执行世界（文件、进程、沙箱）和 workspace/session 视图；
- 维护单 client profile 的 lease、executor 记录和 registry guard。

v2 的 server 对话由 client 原生渲染；v1 的 embed/bootstrap 路由只保留回退，不是正常流程，也不再扩展。
本仓库不持有 client 的 SSH 凭据；模型凭据按执行端留在实际运行 agent 的一侧。

client 仓库为 https://github.com/graydovee/dsh-remote-window。两边必须按同一发布版本、同一 DSH
运行时和同一 P1 协议协作。

## 本地命令

Node 使用 22.19 以上或 24 以上，依赖管理只用 pnpm：

    pnpm install
    pnpm typecheck
    pnpm test
    pnpm build
    pnpm pack:server-plugin

`pnpm build` 生成 `lib/plugin.js` 等运行产物；`lib/` 禁止手改，必须改 `src/` 后重新构建。
`pnpm pack:server-plugin` 生成 `dist/server-plugin/dsh-remote-window-server-<version>.tgz`、
`.sha256` 和 `.manifest.json`。`pnpm build:runtime` 是 v1 独立 runtime 包的遗留脚本，不是 v2 发布路径。

## 两仓逐字节同步

v2 的逐字节契约只有三个文件：

    src/protocol.ts
    src/frame/codec.ts
    src/frame/mux.ts

提交前比较：

    for f in protocol.ts frame/codec.ts frame/mux.ts; do
      cmp -s "src/$f" "../dsh-remote-window/src/$f" || echo "DIFF: $f"
    done

旧 v1 的 `src/server/**`、`src/frame/psk.ts`、`src/provision/package-build.ts` 同步集已退出 v2 契约；
不要在这三个共享文件之外新增需要双仓复制的实现。P1 协议常量
`REMOTE_WORKSPACE_PLUGIN_PROTOCOL = 1`；改方法名、路径、错误码或帧格式必须同一次变更更新两仓、
测试和协议文档。

## 构建边界

tsdown 入口是 `src/server-plugin/index.ts`，输出单文件 ESM `lib/plugin.js`，target node22。
只有以下依赖保持 external，其余全部 inline：

    @deepseek-ai/*（dsh-ssh、dsh-subprocess-local 除外）
    zod 固定 4.4.3，inline

`dsh-ssh` 和 `dsh-subprocess-local/output` 在 profile 安装里没有，必须 inline；zod 也必须 inline。
额外 external 会让目标机 profile 解析失败或拆散 Cordis service registry。`package.json` 的
`main`/`exports` 必须指向 `lib/plugin.js`；`files` 必须包含 `lib`、`cordis.patch.yml`、两份 README 和
LICENSE。

源码职责：

    src/server-plugin/index.ts          apply、路由注册、handshake、dispatch、服务探针
    src/server-plugin/lease.ts          单 client profile lease（20 s TTL）
    src/server-plugin/registry-guard.ts 唯一受控的官方 workspaceRegistry prototype 守卫
    src/server-plugin/managed.ts        server 模式 managed agent、prepare/resume/复用
    src/server-plugin/persist.ts        official sessionPersistence 桥、单写者租约
    src/server-plugin/agent-control.ts  prompt/cancel/approval/status
    src/server-plugin/timeline.ts       session/timeline 分页与 JSONL 读取
    src/server-plugin/events.ts         session/events SSE
    src/server-plugin/title-fold.ts     标题 fold 与 (sessionId,sizeBytes) 记忆化
    src/server-plugin/executor.ts       per-session executor 记录
    src/server-plugin/fs-api.ts         远端目录浏览
    src/server-plugin/embed.ts          v1 embed/bootstrap 遗留
    src/server-plugin/mux.ts             P1 mux WS 适配
    src/server-plugin/errors.ts         PluginError、scrub、HTTP 状态映射
    src/protocol.ts / src/frame/*      与 client 共享的 P1 类型/帧

所有 HTTP 路由先过 `ctx.connection.admit(req)`；JSON body ≤ 1 MiB（mux/portal/SSE 流除外）。

## 运行时硬约束

- profile server 只绑 `127.0.0.1`，不监听公网；token/cookie 只在 client host 内存。
- RPC 必须校验 `x-dsh-rw-client` / `x-dsh-rw-instance` 与 lease 匹配；异 client 返回
  `profile-foreign-client`，存活第二实例返回 `profile-in-use`，stale 才可接管。
- workspace 清单/标题/id/顺序/pin/archive 以官方 `workspaceRegistry` 为唯一权威；不得引入插件自己的
  副本或 `sha256(path)` 工作区 id。
- 会话清单/标题/运行态/rename/fork/cancel 以官方 `sessionController` 为权威；标题必须由插件 JSONL
  title fold 补齐，按 `(sessionId,sizeBytes)` 记忆化、latest wins、单会话失败不拖垮整批。
- 会话日志读写走官方 `sessionPersistence`；单写者由官方 JSONL flock 裁决，不造第二把锁或另一种
  JSONL 格式。`SessionAlreadyOwnedError` 呈现为 `session/writer-held`，v1 用显式错误，不接管。
- `session/prepare-server`：先查 `agents.get(sessionId)`，已有 live agent 就复用；官方 UI 已打开时
  返回 `managed:false, fallback:'restart'`，不得二次 resume。释放前 cancel → `agent.whenIdle()`（3 s
  预算）→ `sessionPersistence.flush()`；超时显式报错，不静默 SIGTERM。
- `session/prompt`、`session/cancel`、`session/approval` 只操作本 profile 的 managed agent；approval
  必须校验 turn/approval id，未知/已过期请求显式报错。
- executor 默认 `local`（新连接，client 通常没有 server 模型 key）；已有会话保留 server 端的
  `executor` 记录。切换必须按 D20：preview 列出当前 turn + 其它 active turn，apply 带
  `previewRevision` 与 `cancelActiveTurns:true`，缺清单拒绝。
- RegistryGuard 是唯一允许修改官方全局服务的例外：版本守卫、幂等安装、失败降级，且不得替换
  `workspaceRegistry` 实例；loader refresh 后复用同一 guard 的 loadedRevision/epoch。
- 没有可用 sandbox backend 时返回官方 facts：
  `{ argv, enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }`，不能用裸数组或
  `z.unknown()` 绕过形状。
- mux 对未知流的 CREDIT/END/ABORT/OPEN_OK/OPEN_FAIL 忽略迟到消息；未知流 DATA 是致命帧失步。
- 所有错误/SSE detail 先 `scrubSecrets`；`httpStatusFor` 必须覆盖 `RW_ERROR_CODES`，未映射业务码是
  契约 bug，不要静默 500。
- v1 embed/bootstrap 只保留兼容：`tapIndex` 注入、portal 纯字节代理、storage shim 影响 iframe realm。
  不要在新功能中依赖。

## P1 wire

路由前缀 `/dsh-remote-window-server`：

    /api/handshake          POST，返回 protocol/server/profile/capabilities/lease
    /api/rpc                POST，JSON { protocol, method, params }
    /api/events             GET SSE，hello/revision/capabilities
    /api/mux                WS，帧复用
    /api/session/events     GET SSE，timeline/prompt/cancel/approval 事件
    /embed/bootstrap.js      v1 遗留
    /embed/embed.css         v1 遗留

RPC 方法（协议 §16 冻结）：

    profile/heartbeat profile/release profile/status profile/cancel-all
    workspace/list workspace/create workspace/rename workspace/delete workspace/reorder
    session/list session/create session/prepare-server session/rename session/fork
    session/pin session/archive session/cancel session/reorder
    persist/list persist/stat persist/create persist/open persist/read persist/append
    persist/flush persist/close persist/locate
    executor/get executor/assign executor/plan-switch executor/switch executor/release
    registry/status registry/refresh
    fs/list
    session/timeline session/prompt session/approval session/status

其他常量：`REMOTE_WORKSPACE_PLUGIN_PROTOCOL = 1`，`RW_ROUTE_PREFIX =
'/dsh-remote-window-server'`。P1 请求必须带 protocol/client/instance 三个 header；SSE 的
EventSource 不能设 header，仅靠 cookie admission。

## Cordis profile patch

`cordis.patch.yml` 只挂一行：

    - insert:
        - id: dsh-remote-window-server
          name: dsh-remote-window-server

profile 的官方 base/web-app 已经提供 `sessionPersistence`、workspace、agent 等服务；不要再挂 v1 的
`remote-session-persistence`、`status.json` 或 `identityFile`。插件用 `ctx.get()` 懒解析可选服务，
`workspaceRegistry` 不写入静态 `inject`，否则 loader disable/enable 会卸载插件。

## 兼容性与发布

- 运行时契约唯一来源 `DSH_VERIFIED_RUNTIME`，当前只接受实测 `0.2.1-rc.3`。
- `engines.dsh` 与全部 `@deepseek-ai/dsh-*` peer/dependency 精确钉在 `0.2.1-rc.3`；zod `4.4.3`；
  `engines.node` 保持 `^22.19.0 || >=24.0.0`。
- 仓库版本等于发布版本，当前 `0.1.0-alpha.3`，两仓保持一致；内置 server tarball 版本必须精确一致。
- `pnpm pack:server-plugin` 的 manifest 必须包含协议、feature、`dshVersion`、字节长度与 sha256；
  client 用 `scripts/bundle-server-plugin.mjs` 内置并写 `assets/server-plugin/checksums.json`。
- 发布前至少两仓 `pnpm typecheck && pnpm test && pnpm build`，再在隔离 `DSH_HOME` 用 rc.3 启动
  profile 做 `/api/handshake` 冒烟。版本号变更但未跑冒烟时不得宣称 verified。
- 独立 runtime 包/`dist-runtime/` 是 v1 遗留产物；不要用它代替 v2 的 profile 插件，也不要修改全局
  runtime。

## 文档

README 只写公开用户能执行的部署、兼容性、数据位置与排障；内部测试编号、个人路径、临时版本、发布
流水线细节只放本文件或测试注释。协议/架构变化要同步 client 的
`doc/refactor-v1-architecture.md`、`doc/refactor-v1-protocol.md` 和
`doc/dsh-rc3-compatibility.md`。
