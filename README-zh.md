# dsh-remote-workspace-server

[English](README.md) | 中文

本仓库是 [dsh-remote-workspace](https://github.com/graydovee/dsh-remote-workspace) 的远端部分。
它是运行在目标机 DSH profile 中的无头 DeepSeek Harness 插件。client 通过 stdio 启动它，进程不监听
TCP 端口。

server 提供官方 DSH 执行世界的文件、子进程、终端和沙箱转发能力，以及 client 使用的远端会话平面。
工作区清单和 JSONL 会话日志由 server 负责，agent loop、模型请求与凭据仍留在 client 本机。

大多数用户不需要直接安装本仓库。client 要么复用目标机上兼容的 dsh，要么部署本仓库构建并发布的运行时包。

## 目标机布局

部署后的目标机大致包含：

    ~/.dsh/server/
      node/                 部署运行时使用的 Node
      dsh/                  @deepseek-ai/dsh 及其依赖
    ~/.dsh/profiles/dsh-remote-server/
      package.json
      cordis.yml
      cordis.patch.yml
      node_modules/dsh-remote-workspace/
    ~/.dsh/remote-server/
      server-id             用于计算工作区 id 的稳定身份
      workspaces.json       没有官方 registry 时使用的独立清单
      status.json           短期发现清单
    ~/.dsh/remote-server-sessions/
      ...                   官方 JSONL 会话存储

client 启动 profile 的命令等价于：

    DSH_HOME="$HOME" \
    PATH="$HOME/.dsh/server/node/bin:$HOME/.dsh/server/dsh/node_modules/.bin:$PATH" \
    exec "$HOME/.dsh/server/dsh/node_modules/.bin/dsh" --profile dsh-remote-server

server 随后从 stdin/stdout 读写分帧协议。client 关闭后，进程句柄会释放；默认情况下专用 server
profile 也会退出。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| DSH | 当前版本精确使用 0.2.1-rc.2 |
| 目标系统 | Linux 或 macOS，具备 POSIX shell |
| 目标工具 | /bin/sh、tar、chmod 和可写的 $HOME |
| 目标机 Node | client 会单独上传匹配的 Node；手动部署时需要自行提供 |
| client | 匹配的 dsh-remote-workspace，或等价的手工 profile |

Windows 作为 client 主机时通过 WSL 使用。本仓库不发布原生 Windows 远端包。

## 手动部署

手动部署适合协议调试，或在没有 client 向导时检查目标机。profile 文件属于 client/server 契约，
应从 client 已部署的目标机复制，或使用 client provisioner 生成。

1. 在安装了 Node 和 pnpm 的机器上构建目标包：

       pnpm install
       pnpm build
       node scripts/build-server-package.mjs --dsh-version 0.2.1-rc.2 --platform linux --arch x64 --libc gnu --out dist-server

   根据目标替换为 linux/arm64、darwin/x64 或 darwin/arm64。脚本会生成 .tar.gz、.sha256 和
   manifest。
2. 将 Node 发行版和 DSH 包解压到 ~/.dsh/server/，并把本仓库构建出的 lib/ 文件放入 profile 的
   node_modules/dsh-remote-workspace/。
3. 创建 ~/.dsh/profiles/dsh-remote-server/，放入匹配的 package.json、cordis.yml、
   cordis.patch.yml 和 pnpm-workspace.yaml。patch 必须挂载官方 JSONL 后端到
   ~/.dsh/remote-server-sessions，并挂载本插件的 server 行。
4. 用上面的命令启动 profile。stdout 必须专用于协议，诊断信息写到 stderr。

成功启动后会写入 status.json，包含 serverId、installationId、version、protocol、
transport: "stdio" 和 pid；server 退出时会删除它。

## 配置

client 会把下列字段写入 cordis.patch.yml 中的 dsh-remote-workspace-server/server 行：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| workspace | process.cwd() | 请求未指定工作区时报告的默认目录 |
| leaseMs | 30000 | 心跳租约；过期会释放 client 持有的全部进程句柄 |
| maxProcesses | 128 | prepare 或运行中的进程句柄上限 |
| exitOnClose | true | flush close 响应后退出 |
| serverId | 自动生成 | identityFile 为空时使用的稳定身份 |
| installationId | 自动生成 | 多实例发现身份 |
| identityFile | 空 | 持久化 serverId 的文件，升级时必须保持 |
| workspaceIndex | 空 | 独立工作区清单；存在官方 registry 时忽略 |
| statusFile | 空 | 发现清单路径，通常由 client 设置 |
| version | 包版本 | 在 server.hello 和 status.json 中报告的版本 |

修改 serverId 会改变所有派生的工作区 id，升级时不要轮换。

## 协议范围

server 支持官方 DSH 执行世界 RPC，以及 Remote Session 协议第 3 版。

Remote Session 方法：

    server.hello
    reg.list       reg.create       reg.rename       reg.delete
    persist.list   persist.titles   persist.rename
    persist.create persist.open     persist.append
    persist.flush  persist.close    persist.locate

会话写入使用官方持久化句柄和租约，不另建锁文件或会话格式。句柄只在进程内存中，server 重启后会
消失；client 收到 unknown-handle 时会自动重新打开一次。

## 运行行为

- 目标机 server 是工作区路径、标题和会话日志的权威。
- 工作区 id 由稳定 server 身份和规范化远端路径计算。
- 重命名工作区只改标题，不移动目录。
- 移除工作区只移除清单条目，磁盘上的会话日志保留。
- 远端 profile 不挂载 title projection，因此标题从日志中最后一个 session/title 事件读取。
- 没有可用沙箱 backend 时，server 返回官方 facts 对象，enforcement 为 partial，并在远端执行 argv。
- 所有请求在 wire 边界校验。未知流的控制帧可作为迟到消息忽略，未知流的 DATA 是致命错误。

## 排障

| 症状 | 检查 |
| --- | --- |
| client 报 incompatible-version | 两个仓库都匹配 DSH 0.2.1-rc.2。 |
| 进程立即退出 | 检查 profile patch 是否挂载 JSONL 后端和 server 行。 |
| 重启后报 session "..." not found | 句柄只在内存中，使用 client 重新打开会话。 |
| 空闲一段时间后命令停止 | 心跳租约过期，保持 client 连接。 |
| 没有 status.json | statusFile 为空，或进程已经退出。 |
| 协议输出损坏 | stdout 只能输出 RPC，日志写 stderr。 |
| 沙箱提示没有 backend | 检查返回的 facts 对象；没有 bubblewrap/Landlock 时 partial enforcement 是预期行为。 |

## 兼容性与发布

当前包只针对 DSH 0.2.1-rc.2 验证。运行时包从本仓库以 server-v0.2.1-rc.2 之类的 tag
发布，每个 release 包含：

    dsh-remote-server-<dshVersion>-<platform>-<arch>[-<libc>].tar.gz
    <same-name>.tar.gz.sha256
    <same-name>.manifest.json

发布矩阵为 linux-x64-gnu、linux-arm64-gnu、darwin-x64、darwin-arm64。client 在缓存或上传前会
校验 sha256。

## 开发

修改共享协议或 server 代码前请阅读 AGENTS.md。client 仓库必须保留
src/protocol.ts、src/server/**、src/frame/** 和 src/provision/package-build.ts 的逐字节副本。
AGENTS.md 记录比对命令、测试和 tag 流程。

## License

MIT
