# Self-Hosted Runner Isolation（2026-08-12，MIGRATED — SECURITY BLOCKER: CLOSED）

> 范围：`Leo-Ayh-Oday/orcana-runtime` 的 self-hosted runner 主机隔离审计与迁移。
> 背景：PUBLIC 仓库 + 持久化 self-hosted runner。即使 workflow 只跑可信 `main`，
> `actions/checkout`、setup action、依赖安装本身仍构成供应链执行面，runner
> 进程的权限边界就是 CI 的信任边界。
>
> 状态：**审计（Before migration）→ 迁移执行 → 复验（After migration）→ CLOSED**。
> 本文保留迁移前审计记录，便于对照验证风险确实被关闭。

## Before migration（2026-08-12 审计）

| 项 | 现状 | 风险 |
|---|---|---|
| 运行用户 | 个人用户 `fuqiang`（uid 1000） | **HIGH** |
| systemd 服务 | `actions.runner.Leo-Ayh-Oday-orcana-runtime.orcana-linux-runtime`（system service，`User=fuqiang`） | 服务环境即用户环境 |
| 可读敏感路径 | `~/.ssh`、`~/.orcana`（API key，0600）、`~/.aws`、`~/projects/*`（私人项目） | **HIGH**：被投毒的 job 可窃取密钥与私人代码 |
| Runner 工作区 | `/home/fuqiang/actions-runner/_work` | job 文件与用户文件同树 |
| `.env` 注入 | `XDG_RUNTIME_DIR`、`DBUS_SESSION_BUS_ADDRESS`、代理 | 修复 cgroup delegation 所需，迁移后必须保留 |
| 触发边界 | 仅 `push → main` + `workflow_dispatch`；无 `pull_request` | 已正确，保持 |
| token 权限 | `contents: read`；checkout `persist-credentials: false` | 已正确，保持 |
| 第三方 Action | 已 pin 到 commit SHA | 已收口 |

**当时结论：SECURITY BLOCKER。** runner 以个人用户身份运行，等于把个人密钥库
（SSH / API keys / AWS）暴露给任何能投毒可信 main 的依赖或 Action。

## Migration executed（2026-08-12）

脚本：`scripts/ci/runner-isolation-migrate.sh`（幂等，`wsl -u root` 执行），内容：

1. 创建 `github-runner` 用户（`--system` 语义，`nologin` shell）
2. `loginctl enable-linger github-runner`（user manager 常驻 → `systemctl --user` 可用）
3. 迁移 `/home/fuqiang/actions-runner` → `/home/github-runner/actions-runner`（保留 `.env`、`.credentials`、`.runner`）
4. 卸载旧 systemd 服务，以 `github-runner` 重新安装（`svc.sh`）
5. 校验：服务 active + `systemctl --user show-environment` 成功
6. 输出人工复核清单

迁移后排雷（真实 CI 验证驱动，记录于 PR #28/#29/#30/#31）：

- 补 `/etc/subuid` `/etc/subgid`：`github-runner:165536:65536`（`useradd --system` 不创建）
- `.env` 的 `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` 指向 `/run/user/999`（uid 随用户变化）
- github-runner 全局 git 配置（`init.defaultBranch=main`、user.name/email）
- 清理旧用户 `/tmp/orcana-execd` 残留（新用户 mkdir EACCES）
- `/usr/local/bin/bun` 为复制二进制（符号链接会被 `/home/fuqiang` 750 拦截）
- 真实 podman/doctor 探测测试提高超时（doctor 30s、podman 60s）
- lane Cleanup 的 catatonit 检查限定 runner uid（`pgrep -u "$(id -u)"`）

## After migration（复验状态）

| 项 | 状态 |
|---|---|
| Runner user | `github-runner`（uid 999，nologin，无密码） |
| Runner home | `/home/github-runner/actions-runner` |
| Service user | `github-runner`（systemd `User=` 已确认） |
| `fuqiang ~/.ssh` | 不可达（`/home/fuqiang` 750；`~/.ssh` 700） |
| `fuqiang ~/.orcana` | 不可达（`/home/fuqiang` 750；`~/.orcana` 700） |
| `fuqiang ~/.aws` | 不可达（`/home/fuqiang` 750；目标为 Windows drvfs 空目录） |
| 私人项目目录 | 不可达（`/home/fuqiang` 750 阻断遍历） |
| External fork PR execution | 禁用（仅 `push → main` + `workflow_dispatch`） |
| Actions pinned to SHA | 是（checkout / setup-bun / setup-node / Pages 全部固定 commit SHA） |
| `contents` permission | `read` |
| `persist-credentials` | `false` |
| cgroup delegation | verified（eval-linux lane 绿） |
| bubblewrap | verified（lane-bubblewrap 绿） |
| rootless podman | verified（lane-podman 绿，含 catatonit 卫生检查） |
| Landlock | 不可用（当前 WSL2 kernel；`docs/linux-foundation/current-status.md` 已如实标注，不得宣称强制） |

**SECURITY BLOCKER: CLOSED（2026-08-12，CI + Linux Sandbox Lanes 全绿复验）。**

## Post-migration verification checklist

- [x] `systemctl status actions.runner.Leo-Ayh-Oday-orcana-runtime.orcana-linux-runtime` 显示 `User=github-runner`
- [x] `github-runner` 的 `systemctl --user` 可用（eval-linux lane 不再报 CGROUP_DELEGATION_REQUIRED）
- [x] `/home/fuqiang` 750；`~/.ssh`、`~/.orcana` 均 700
- [x] `workflow_dispatch` CI + Linux Sandbox Lanes 全绿（迁移后多次复验）
- [x] `_work` 目录无历史敏感文件残留（随迁移整体搬迁，属主已改）

## 遗留与纵深（非阻塞）

- 旧 `/home/fuqiang/actions-runner` 目录在确认无并发 job 后由 root 删除
- 独立 WSL 发行版仅承载 runner（网络、文件系统双隔离）——可选
- 轻量 VM（libvirt/QEMU）承载 runner，宿主机零写入——可选
