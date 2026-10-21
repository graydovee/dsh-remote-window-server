# AGENTS.md — dsh-remote-workspace-server

本文件是 server 仓库的开发契约。用户如何部署和排障请看 README.md；这里定义跨仓库同步、wire
协议、运行时行为、测试和发布规则。公共仓库中不得出现真实主机、用户名、路径、token 或私人部署信息。

## 项目职责

本仓库构建运行在目标机上的 headless DSH plugin。它不包含 agent loop、模型调用或 SSH 凭据，只负责：

- 复用 DSH 官方 fs、subprocess、terminal、sandbox provider；
- 通过 stdio 对 client 提供官方执行世界 RPC；
- 提供 Remote Session protocol v3 的工作区 registry 与 persist.*；
- 把会话日志写入目标机的官方 JSONL backend；
- 写入短期 status.json，供 client 发现 server 身份。

client 仓库为 https://github.com/graydovee/dsh-remote-workspace。两边必须按同一协议和同一发布版本协作。

## 本地命令

Node 使用 22.19 以上或 24 以上，依赖管理只用 pnpm：

    pnpm install
    pnpm typecheck
    pnpm test
    pnpm build
    node scripts/build-server-package.mjs --dsh-version 0.2.1-rc.2 --platform linux --arch x64 --libc gnu --out dist-server
    node scripts/build-server-package.mjs --all --dsh-version 0.2.1-rc.2

pnpm build 生成 lib/server.js 和 lib/protocol.js；lib/ 是入库产物，禁止手改。server 的测试覆盖
session-store、workspace registry、titles、rename、所有权透传和并发文件收敛。共享代码变更后，还必须在
client 仓库运行 typecheck、test、build 和 conformance。

## 两仓逐字节同步

以下文件在本仓库和 client 仓库必须逐字节相同：

    src/protocol.ts
    src/server/controller.ts
    src/server/index.ts
    src/server/processes.ts
    src/server/session-store.ts
    src/frame/codec.ts
    src/frame/mux.ts
    src/frame/psk.ts
    src/provision/package-build.ts

提交前执行：

    for f in protocol.ts server/controller.ts server/index.ts server/processes.ts server/session-store.ts frame/codec.ts frame/mux.ts frame/psk.ts provision/package-build.ts; do
      cmp -s "src/$f" "../dsh-remote-workspace/src/$f" || echo "DIFF: $f"
    done

client 的 provisioner 会把自己的 lib/server.js 部署到目标机；server 仓库的 release 包也由本仓库构建。
所以共享文件只改一侧是发布阻断错误。协议常量 REMOTE_SESSION_PROTOCOL 当前为 3，官方 SSH 执行 RPC
仍为 v1。协议变化必须同步 server.hello、status.json、client copy、测试和 release 说明。

## 构建边界

tsdown 入口是 server 和 protocol，target 为 node22、格式为 ESM。server bundle 只 external：

    @deepseek-ai/cordis
    @deepseek-ai/schemastery

其它依赖，包括 dsh-ssh 的 protocol/schema 和 zod，必须内联；额外 external 会让目标机 profile
无法解析模块或拆散 Cordis service registry。zod 固定为 4.4.3，禁止区间依赖。所有 @deepseek-ai/dsh-* peer
和 engines.dsh 都精确钉在 0.2.1-rc.2。

源码职责：

    src/server/index.ts       apply 行、配置 schema、server 生命周期、status.json
    src/server/controller.ts  官方 RPC + Remote Session RPC、wire schema、限制与握手
    src/server/session-store.ts workspace registry、JSONL 适配、titles、rename、句柄
    src/server/processes.ts   进程和 terminal handle、heartbeat lease
    src/frame/                 分帧、mux、PSK/capability
    src/protocol.ts            与 client 共享的 Remote Session 类型和方法名
    src/provision/package-build.ts 目标平台运行时包构建，与 client 同源

所有边界输入都用显式 schema 校验。spawnSchema 不接受 stdio.stderr: ignore；只能使用官方允许的
pipe、inherit 或 collect。生命周期资源使用 ctx.effect。

## 运行时硬约束

- server 只使用目标机官方 provider；不复制第二套 SessionPersistence、JSONL 格式或锁协议。
- persist.open 的写所有权就是官方 SessionHandle 租约；SessionAlreadyOwnedError 原样透传。
- persist.append 必须 fail-closed，按官方 storage-contract 词表校验后才能落盘。
- serverId 由 identityFile 稳定保存；workspaceId = sha256(serverId + NUL + canonical remote path) 的前 16
  个十六进制字符。升级不可轮换 serverId。
- createSession 和 openSession 必须把 header cwd 重锚到工作区路径，并原样透传 inheritedEventCount；否则 seeded
  fork 会被官方后端拒绝。
- titles 只读日志中的最后一个 session/title，latest wins；按 (session id, sizeBytes) 记忆化，并发上限 4，
  单个会话读取失败不能让整批失败。
- rename 不打开会话：借官方写 handle、读取日志长度生成连续 seq、追加官方 session/title 事件、flush、释放租约并
  失效标题缓存。
- 句柄表只在内存中，重启后全部失效；不要实现持久句柄。client 只允许对 unknown handle 自愈一次。
- close 的回复必须先刷出再退出；process.exit 不能丢排队写，keep-alive timer 不能阻止优雅释放。
- status.json 是发现清单，不是心跳；文件权限 0600，进程退出时删除。
- 远端没有可用 sandbox backend 时，返回：
  { argv, enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }。
  不能返回裸数组，也不能用 z.unknown() 通过错误的 wire 形状。
- mux 对未知流的 CREDIT、END、ABORT、OPEN_OK、OPEN_FAIL 忽略迟到消息；未知流 DATA 是致命帧失步。

## Cordis profile patch

cordis.patch.yml 只挂两类行：

1. remote-session-persistence：官方 session-persistence-jsonl，root 为 dshHomePath('remote-server-sessions')，
   compression 为 zstd；已有 sessionPersistence 时 disabled。
2. dsh-remote-workspace-server/server：identityFile、workspaceIndex、statusFile 使用
   dshHomePath('remote-server/...')，exitOnClose 默认 true。

远端 profile 不挂 session-title。标题由 client 产生并经 persist.append 写入日志，因此 titles 必须 fold
日志事件。不要把 workspaceRegistry 写入 inject；没有 registry 时 session-store 才使用 standalone workspaces.json。

## Wire 方法

官方执行世界方法必须与 dsh-ssh helper 对齐：

    hello heartbeat close executable
    fs.resolve lstat stat list readText stream next streamClose readBytes readRange write edit
    process.prepare start wait done terminate
    terminal.environment write inspect activity resize signal
    sandbox

Remote Session protocol v3：

    server.hello
    reg.list reg.create reg.rename reg.delete
    persist.list persist.titles persist.rename persist.create persist.open
    persist.append persist.flush persist.close persist.locate

server.hello 的响应必须保持严格形状，包含 protocol、serverId、installationId、version、workspacesRoot，
可选 home。官方 hello 仍要求 kind=node-script、executable=process.execPath 等字段；旧形状不能兼容。

## 测试与发布

修改后至少运行：

    pnpm typecheck
    pnpm test
    pnpm build

共享代码还要在 client 仓库运行：

    pnpm typecheck
    pnpm test
    pnpm build
    pnpm exec vitest run tests/conformance.test.ts

运行时包由 .github/workflows/server-release.yml 发布。tag 用 server-v<dsh-version> 或插件版本 v<pluginVersion>（client 按这个顺序回退查找；artifact 名始终跟随 dsh 版本）；
当前矩阵为 linux-x64-gnu、linux-arm64-gnu、darwin-x64、darwin-arm64。每个 release 必须同时包含：

    dsh-remote-server-<dshVersion>-<platform>-<arch>[-<libc>].tar.gz
    <same-name>.tar.gz.sha256
    <same-name>.manifest.json

NTFS 会丢可执行位，部署脚本必须用 test -e 和 chmod +x，并以 --version 成功为可执行判据。所有
packageFiles 路径都是远端 POSIX 路径，不能使用 Windows join 生成反斜杠或拼接成 libserver.js。

仓库版本等于发布版本，当前为 0.1.0-alpha.2，两仓保持一致。本机调试可以在 build 前追加临时修订号，
但不得提交、push、打 tag 或发布；部署完成后恢复 package.json 和 src/server/index.ts，再重新 build。

README 只写公开用户能执行的安装、手动部署、配置、兼容性与排障。内部测试编号、个人路径和临时版本只放
本文件或测试注释。
