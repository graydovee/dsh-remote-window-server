# dsh-remote-workspace-server

[English](README.md) | 中文

[dsh-remote-workspace](https://github.com/graydovee/dsh-remote-workspace) 的 server 半边。它运行
在 SSH 主机上的 DeepSeek Harness 运行时里，为那台主机提供文件系统、shell、进程与会话存储。
正常情况不需要手动安装：client 会部署运行时、上传本包并通过 stdio 启动它。

只有当你需要手动部署或排查一台远端主机时才需要读这份文件。方法表、内部不变量与发布规则在
[AGENTS.md](AGENTS.md)。

## Requirements

| 位置 | 需要 |
| --- | --- |
| 远端主机 | POSIX：`/bin/sh`、`tar`、`chmod`、可写 `$HOME` |
| 运行时 | DeepSeek Harness `0.2.1-rc.2` 加一份 Node 发行版，都放在 `~/.dsh/server` |
| 主机上的 Node | 不需要——部署的 Node 运行部署的 dsh |

## Run it by hand

下面就是 client 自动执行的步骤，顺序一致。

1. 为目标平台暂存运行时包（需要一台装有 Node 与 pnpm 的机器）：

   ```bash
   node scripts/build-server-package.mjs --platform linux --arch x64 --libc gnu --out dist-server
   ```

2. 把 tarball 解到 `~/.dsh/server/dsh`，Node 发行版解到 `~/.dsh/server/node`。
3. 建 profile `~/.dsh/profiles/dsh-remote-server/`，含 `package.json`、`cordis.yml`、
   `cordis.patch.yml` 与 `pnpm-workspace.yaml`，并把本包放到
   `node_modules/dsh-remote-workspace/`。这些文件由 client 生成——从它部署过的主机拷过来，
   不要从零手写。
4. 在 stdio 上启动：

   ```bash
   DSH_HOME="$HOME" \
   PATH="$HOME/.dsh/server/node/bin:$HOME/.dsh/server/dsh/node_modules/.bin:$PATH" \
   exec "$HOME/.dsh/server/dsh/node_modules/.bin/dsh" --profile dsh-remote-server
   ```

不监听任何端口：进程在 stdin/stdout 上说话。成功时会写
`~/.dsh/remote-server/status.json`（0600），含 `serverId`、`installationId`、`version`、
`protocol`、`transport: 'stdio'` 与 `pid`。

## Configuration

client 会把这些写进 profile 的 `cordis.patch.yml` 里 `remote-workspace-server` 那一行。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `workspace` | `process.cwd()` | client 未指定时报告的 workspace |
| `leaseMs` | `30000` | client 租约（毫秒）；过期即释放本 server 持有的全部进程 |
| `maxProcesses` | `128` | 可 prepare / 运行中的进程上限 |
| `exitOnClose` | `true` | 收到 `close` 后退出 |
| `serverId` | 自动生成 | 稳定身份，是每个 workspace id 的组成部分——绝不能改 |
| `installationId` | 自动生成 | 多实例发现用的安装身份 |
| `identityFile` | 空 | 持久化 `serverId` 的文件 |
| `workspaceIndex` | 空 | 独立工作区清单；存在 shell 注册表时忽略 |
| `statusFile` | 空 | 发现清单路径 |
| `version` | 包版本 | 由 `server.hello` 与 `status.json` 报告 |

## Troubleshooting

| 症状 | 处理 |
| --- | --- |
| client 报连接失败、插件行被拒 | 运行时不是 `0.2.1-rc.2`；部署匹配的版本，或看 [Compatibility](#compatibility) |
| 进程立刻退出、没有任何输出 | profile 的 patch 层没挂官方 JSONL 后端，没有东西提供 `sessionPersistence` |
| 重启后 `session "…" not found` | 句柄表在内存里；重新打开会话（client 会自动重试一次） |
| 空闲时命令被杀 | client 停了心跳、租约过期；保持连接 |
| `status.json` 不存在 | 没配置 `statusFile`，或进程已经退出 |
| `process.done` 输出像乱码 | 收集到的 stdout 尾部是 base64，解码后再看 |

## Compatibility

本插件只支持**一个** DeepSeek Harness 版本：**`0.2.1-rc.2`**（`engines.dsh`），其它版本会在
安装与加载阶段被拒。确实想试：

```bash
dsh plugin --profile <profile> allow-version dsh-remote-workspace-server@<已安装版本> \
  --dsh-version <你的 DSH 版本> --accept-risk
```

运行时包按 DSH 版本发布，tag 为 `server-v<dsh 版本>`，覆盖 `linux-x64`、`linux-arm64`、
`darwin-x64`、`darwin-arm64`。没有 Windows 包：远端一侧是 POSIX，Windows 主机只能作为 client
侧的 WSL 目标。

## Contributing

要改这个仓库，请先读 [AGENTS.md](AGENTS.md)：方法表、与 client 的同步契约、硬约束与发布流程
都在那里。使用者不需要它。

## License

MIT
