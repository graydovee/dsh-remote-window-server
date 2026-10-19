# dsh-remote-workspace-server

[English](README.md) | 中文

**[dsh-remote-workspace](https://github.com/graydovee/dsh-remote-workspace) 的 server 半边。**
本插件运行在 **SSH 主机上的 DSH 运行时里**：应答官方 SSH 执行世界方法集，叠加 Remote
Session RPC，并把会话日志留在远端机器。client 侧只保留 agent loop、模型、凭据与 UI。

- 正常情况**不需要手动安装**——client 会部署运行时、上传本包并通过 stdio 启动它。
- 只在 **DSH `0.2.1-rc.2`** 上验证过，`engines.dsh` 的精确值就是这个意思。

## Quick start

### 1. Requirements

| 位置 | 要求 |
| --- | --- |
| 远端主机 | POSIX：`/bin/sh`、`tar`、`chmod`、可写 `$HOME` |
| 运行时 | `@deepseek-ai/dsh` `0.2.1-rc.2` 与一份 Node 发行版，都由 client 部署到 `~/.dsh/server` |
| 主机上的 Node | **不需要**——部署的 Node 运行部署的 `dsh` |

### 2. Run it by hand (debugging only)

下列步骤就是 client 自动做的事，手动跑一遍可以用来复现它。

1. 暂存运行时包（与 CI 同一份代码路径）：

   ```bash
   node scripts/build-server-package.mjs --platform linux --arch x64 --libc gnu --out dist-server
   ```

2. 在主机上把 tarball 解到 `~/.dsh/server/dsh`，把 Node 发行版解到 `~/.dsh/server/node`。
3. 写 profile `~/.dsh/profiles/dsh-remote-server/`——`package.json`、`cordis.yml`、
   `cordis.patch.yml`（三者都由 client 生成，下面那些行就出自它的 `cordis.patch.yml`）——
   并把本包放到 `node_modules/dsh-remote-workspace/`。
4. 在 stdio 上启动它：

   ```bash
   DSH_HOME="$HOME" \
   PATH="$HOME/.dsh/server/node/bin:$HOME/.dsh/server/dsh/node_modules/.bin:$PATH" \
   exec "$HOME/.dsh/server/dsh/node_modules/.bin/dsh" --profile dsh-remote-server
   ```

**没有监听端口**：进程在 stdin/stdout 上跑多路复用协议，`~/.dsh/remote-server/status.json`
（0600）会公布 `serverId`、`installationId`、`version`、`protocol`、`transport: 'stdio'` 与
`pid`。手动跑时什么都不打印就退出，通常是 profile 的 patch 层没先挂上官方 JSONL 后端，于是
没有 `sessionPersistence` 可注入。

### 3. Configure

client 会把这些写进远端 profile 的 `cordis.patch.yml` 里 `remote-workspace-server` 那一行；
只有自定义部署时才需要手写。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `workspace` | `process.cwd()` | client 未指定时报告的 workspace |
| `leaseMs` | `30000` | client 租约（毫秒），由 `heartbeat` 续期；过期即释放全部持有的进程 |
| `maxProcesses` | `128` | 可 prepare / 运行中的进程上限 |
| `exitOnClose` | `true` | 收到 `close` 后退出（专用 server profile 需要这个） |
| `serverId` | 自动生成 | 稳定的服务端身份，是每个 `workspaceId` 的组成部分——**绝不能变** |
| `installationId` | 自动生成 | 多实例发现用的安装身份 |
| `identityFile` | 空 | 保存稳定 `serverId` 的文件 |
| `workspaceIndex` | 空 | 独立工作区清单；存在 `workspaceRegistry` 时忽略 |
| `statusFile` | 空 | 发现清单路径 |
| `version` | 包版本 | 由 `server.hello` 与 `status.json` 报告 |

### 4. What it serves

官方执行世界方法（`dsh-fs-ssh` / `dsh-subprocess-ssh` / `dsh-sandbox-ssh` provider 零改动直连）：

| 组 | 方法 |
| --- | --- |
| 通道会话 | `hello`、`heartbeat`、`close` |
| 文件系统 | `fs.resolve`、`fs.lstat`、`fs.stat`、`fs.list`、`fs.readText`、`fs.stream`、`fs.next`、`fs.streamClose`、`fs.readBytes`、`fs.readRange`、`fs.write`、`fs.edit` |
| 进程 | `executable`、`process.prepare`、`process.start`、`process.wait`、`process.done`、`process.terminate` |
| 终端 | `terminal.environment`、`terminal.write`、`terminal.inspect`、`terminal.activity`、`terminal.resize`、`terminal.signal` |
| 沙箱 | `sandbox` |

Remote Session RPC（线协议 `3`，同一条通道）：

| 方法 | 作用 |
| --- | --- |
| `server.hello` | 协议、`serverId`、`installationId`、版本、工作区根、home |
| `reg.list` / `reg.create` / `reg.rename` / `reg.delete` | 服务端权威工作区清单（`workspaces.json`），可选带会话活动时间 |
| `persist.list` / `persist.titles` | 某工作区的会话；标题与最后活动时间由日志 fold 出来 |
| `persist.create` / `persist.open` | 写/读句柄（两者都带 `inheritedEventCount`） |
| `persist.append` / `persist.flush` / `persist.close` | 按 seq 追加、刷盘、放租约 |
| `persist.locate` | 会话属于哪个工作区 |
| `persist.rename` | 追加一条官方 `session/title` 事件 |

### 5. Day-to-day

- **每个 target 只有一个 server 进程。** `persist.create` 返回的是内存句柄，所以该工作区的
  所有 `persist.*` 必须落到同一个进程；client 因此按 target 复用同一条通道。
- **句柄表在内存里。** 重启（空闲租约、显式停止，或插件更新后的自动重部署）会清空它；
  client 遇到 `unknown remote session handle` 会重开一次。
- **close 从不删除。** `persist.close`、移除工作区、停掉 server 都不会删掉会话日志。

## Troubleshooting

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 插件行被拒、client 报连接失败 | 运行时的 DSH 版本与本插件精确的 `engines.dsh` 不符 | 换用 `0.2.1-rc.2` 运行时，或按 [Compatibility](#compatibility) 逐对豁免 |
| 重启后立刻 `session "…" not found` | 内存里的句柄表没了 | 重新打开会话；client 会自动重试一次 |
| 空闲时长时间运行的命令被杀 | client 停了心跳，租约过期 | 保持连接；只有自定义 client 才需要调大 `leaseMs` |
| `status.json` 不存在 | 没配置 `statusFile`，或进程已经退出 | 检查 profile 行与进程状态 |
| `process.done` 输出像乱码 | `collected.stdout.tail` 是 base64 | 解码后再看 |
| 命令报告 `enforcement: 'partial'` | 远端主机没有沙箱后端（没有 bubblewrap/Landlock） | 属预期——远端世界就是隔离边界 |

## Compatibility

| 项目 | 字段 | 取值 |
| --- | --- | --- |
| DSH 宿主 | `engines.dsh` | `0.2.1-rc.2` —— 精确值，唯一验证过的版本 |
| DSH 各包 | `peerDependencies` 里每个 `@deepseek-ai/dsh-*` | `0.2.1-rc.2` —— 精确值 |
| 清单格式 | `dsh.manifestVersion` | `1` |
| Node | `engines.node` | `^22.19.0 \|\| >=24.0.0` |
| 线协议 | `status.json` 与 `server.hello` 里的 `REMOTE_SESSION_PROTOCOL` | `3` |
| 验证基线 | `devDependencies` | `@deepseek-ai/dsh-*` `0.2.1-rc.2`、`@deepseek-ai/cordis` `4.0.5` |

DSH 在安装时与每次 profile 启动时都会读 `engines.dsh`，并且该字段存在时**它独自裁决**——
peer 不参与准入（这里 peer 也钉成同一个精确值，所以清单里没有任何一处读起来像「0.2.x 都
行」）。`0.2.1-rc.2` 是本 server 唯一验证过的版本：`hello` 必须满足该版本引入的严格形状
`{ protocol, hash, kind, platform, nodeVersion, executable, root, workspace, bootstrapHash? }`，
而它委托的 JSONL 后端也是在那个版本变成 `apply()` 挂载的插件行。更新的 `0.2.x` 属于**未测**，
不算支持。

远端这两道边界都会体现出来：`dsh plugin` 在 pnpm 执行前就拒绝不匹配的安装；运行时对不上的
profile 会把本插件的行判为拒绝、不挂载。旁路是在 profile 的 `compatibility.json` 里逐对豁免
（`dsh plugin --profile <p> allow-version <包@版本> --dsh-version <运行时> --accept-risk`），
明示不受支持。

### Two artifacts, two version axes

| 产物 | 版本轴 | 消费方 |
| --- | --- | --- |
| `lib/server.js` + `cordis.patch.yml`（本 npm 包） | 插件发布版本（`v0.1.0-alpha1`） | client 上传进 profile 的 `node_modules/dsh-remote-workspace` |
| `dsh-remote-server-<dshVersion>-<platform>.tar.gz`（运行时包） | release tag `server-v<dsh 版本>` | client 下载，或在本机暂存 |

运行时包是**为某一目标平台/架构**暂存好的 `@deepseek-ai/dsh` 依赖树：装好该平台的原生绑定、
剔除外来平台的 sibling。Node 是另一份部署，本插件则由 client 自己上传。所以**每个已发布的
运行时包只钉一个 `@deepseek-ai/dsh` 版本**，tag 就是那个版本。

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

## Data and storage

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
