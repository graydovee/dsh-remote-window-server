# dsh-remote-workspace-server

**[dsh-remote-workspace](https://github.com/graydovee/dsh-remote-workspace) 的 server 半边。**

本插件运行在 **SSH 主机上的 DSH 运行时里**：应答官方 SSH 执行世界方法集，叠加 Remote
Session RPC，并把会话日志留在远端机器。client 侧只保留 agent loop、模型、凭据与 UI。

- 包：`dsh-remote-workspace-server@0.1.0-alpha68` —— bundle 插件，`manifestVersion: 1`
- client 半边：[`dsh-remote-workspace`](https://github.com/graydovee/dsh-remote-workspace)
- English: [README.md](README.md)

## What it provides

1. **官方执行世界。** `hello`、`heartbeat`、`close`、`executable`、`fs.*`、`process.*`
   （prepare / start / wait / done / terminate）、`terminal.*`（write / inspect / activity /
   resize / signal / environment）与 `sandbox`。官方 `dsh-fs-ssh`、`dsh-subprocess-ssh`、
   `dsh-sandbox-ssh` provider 无需改动即可连上——这才让远端主机成为真正的工作区，而不是一层
   代理。
2. **Remote Session RPC**（协议 `3`，跑在同一条多路复用通道上）：

   | 方法 | 作用 |
   | --- | --- |
   | `server.hello` | 握手：协议、`serverId`、`installationId`、版本、工作区根、home |
   | `reg.list` / `reg.create` / `reg.rename` / `reg.delete` | 服务端权威工作区清单（`workspaces.json`），可选带会话活动时间 |
   | `persist.list` / `persist.titles` | 某工作区的会话；标题与最后活动时间由日志 fold 出来 |
   | `persist.create` / `persist.open` | 写/读句柄（两者都带 `inheritedEventCount`） |
   | `persist.append` / `persist.flush` / `persist.close` | 按 seq 追加、刷盘、放租约 |
   | `persist.locate` | 会话属于哪个工作区 |
   | `persist.rename` | 追加一条官方 `session/title` 事件 |

3. **持久化全权委托。** RPC 之下全部是官方 `sessionPersistence` 服务与官方 JSONL 后端
   （`@deepseek-ai/dsh-session-persistence-jsonl`，`compression: zstd`）。本项目**没有**第二套
   会话文件格式、也**没有**第二套锁协议；`SessionAlreadyOwnedError` 等错误原样透传给 client。

## Compatibility

### Declared in `package.json`

| 项目 | 字段 | 取值 |
| --- | --- | --- |
| DSH 宿主 | `engines.dsh` | `0.2.1-rc.2` —— 精确值，唯一实测过的版本 |
| DSH 各包 | `peerDependencies` 里每个 `@deepseek-ai/dsh-*` | `0.2.1-rc.2` —— 精确值 |
| 清单格式 | `dsh.manifestVersion` | `1` |
| Node | `engines.node` | `^22.19.0 \|\| >=24.0.0` |
| 线协议 | `status.json` 与 `server.hello` 里的 `REMOTE_SESSION_PROTOCOL` | `3` |
| 验证基线 | `devDependencies` | `@deepseek-ai/dsh-*` `0.2.1-rc.2`、`@deepseek-ai/cordis` `4.0.5` |

DSH 在安装时与每次 profile 启动时都会读 `engines.dsh`，并且该字段存在时**它独自裁决**——
`@deepseek-ai/dsh*` 的 peer 不参与准入（这里 peer 也钉成同一个精确值，所以清单里没有任何一处
读起来像「0.2.x 都行」）。`0.2.1-rc.2` 是本 server 唯一验证过的版本：`hello` 必须满足该版本
引入的严格形状 `{ protocol, hash, kind, platform, nodeVersion, executable, root, workspace,
bootstrapHash? }`，而它委托的 JSONL 后端也是在那个版本变成 `apply()` 挂载的插件行。更新的
`0.2.x` 属于**未测**，不算支持——要接受它，就发一版 `engines.dsh` 指向它的新版本。

远端这两道边界都会体现出来：`dsh plugin` 在 pnpm 执行前就拒绝不匹配的安装；而运行时对不上的
profile 会把本插件的行判为拒绝、不挂载（client 侧表现为连接失败）。旁路是在 profile 的
`compatibility.json` 里逐对豁免（`dsh plugin --profile <p> allow-version <包@版本>
--dsh-version <运行时> --accept-risk`），明示不受支持。

### Two artifacts, two version axes

| 产物 | 版本轴 | 消费方 |
| --- | --- | --- |
| `lib/server.js` + `cordis.patch.yml`（本 npm 包） | `0.1.0-alphaN`（插件版本） | client 上传进 profile 的 `node_modules/dsh-remote-workspace` |
| `dsh-remote-server-<dshVersion>-<platform>.tar.gz`（运行时包） | release tag `server-v<dsh 版本>` | client 下载，或在本机暂存 |

运行时包是**为某一目标平台/架构**暂存好的 `@deepseek-ai/dsh` 依赖树：装好该平台的原生绑定、
剔除外来平台的 sibling。Node 是另一份部署（独立解包的 Node 发行版），本插件则由 client 自己
上传。所以**每个已发布的运行时包只钉一个 `@deepseek-ai/dsh` 版本**，tag 就是那个版本。上面的
精确 `engines.dsh` 描述的是这棵源码树支持什么；具体某个 tarball 是对着某一个 release 构建的，
两者在同一次发布里一起前进。

## How it is deployed

client 分五步把主机准备好（一律 `/bin/sh -c` + 绝对路径，不使用远端的 `PATH`、登录 shell 或
系统 npm）：

1. 把 Node 发行版解包到 `~/.dsh/server/node`、运行时包解包到 `~/.dsh/server/dsh`（上传或本地
   暂存后上传）；
2. 写入 `~/.dsh/profiles/dsh-remote-server/` 的 `package.json`、`cordis.yml`、
   `cordis.patch.yml` 与 `pnpm-workspace.yaml`；
3. 把本插件的 `package.json`、`cordis.patch.yml` 与 `lib/*.js` 上传到该 profile 的
   `node_modules/dsh-remote-workspace/`；
4. 启动 `DSH_HOME=<远端 home> PATH=<root>/node/bin:<root>/dsh/node_modules/.bin:$PATH
   exec <root>/dsh/node_modules/.bin/dsh --profile dsh-remote-server`；
5. 该进程的 stdio 就是多路复用通道——**不监听任何端口**。

profile 的 patch 层按序挂载：官方 JSONL 后端（root 为
`dshHomePath('remote-server-sessions')`，已存在 `sessionPersistence` 时 disabled）、
`session-projection`、`subprocess-local`、`sandbox-local`、`sandbox-policy`、`fs-sandbox`，
最后是本插件的行。

## Runtime behaviour

- **传输**：只有 stdio。`status.json` 是 0600 的发现清单（`serverId`、`installationId`、
  `version`、`protocol`、`transport: 'stdio'`、`pid`），启动时写入、dispose 时删除。
- **租约**：client 在通道上心跳；租约过期即释放服务端持有的全部进程。`leaseMs` 默认 30 秒，
  `maxProcesses` 默认 128，两者都能由 patch 行配置。
- **退出**：`exitOnClose`（默认 `true`）先写出 close 响应再退出——该 profile 没有自己的 app，
  服务端不能滞留。
- **分帧**：`type(1B) + length(4B 大端) + payload`，带 credit 窗口。未知流的
  `CREDIT/END/ABORT/OPEN_OK/OPEN_FAIL` 一律容忍（迟到消息），只有未知流的 `DATA` 是致命帧
  失步。

## Session storage

```
~/.dsh/remote-server-sessions/<projectKey>/<sessionId>/   权威 JSONL 日志（zstd）
~/.dsh/remote-server/server-id                            稳定服务端身份
~/.dsh/remote-server/workspaces.json                      服务端权威工作区清单
~/.dsh/remote-server/status.json                          发现清单（0600）
```

- `workspaceId = sha256(serverId + NUL + 远端规范路径)`，跨设备稳定；`serverId` 持久化在
  `identityFile`，绝不能变。
- `createSession` 把 header 的 cwd 覆盖成工作区路径，并把 `inheritedEventCount` 原样传下去
  ——缺了它，官方后端会拒绝被 fork 出来的（`isSeeded`）会话 header。
- `titles` 对每个会话 fold 最后一个 `session/title`（log-only、latest wins），并用最后一个
  事件的 `time` 作为 `updatedAt`；按 `(id, sizeBytes)` 记忆化、并发上限 4，单个会话读失败只
  丢它自己的标题。
- `rename` 从不打开会话：取写 handle、读日志长度得到连续的 next `seq`、追加一条官方形状的
  `session/title`、flush、放租约。
- close 句柄从不删除日志；从清单里移除工作区也从不触碰 `remote-server-sessions/**`。

## Sandbox on the remote

`dsh-sandbox-ssh` 把 `sandbox` 请求转发到这里，所以限制是在**远端主机上**决定的。远端没有
可用的沙箱后端时（例如没有 bubblewrap/Landlock 的 WSL 发行版），服务端按请求原样执行
`argv`，并返回官方 facts 对象、`enforcement: 'partial'`——远端世界本身即隔离边界，声称
`full` 是错误方向的失败。返回形状由官方 provider 用严格 schema 校验。

## Release process

运行时包**在本仓库**构建与发布：

```yaml
on: push: tags: ['server-v*']      # 例如 server-v0.2.1-rc.2
matrix: linux-x64/arm64（glibc）、darwin-x64/arm64
```

矩阵每一项产出 `dsh-remote-server-<dshVersion>-<platform-arch>[-libc].tar.gz`，外加
`.sha256` 与 `.manifest.json`，挂在该 tag 的 GitHub Release 上。矩阵**刻意不含 Windows**：
远端世界是 POSIX，`artifactTag()` 也只接受 `linux | darwin`。

本地构建（与 CI 同一份代码路径）：

```bash
node scripts/build-server-package.mjs --all --dsh-version 0.2.1-rc.2
node scripts/build-server-package.mjs --platform linux --arch x64 --libc gnu --out dist-server
```

暂存逻辑在 `src/provision/package-build.ts`，与 client 侧模块逐字节相同：为目平台安装
`@deepseek-ai/dsh@<版本>`、钉住原生绑定闭包（`node-addon-require-builtin-*`、
`@deepseek-ai/node-addon-system-*`）、剔除外来平台的 sibling，再打包。

## Development

```bash
pnpm install
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run（session-store 投影、所有权透传、titles、rename）
pnpm build        # tsdown → lib/（server + protocol）
```

`src/protocol.ts`、`src/server/`、`src/frame/`、`src/provision/package-build.ts` 与 client
仓库**逐字节相同**——client 部署并测试的是它自己那份 server bundle。改动必须两边同一次发布
一起改。

## License

MIT
