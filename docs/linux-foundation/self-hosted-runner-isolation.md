# Self-Hosted Runner Isolation Audit（2026-08-12）

> 范围：`Leo-Ayh-Oday/orcana-runtime` 的 self-hosted runner 主机隔离审计与迁移方案。
> 背景：PUBLIC 仓库 + 持久化 self-hosted runner。即使 workflow 只跑可信 `main`，
> `actions/checkout`、setup action、依赖安装本身仍构成供应链执行面，runner
> 进程的权限边界就是 CI 的信任边界。

## 现状（Audit）

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

**结论：SECURITY BLOCKER。** runner 以个人用户身份运行，等于把个人密钥库
（SSH / API keys / AWS）暴露给任何能投毒可信 main 的依赖或 Action。

## 目标状态

- 专用用户 `github-runner`（无登录 shell、无密码、家目录独立）
- Runner 目录迁移到 `/home/github-runner/actions-runner`
- systemd 服务以 `github-runner` 运行；`loginctl enable-linger` 使其拥有
  user manager（cgroup delegation 依赖）
- 私人目录权限收紧（`fuqiang` 700 化），runner 用户无访问路径
- 保留：`.env` 注入（`XDG_RUNTIME_DIR` + DBUS 地址随 uid 变化）、代理、触发边界

## 迁移步骤（需 root，Windows 侧执行）

```powershell
wsl -u root -d Ubuntu -- bash /home/fuqiang/projects/orcana-oss-hardening/scripts/ci/runner-isolation-migrate.sh
```

脚本为幂等设计，包含：

1. 创建 `github-runner` 用户（`--system` 语义，`nologin` shell）
2. `loginctl enable-linger github-runner`（user manager 常驻 → `systemctl --user` 可用）
3. 迁移 `/home/fuqiang/actions-runner` → `/home/github-runner/actions-runner`（保留 `.env`、`.credentials`、`.runner`）
4. 卸载旧 systemd 服务，以 `github-runner` 重新安装（`svc.sh`）
5. 校验：服务 active + `su -s /bin/bash github-runner -c 'systemctl --user show-environment'` 成功
6. 输出迁移后需人工复核的清单（token 失效检查、`_work` 清理、私密目录 700 复核）

> 注意：迁移后旧 `Runner.Listener` 若仍持有旧 token，需在服务重启前确认
> 无并发 job；runner 注册 token 有效期短，通常无需重新注册（`.credentials`
> 随目录整体迁移）。

## 迁移后复核清单

- [ ] `systemctl status actions.runner.Leo-Ayh-Oday-orcana-runtime.orcana-linux-runtime` 显示 `User=github-runner`
- [ ] `github-runner` 的 `systemctl --user` 可用（eval-linux lane 不再报 CGROUP_DELEGATION_REQUIRED）
- [ ] `~/.ssh`、`~/.orcana`、`~/.aws` 均 700 且 owner 为 `fuqiang`
- [ ] 手动 `workflow_dispatch` CI + Linux Sandbox Lanes 全绿
- [ ] `_work` 目录无历史敏感文件残留

## 纵深（可选，非本 PR 范围）

- 独立 WSL 发行版仅承载 runner（网络、文件系统双隔离）
- 或轻量 VM（libvirt/QEMU）承载 runner，宿主机零写入
