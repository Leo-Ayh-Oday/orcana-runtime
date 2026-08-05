# Orcana Linux 原生执行底座 — 安全模型（LNXF-1.0）

## 1. 威胁模型

底座防护的威胁（按多 Agent 与长任务放大效应排序）：

| 威胁 | 示例 | 防线 |
|---|---|---|
| 凭证窃取 | 读取 ~/.ssh、~/.gnupg、~/.aws、auth.json | 空 Home + 隐藏路径 + 显式环境 |
| 容器/云边接口滥用 | Docker/Podman Socket、KUBECONFIG | Socket 永不挂载 + 默认拒绝 env |
| 宿主进程探测/影响 | /proc 泄漏、ptrace、信号注入 | 新 PID namespace + 独立 /proc |
| 网络滥用 | 外联 C2、本地服务扫描 | 网络 namespace + 默认 none |
| 资源耗尽 | fork bomb、内存炸弹、无限写盘 | cgroup v2 pids/memory/tmpfs 限额 |
| 逃逸写入 | ../、symlink、绝对路径 | 挂载白名单 + MountRule 校验 + 只读根 |
| 后台逃逸 | daemon 脱离执行树 | --die-with-parent + 新会话 + cgroup 归属 |
| 跨 Agent 污染 | A 改 B 的 Worktree/缓存 | Isolation-Domain Lock + 所有权 |
| 自进化越权 | 实验修改正式运行时 | evolution Profile + 独立 Run + 人工批准 |

## 2. 分层防线（纵深防御）

```
第 1 层：策略编译    Policy Compiler 是唯一正式 ExecutionCellSpec 入口
第 2 层：隔离后端    Podman(严格) > Bubblewrap(快速) > HostAudit(仅降级)
第 3 层：内核机制    namespaces + cgroup v2 + Landlock(可选) + seccomp(组合)
第 4 层：审计        SandboxReceipt → Trace / Evidence / 完成门
```

定位明确：**Landlock/seccomp 是组合机制，不是完整沙盒**（Linux 内核文档立场）；**Host Audit 是宿主审计后端，不是安全边界**（不得宣传）。

## 3. 隔离强度定义

| 等级 | 定义 | 满足者 |
|---|---|---|
| `audit` | 环境过滤 + 超时 + 进程组 + 事后 PathGuard | HostAuditBackend |
| `namespace` | 独立 user/mount/pid/ipc/uts/net + 空 Home + 只读根 + tmpfs | Bubblewrap |
| `container` | 独立根文件系统 + 镜像 digest 锁定 + 资源限制 | Rootless Podman |

严格性约束：`minimum` 声明为 `namespace`/`container` 的 Profile（untrusted/evolution）在后端不可用时**拒绝**（`ISOLATION_REQUIREMENT_UNMET`、`DEGRADATION_NOT_ALLOWED`）。

## 4. 环境与凭证

- 环境构造链：空对象 → Runtime 固定安全变量 → Profile 允许 → Tool 显式申请 → Secret Broker 注入 → 策略校验 → 冻结。
- 默认注入：`PATH`、`HOME=/home/orcana`、`TMPDIR=/tmp`、`LANG`、`LC_ALL`、`NODE_ENV`、`ORCANA_RUN_ID`、`ORCANA_NODE_RUN_ID`、`ORCANA_SANDBOX=1`。
- 默认拒绝：`*_API_KEY`、`*_TOKEN`、`AWS_*`、`GITHUB_TOKEN`、`SSH_AUTH_SOCK`、`DOCKER_HOST`、`KUBECONFIG`、`DATABASE_URL`、HTTP(S)_PROXY（除非显式批准）。
- SecretBinding 默认交付：file descriptor 或 `/run/secrets` 只读临时文件；仅外部程序确实要求时才用环境变量；`redactFromTrace: true`。

## 5. 网络

- `none`：新网络 namespace，无外部连接（默认）。
- `loopback`：仅 Cell/Domain 内本地服务；宿主端口须 PortLease 批准，绑定限 `127.0.0.1`，禁止 `0.0.0.0`。
- `full-approved`：显式人工批准，进 Receipt。
- `proxy-allowlist`（后续增强）：Cell 无直接外网，仅经 Orcana Egress Proxy，逐跳复查 DNS/重定向/非 HTTP。禁止简单依赖 DNS 预解析。

## 6. 资源

- cgroup v2 三级层级；`memory.oom.group=1` 保证整 Cell 同生共死。
- 调度：原子预留成功才启动（`waiting_resources`），禁止先启动再观察 OOM。
- 宿主保留：CPU 1 核或 15%、内存 1GB 或 20%（取较大者），可配置。
- 无 cgroup 委托 → 资源隔离标记降级；严格 Profile 拒绝。

## 7. 取消与恢复

- 取消层级：Cell/Agent/Run → 对应 cgroup `cgroup.kill`（树级，处理并发 fork）。
- 崩溃恢复：Boot ID + 扫描未关闭 Run → cgroup/父进程/容器 Label/Worktree/端口租约 → 只清理确认属于旧 Run 的资源（禁止按 PID 猜）→ Recovery Receipt。
- Retain on Failure：可保留 Worktree/Receipt/日志/Spec，但进程必须归零、网络关闭、挂载卸载、cgroup 移除、Secret 删除。

## 8. 安全验收指标（冻结）

宿主凭证可见 0 / 真实 Home 可见路径 0 / none 模式外网连接 0 / 未授权项目外写入 0 / 未授权 Socket 挂载 0 / 严格任务静默降级 0 / 取消后遗留进程 0 / 跨 Agent Worktree 修改 0 / 直接 spawn 旁路 0 / 进化实验正式工作区写入 0 / 无 Receipt 执行 0 / 无 Receipt 完成声明 0。
