# AGENTS.md — dsh-remote-workspace-server

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
- 维护单 client profile 的 lease、executor 记录和 registry guard；
- 在 profile 的官方 UI 里注册 `sidebar.panellist` 一行与 `main` 一页，显示 client 发布的连接列表
  （浏览器半，见「浏览器半」一节）。

v2 的 server 对话由 client 原生渲染；v1 的 embed/bootstrap 路由只保留回退，不是正常流程，也不再扩展。
本仓库不持有 client 的 SSH 凭据；模型凭据按执行端留在实际运行 agent 的一侧。

client 仓库为 https://github.com/graydovee/dsh-remote-workspace。两边必须按同一发布版本、同一 DSH
运行时和同一 P1 协议协作。

## 本地命令

Node 使用 22.19 以上或 24 以上，依赖管理只用 pnpm：

    pnpm install
    pnpm typecheck
    pnpm test
    pnpm build
    pnpm pack:server-plugin

`pnpm build` 生成 `lib/plugin.js` 等运行产物；`lib/` 禁止手改，必须改 `src/` 后重新构建。
`pnpm pack:server-plugin` 生成 `dist/server-plugin/dsh-remote-workspace-server-<version>.tgz`、
`.sha256` 和 `.manifest.json`。`pnpm build:runtime` 生成 `dist-runtime/dsh-runtime-<dsh 版本>-<平台>-<架构>.tar.gz`
（`node/` + `dsh/` 布局）——它是 client 在远端装隔离运行时用的产物，**不能**代替 profile 插件；
两者都由 `.github/workflows/server-release.yml` 在 `v*` tag 发布，dsh 版本取自 `engines.dsh`。

## 两仓逐字节同步

v2 的逐字节契约只有三个文件：

    src/protocol.ts
    src/frame/codec.ts
    src/frame/mux.ts

提交前比较：

    for f in protocol.ts frame/codec.ts frame/mux.ts; do
      cmp -s "src/$f" "../dsh-remote-workspace/src/$f" || echo "DIFF: $f"
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

第二个 tsdown 目标 `tsdown.client.config.mjs` 构建浏览器半：入口 `src/client/index.tsx`，输出 CJS
`lib/client.js`，banner/footer 为 `window.__ModuleLoader__.load({ id: 'dsh-remote-workspace-server', factory })`。
只有平台模块表 external（`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`cordis`、
`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`），其余全部 inline（含
`src/protocol.ts`）；纯度门禁拒绝 Node 内置模块和不在表里的 `@deepseek-ai/*` 值导入。`package.json` 用
`exports['./client']` 指向 `lib/client.js`，并用 `dsh.client = { inject: ['@deepseek-ai/dsh-client-ui-slots',
'@deepseek-ai/dsh-client-ui-primitives'], platform: 'web' }` 声明浏览器半；`build`/`prepare` 依次跑三个
tsdown 配置。改浏览器半后必须重跑 `pnpm build` 并确认 `lib/client.js` 含 `__ModuleLoader__.load`。

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
    src/server-plugin/client-targets.ts client 连接快照：白名单、脱敏、updatedAt 单调（只存内存）
    src/server-plugin/embed.ts          v1 embed/bootstrap 遗留
    src/server-plugin/mux.ts             P1 mux WS 适配
    src/server-plugin/errors.ts         PluginError、scrub、HTTP 状态映射
    src/client/index.tsx               浏览器半入口：inject=['slots']、注册 panellist 行与 main 页
    src/client/section.tsx             「远程连接」行（仅图标）与列表面板
    src/client/targets-model.ts        纯视图模型：读路径、解包、当前行、endpoint/阶段文案
    src/client/data.ts                 2 s 轮询 + visibilitychange/focus，失败保留旧渲染
    src/client/commands.ts             iframe → parent 三条命令（版本与校验在 protocol.ts）
    src/client/locales.ts              zh 源 + en: Record<LocaleKey,string>，语言取 <html lang>
    src/client/styles.ts               单份 `<style data-plugin="dsh-remote-workspace-server">`
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

路由前缀 `/dsh-remote-workspace-server`：

    /api/handshake          POST，返回 protocol/server/profile/capabilities/lease
    /api/rpc                POST，JSON { protocol, method, params }
    /api/events             GET SSE，hello/revision/capabilities
    /api/mux                WS，帧复用
    /api/session/events     GET SSE，timeline/prompt/cancel/approval 事件
    /api/client/targets     GET，返回 client 发布的连接快照（只过 admit，不校验 lease 头）
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
    client/targets

其他常量：`REMOTE_WORKSPACE_PLUGIN_PROTOCOL = 1`，`RW_ROUTE_PREFIX =
'/dsh-remote-workspace-server'`。P1 请求必须带 protocol/client/instance 三个 header；SSE 的
EventSource 不能设 header，仅靠 cookie admission。能力位 `clientTargets: 1` 只在进程内存在快照存储时
声明（`apply` 总会建），缺位时 client 不发布、功能静默关闭。

## Cordis profile patch

`cordis.patch.yml` 只挂一行：

    - insert:
        - id: dsh-remote-workspace-server
          name: dsh-remote-workspace-server

profile 的官方 base/web-app 已经提供 `sessionPersistence`、workspace、agent 等服务；不要再挂 v1 的
`remote-session-persistence`、`status.json` 或 `identityFile`。插件用 `ctx.get()` 懒解析可选服务，
`workspaceRegistry` 不写入静态 `inject`，否则 loader disable/enable 会卸载插件。

## 浏览器半：左栏「远程连接」与连接列表（v3）

profile 的官方 UI（直接打开或被 client 全屏 iframe 嵌入）里，本插件注册两个声明式槽位，**不接管**
`sidebar` / `sidebar.workspaces`（两者都是 single，注册会替换整列/整个浏览区），也不做 DOM 注入：

    sidebar.panellist  { name:'sidebar.panellist', id:'dsh-remote-workspace', order:5,
                         label:() => t('connections.row'), registrant:'dsh-remote-workspace-server' }
                       组件只收到 { size, active }，只画 IconGlobeOutlineRegular；
                       **行按钮/标签/选中态归 shell**，插件不渲染 <button>、不调 layout.selectPanel，
                       shell 用同一个 id 打开下面的 main 页
    main               { name:'main', key:'dsh-remote-workspace', label:() => t('connections.title') }
                       （注册包在 try/catch 里：这槽的选项不匹配不能让侧栏行消失）

数据流（协议 §16.14）：client host 用 P1 `client/targets` 发布快照 → 本插件只存内存（`updatedAt` 单调、
≤64 行、lease 释放/重启清空、到达时再 `scrubSecrets`）→ 浏览器半用相对路径
`dsh-remote-workspace-server/api/client/targets` 每 2 s 轮询（`visibilitychange`/`focus` 立即刷新）→ 行点击
`parent.postMessage(rwPortalSwitchTarget(id), location.origin)`，`新建连接` 发
`rwPortalOpenConnectDialog()`，`返回本地` 发 `rwPortalClosePortal()`。三条命令的版本与校验只在
`src/protocol.ts`（`RwPortalCommand` / `parseRwPortalCommand`），不要另写一套。

约束：

- 读路由只过 `ctx.connection.admit(req)`（与 bootstrap/embedCss 同），不要求 lease 头；空快照返回
  `{ ok: true, value: { clientId: '', updatedAt: 0, targets: [] } }`，不是错误。
- 非 2xx/解析失败保留上一次渲染并显示「同步不可用」，**绝不**渲染成「没有连接」。
- `dshRwTarget` 查询参数决定高亮行，缺失时回退快照的 `activeTargetId`。
- `window.parent === window`（目标机直接打开）时列表仍可见，三条命令禁用并提示。
- 不发/不存任何 secret：行只有 `{ targetId, label, kind, host?, port?, username?, phase, active? }`；
  `credentialKey`、`privateKeyPath`、`hostKeyFingerprint`、`profileName` 一律不跨边界。
- 只改 `src/client/**` 后必须 `pnpm build`：`lib/client.js` 入库随 tarball 发布；profile 里已装的旧
  tarball 不含浏览器半，重装 tarball 并重启 profile server 后才会出现该行。

## 兼容性与发布

- `engines.dsh` 与全部 `@deepseek-ai/dsh-*` peer 写区间 `>=0.2.1-rc.2 <=0.2.2-rc.1`（与 client 的
  `compat/runtimes.json` 同一区间），本仓安装/测试用的 dsh 包钉区间内最新版本 `0.2.2-rc.1`；zod `4.4.3`；
  cordis devDependency 跟该运行时用 `4.1.0`（peer 仍写 `^4.0.5`，覆盖旧的 `4.0.5` profile）；
  `engines.node` 保持 `^22.19.0 || >=24.0.0`。
- 仓库版本等于发布版本，当前 `0.1.0-alpha.8`，两仓保持一致；内置 server tarball 版本必须精确一致。
- 上游发新 dsh 时先改区间与钉版，再重打包并让 client 重新 bundle：`pnpm build` →
  `pnpm pack:server-plugin` → client `node scripts/bundle-server-plugin.mjs --tarball <tgz>`。只改版本号
  不重打包含义为零：`dsh-ssh` 被 inline，协议号与请求 schema 跟着构建时的版本走。
- `pnpm pack:server-plugin` 的 manifest 必须包含协议、feature、`dshVersion`、字节长度与 sha256；
  client 用 `scripts/bundle-server-plugin.mjs` 内置并写 `assets/server-plugin/checksums.json`。
- npm 发布由 `.github/workflows/npm-release.yml` 在 `v*` tag 触发：typecheck/test/build 后把
  `pnpm pack:server-plugin` 的 tarball 发到 npm（`dsh-remote-workspace-server`，provenance）。认证只用
  npm Trusted Publishing（OIDC）：npm 包要登记 `graydovee/dsh-remote-workspace-server` + `npm-release.yml`，
  workflow 保留 `id-token: write` 并删掉 setup-node 生成的 `_authToken` 占位；仓库不配置 npm token
  secret。runtime 包仍走 server-release.yml。
- 发布前至少两仓 `pnpm typecheck && pnpm test && pnpm build`，再在隔离 `DSH_HOME` 用区间内最新版本
  （当前 `0.2.2-rc.1`）启动 profile 做 `/api/handshake` 冒烟。版本号变更但未跑冒烟时不得宣称 verified。
- `dist-runtime/` 的隔离 runtime 包由 `server-release.yml` 发布，矩阵来自 client release 资产
  `runtime-compat.json`（client 的 `compat/runtimes.json` 投影）里该 dsh 声明的平台，并且只构建本仓
  builder 能 stage 的 POSIX 布局（linux x64/arm64 gnu、darwin x64/arm64）；win32 目标尚未纳入（builder
  只处理 POSIX Node 布局），release 正文会把它标成「not published yet」而不是让发布失败。dsh 版本永远
  取自 `engines.dsh`（`server-v<dsh>` tag / dispatch 才可覆盖），不在这里手写；缺失快照视为两仓版本
  不同步，直接失败。
- release 正文由 `scripts/render-release-notes.mjs` 生成：支持的 dsh 区间、哪些平台有产物、哪些还没有、
  以及每个产物的 sha256；`runtime-compat.json` 同时作为资产上传。不要改回
  `generate_release_notes: true` 的手写/自动正文（历史上正文写着 rc.2，而包里要求 rc.3）。
- 不要用它代替 profile 插件，也不要修改全局 runtime。

## 文档

README 只写公开用户能执行的部署、兼容性、数据位置与排障；内部测试编号、个人路径、临时版本、发布
流水线细节只放本文件或测试注释。协议/架构变化要同步 client 的
`doc/refactor-v1-architecture.md`、`doc/refactor-v1-protocol.md` 和
`doc/dsh-rc3-compatibility.md`。
