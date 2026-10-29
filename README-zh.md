# dsh-remote-window-server

[English](README.md) | 中文

本仓库是 [dsh-remote-window](https://github.com/graydovee/dsh-remote-window) 的远端部分。
它是安装到 per-client DSH profile 里的普通 DeepSeek Harness 插件，**不使用 stdio**，也不监听公网
端口：client 通过一条 SSH 连接访问一个只绑 loopback 的 DSH web 服务。

## 兼容性

| Server 插件 | 已验证 DSH 运行时 | 状态 |
| --- | --- | --- |
| 0.1.0-alpha.3 | 0.2.1-rc.3 | verified |

`engines.dsh` 和全部 `@deepseek-ai/dsh-*` peer 都精确钉在该运行时。包 manifest 记录
`dshVersion: 0.2.1-rc.3`；未验证运行时会由 client 直接拒绝，而不是跑到一半失败。本版本不再默认接受
`0.2.1-rc.2`。

## 各自负责什么

- **client host**：SSH 凭据、远程连接 UI、client native 对话主区，以及 local 模式的 agent/模型。
- **server profile**：一个带本插件的普通 `dsh web` 进程。官方 workspace registry、session
  controller、JSONL 会话日志，以及文件/子进程/沙箱执行世界都由它负责。
- **执行端**：`local` 把 agent/模型放在 client，文件、进程、日志仍在 server；`server` 把
  agent/模型和官方会话运行放在 server。执行端按会话记录，两种模式共享同一份 server workspace
  与 session 日志。

v2 的 server 对话由 client 原生渲染；v1 的 embed/portal 路由只作为回退保留，不在正常 v2 流程中。

## 如何部署

大多数用户不需要直接安装本仓库。client 包内置精确同版本的
`dsh-remote-window-server-<client-version>.tgz`，首次连接时：

1. 在目标机上传/复用兼容的 Node + DSH 运行时；
2. 创建 `~/.dsh/profiles/graydovee-remote-window-<clientId>/` 及四个 profile 文件；
3. 离线解包本 tarball 到 profile 的 `node_modules/dsh-remote-window-server/`；
4. 写入版本/sha marker 并启动 profile。

profile 以只绑 loopback 的 web server 启动：

```sh
DSH_HOME="$HOME" \
PATH="$HOME/.dsh/remote-window/<clientId>/runtime/node/bin:$PATH" \
exec <dsh> --profile graydovee-remote-window-<clientId> \
  --host 127.0.0.1 --port 0 --no-open
```

进程在 stdout 打印 `dsh web: http://127.0.0.1:<port>/?token=<token>`。client 解析这一行，把 token
只留在 host 内存，并通过 SSH `forwardOut` 隧道访问该端口。不要把 profile 端口或 token 暴露到网络。

每个 client profile 有单写者租约（`.dsh-rw/lease.json`，20 s TTL）。第二个实例得到
`profile-in-use`；别的 client 得到 `profile-foreign-client`；stale 租约可以接管。client 断开时会
取消该 profile 的 active turn、flush 官方 JSONL 日志、停止 profile 进程并关闭隧道。

## 构建与打包

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm pack:server-plugin
```

打包脚本输出 `dist/server-plugin/dsh-remote-window-server-<version>.tgz`、对应 `.sha256`，以及
包含协议、feature 列表、`dshVersion`、字节长度和校验和的 `.manifest.json`。client 仓库内置该
tarball，并把校验和写入 `assets/server-plugin/checksums.json`；两个仓库必须使用同一发布版本和同一
DSH 运行时钉版。

手工搭建 profile 只用于协议调试。正常部署应使用 client provisioner，以保证 profile 文件、marker、
运行时和租约一致。

## 数据位置

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/profiles/graydovee-remote-window-<clientId>/` | per-client profile、插件、profile 文件和 `.dsh-rw/lease.json` |
| `~/.dsh/remote-window/profiles/graydovee-remote-window-<clientId>/` | `server.log`（0600）与 `server.pid` |
| `~/.dsh/sessions/**` | 权威的官方 JSONL 会话日志（两种执行端共用） |
| `~/.dsh/storages/workspace.json` | 权威的官方 workspace registry |
| `~/.dsh/remote-window/state/`、`locks/` | executor 记录与 bootstrap 锁 |
| `~/.dsh/remote-window/<clientId>/runtime/` | 可选的独立 DSH 运行时 |

已退役的 `remote-server-sessions/` 目录保持不动，v2 不读取它。

## 排障

| 症状 | 含义 |
| --- | --- |
| `incompatible-version` | client/server 运行时不在已验证集合；安装 DSH `0.2.1-rc.3`，或在 client 上显式豁免该精确版本。 |
| `profile-in-use` | 另一个存活实例持有该 client profile 的租约。关闭另一实例，或等待 20 s TTL 过期。 |
| `profile-foreign-client` | profile 属于另一个 `clientId`，不要复用。 |
| `plugin-profile-not-managed` | client 拒绝修改不是它 provisioning 的 profile。 |
| `session/writer-held` | 另一个 agent 正持有官方 JSONL 写者租约。 |
| `shutdown-flush-timeout` | cancel/flush 超过 3 s 关停预算；检查 `server.log`。 |

## 历史遗留

stdio 传输、独立 server 进程、`status.json` 发现清单、Remote Session 协议 v3 和 `dist-runtime/`
包都属于 v1 架构，只作为历史发布产物保留，当前 client 不再使用。不要在其上开发新功能。
