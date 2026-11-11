# dsh-remote-workspace-server

[English](README.md) | 中文

本仓库是 [dsh-remote-workspace](https://github.com/graydovee/dsh-remote-workspace) 的远端部分。
它是安装到 per-client DSH profile 里的普通 DeepSeek Harness 插件，**不使用 stdio**，也不监听公网
端口：client 通过一条 SSH 连接访问一个只绑 loopback 的 DSH web 服务。

## 兼容性

| Server 插件 | 已验证 DSH 运行时 | 状态 |
| --- | --- | --- |
| 0.1.0-alpha.3 | 0.2.1-rc.3 | verified |
| 0.1.0-alpha.4 | >= 0.2.1-rc.2 <= 0.2.1-rc.5 | verified automatically |
| 0.1.0-alpha.5 | >= 0.2.1-rc.2 <= 0.2.1-rc.5 | verified automatically |
| 0.1.0-alpha.6 | >= 0.2.1-rc.2 <= 0.2.2-rc.1 | 0.2.2-rc.1 上自动验证通过；真机验证待跑 |
| 0.1.0-alpha.7 | >= 0.2.1-rc.2 <= 0.2.2-rc.1 | 0.2.2-rc.1 上自动验证通过；真机验证待跑 |
| 0.1.0-alpha.8 | >= 0.2.1-rc.2 <= 0.2.2-rc.1 | 0.2.2-rc.1 上自动验证通过；真机验证待跑 |

`engines.dsh` 和全部 `@deepseek-ai/dsh-*` peer 写同一区间，本仓安装与测试的包钉区间内最新版本
`0.2.2-rc.1`（包 manifest 记录 `dshVersion`）。区间外的运行时会由 client 直接拒绝，而不是跑到一半失败。

## 各自负责什么

- **client host**：SSH 凭据、远程连接 UI、client native 对话主区，以及 local 模式的 agent/模型。
- **server profile**：一个带本插件的普通 `dsh web` 进程。官方 workspace registry、session
  controller、JSONL 会话日志，以及文件/子进程/沙箱执行世界都由它负责。
- **执行端**：`local` 把 agent/模型放在 client，文件、进程、日志仍在 server；`server` 把
  agent/模型和官方会话运行放在 server。执行端按会话记录，两种模式共享同一份 server workspace
  与 session 日志。

v2 的 server 对话由 client 原生渲染；v1 的 embed/portal 路由只作为回退保留，不在正常 v2 流程中。

## server UI 里的「远程连接」

profile 自己的 DSH UI 里有一条「远程连接」导航行（`sidebar.panellist`，`id: dsh-remote-workspace`，
`order: 100`，排在「自动化任务」之后）和它打开的一页（`main`，同一个 key）。两者都是本插件浏览器半（`lib/client.js`）的声明式槽位
贡献，所以不管 UI 是在目标机上直接打开、还是被 client 全屏 iframe 嵌入都可见。

- 列表归 client 所有：client host 用 P1 `client/targets` 发布脱敏快照，本插件只在内存里保存
  （`updatedAt` 单调、最多 64 行、lease 释放时清空）；浏览器半每 2 s 用 profile 相对路径
  `dsh-remote-workspace-server/api/client/targets` 读取一次，并在 `visibilitychange`/`focus` 时立即刷新。
  该读取只过 `ctx.connection.admit`，不要求 lease 头。
- 每行显示连接别名、`user@host:port`（WSL 显示发行版）、阶段文案和状态点；iframe 的 `dshRwTarget`
  查询参数（缺失时用快照的 `activeTargetId`）指向的行高亮。
- 点行向父窗口发 `dsh-rw/switch-target`，由 client 切换连接并重挂 iframe；「新建连接」发
  `dsh-rw/open-connect-dialog`；「返回本地」发 `dsh-rw/close-portal`。在目标机上直接打开时没有 client
  页面可执行命令，列表以只读方式显示并给出提示。
- 浏览器半随 tarball 发布（`lib/client.js`、`exports['./client']`、`dsh.client`）。用旧 tarball 装过的
  profile 不会出现该行；重装插件并重启 profile server 后生效。

## 如何部署

大多数用户不需要直接安装本仓库。client 包内置精确同版本的
`dsh-remote-workspace-server-<client-version>.tgz`，首次连接时：

1. 在目标机上传/复用兼容的 Node + DSH 运行时；
2. 创建 `~/.dsh/profiles/graydovee-remote-workspace-<clientId>/` 及四个 profile 文件；
3. 离线解包本 tarball 到 profile 的 `node_modules/dsh-remote-workspace-server/`；
4. 写入版本/sha marker 并启动 profile。

profile 以只绑 loopback 的 web server 启动：

```sh
DSH_HOME="$HOME" \
PATH="$HOME/.dsh/remote-workspace/<clientId>/runtime/node/bin:$PATH" \
exec <dsh> --profile graydovee-remote-workspace-<clientId> \
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
pnpm build
pnpm pack:server-plugin
```

`pnpm build` 依次跑三个 tsdown 配置，产出 `lib/plugin.js`（host 插件）、`lib/protocol.js`（共享 wire
类型）和 `lib/client.js`（浏览器半，即上面那行与那一页）。构建后若 `lib/client.js` 里没有
`__ModuleLoader__.load`，profile 的 UI 就没有连接列表，不要打包发布。

打包脚本输出 `dist/server-plugin/dsh-remote-workspace-server-<version>.tgz`、对应 `.sha256`，以及
包含协议、feature 列表、`dshVersion`、字节长度和校验和的 `.manifest.json`。client 仓库内置该
tarball，并把校验和写入 `assets/server-plugin/checksums.json`；两个仓库必须使用同一发布版本和同一
DSH 运行时钉版。

手工搭建 profile 只用于协议调试。正常部署应使用 client provisioner，以保证 profile 文件、marker、
运行时和租约一致。

## 数据位置

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/profiles/graydovee-remote-workspace-<clientId>/` | per-client profile、插件、profile 文件和 `.dsh-rw/lease.json` |
| `~/.dsh/remote-workspace/profiles/graydovee-remote-workspace-<clientId>/` | `server.log`（0600）与 `server.pid` |
| `~/.dsh/sessions/**` | 权威的官方 JSONL 会话日志（两种执行端共用） |
| `~/.dsh/storages/workspace.json` | 权威的官方 workspace registry |
| `~/.dsh/remote-workspace/state/`、`locks/` | executor 记录与 bootstrap 锁 |
| `~/.dsh/remote-workspace/<clientId>/runtime/` | 可选的独立 DSH 运行时 |

已退役的 `remote-server-sessions/` 目录保持不动，v2 不读取它。

## 排障

| 症状 | 含义 |
| --- | --- |
| `incompatible-version` | client/server 运行时不在已验证集合；安装区间内的 DSH（`0.2.1-rc.2 … 0.2.2-rc.1`），或在 client 上显式豁免该精确版本。 |
| `profile-in-use` | 另一个存活实例持有该 client profile 的租约。关闭另一实例，或等待 20 s TTL 过期。 |
| `profile-foreign-client` | profile 属于另一个 `clientId`，不要复用。 |
| `plugin-profile-not-managed` | client 拒绝修改不是它 provisioning 的 profile。 |
| `session/writer-held` | 另一个 agent 正持有官方 JSONL 写者租约。 |
| `shutdown-flush-timeout` | cancel/flush 超过 3 s 关停预算；检查 `server.log`。 |

## 历史遗留

stdio 传输、独立 server 进程、`status.json` 发现清单、Remote Session 协议 v3 和 `dist-runtime/`
包都属于 v1 架构，只作为历史发布产物保留，当前 client 不再使用。不要在其上开发新功能。
