# Orcana Linux 沙盒当前状态与降级矩阵

状态日期：2026-08-10
源码快照：`fix/gate-control-plane` @ `76a90ef143d97b0b0466cc118d511a3ea1f78323`

本文是 Linux 执行边界的当前入口。历史计划和阶段记录保留其历史身份；当它们与本文、当前源码、真实后端运行或单次 `SandboxReceipt` 冲突时，以后者为准。

## 1. 结论

Orcana 已经实现 Linux `ProcessExecutor → LinuxExecutionBroker → Backend` 的生产短进程路径，并提供 Host Audit、Bubblewrap 和 Rootless Podman 三种后端。Linux 不能再整体描述为“只有环境过滤和超时”，但也不能整体描述为“强沙盒已完成”。隔离强度取决于本次运行实际选择并成功执行的后端、cgroup 委托、网络策略、清理验证和 Receipt；源码中存在某个后端或单元测试通过，不等于该次运行获得了相应边界。

硬性解释规则：

- `host-audit` 永远是降级审计路径，不是安全边界。
- Bubblewrap/Podman 只有在真实后端 lane 执行且 Receipt 无相关降级时，才能证明该次运行的 namespace/container 边界。
- 严格 Profile 缺少所需后端时必须拒绝；不能回退宿主执行。
- cgroup 不可用、未委托、attach 未验证或 cleanup 未验证时，不得声称资源限制或进程树清理已强制执行。
- Landlock 在当前 WSL2 主机不可用，且当前源码只有规则编译/探测接口，没有生产执行接线；不得宣称 Landlock 已强制。
- GitHub-hosted Linux lanes 当前被账号 billing lock 阻止在 0 steps；这不是代码失败，也不是远程真机通过证据。

## 2. 版本与发布状态

| 渠道 | 版本 | 状态 |
|---|---:|---|
| npm `latest` | `0.8.16` | 当前公开包 |
| GitHub Latest Release | `v0.8.16` | 当前公开 Release/tag |
| `origin/main` 源码 | `0.8.26.2` | 未发布到 npm/Release（RC-18 汇合基线 `fe913ed`） |
| 当前修复线源码 | `0.8.26.3` | 未发布候选（生产收口线，R2-0 + PR-E1）；不能当作公开版本 |

权威版本表：`SECURITY.md` Version Channels。

仓库没有自动 npm/GitHub Release 工作流。`package.json` 版本变化不会自动发布；发布必须从干净、验收完成且明确授权的提交执行。

## 3. 执行路径

| 路径 | 当前实现 | 可声明边界 |
|---|---|---|
| Linux 短进程工具 | `ProcessExecutor → LinuxExecutionBroker(mode=enabled) → Backend` | 以该次 Receipt 为准 |
| Host Audit | 显式环境、超时、进程组、事后 PathGuard、Receipt | 只能声明审计/降级，不能声明文件系统或网络隔离 |
| Bubblewrap | user/mount/PID/IPC/UTS/network namespace、只读系统根、空 Home、工作区挂载、seccomp FD（能力可用时） | 可声明 namespace 边界；资源边界仍要求真实 cgroup 委托和 attach 验证 |
| Rootless Podman | digest 审批、只读容器、显式挂载、`--network=none`、cap-drop、no-new-privileges、OCI seccomp（能力可用时） | 可声明 container 边界；仍共享宿主内核，不等于 VM |
| service/MCP/LSP | `ServiceCell` 直接 `spawn(shell:false)`，显式环境与可选 durable lease | 尚未进入 Broker/cgroup；不能继承普通 Cell 的强隔离声明 |
| sync/系统工具遗留路径 | `legacy-process` 和受控 runtime allowlist | 不是统一 Broker 闭环；仅能按调用点具体声明 |

## 4. Profile 降级语义

| Profile | 默认后端/最低隔离 | 允许降级 | 当前裁决 |
|---|---|---:|---|
| `inspect` | Bubblewrap / namespace | 是 | 后端缺失时可显式降级到 Host Audit；Receipt 必须带降级原因 |
| `build` | Bubblewrap / namespace | 是 | 同上；不适用于不可信构建脚本 |
| `test` | Bubblewrap / namespace | 否 | Bubblewrap 不可用时拒绝 |
| `dependency` | Podman / container | 否 | 默认 `proxy-allowlist` 尚未由 Podman 后端支持，当前可能因网络策略不可满足而拒绝 |
| `service` | Bubblewrap / namespace | 否 | Profile 合同是严格的，但现有 service/MCP/LSP 生产路径尚未真正进入 Broker；不得据合同反推已隔离 |
| `untrusted` | Podman / container | 否 | Podman/镜像/策略不满足时拒绝 |
| `evolution` | Podman / container | 否 | Podman/镜像/策略不满足时拒绝 |

## 5. 功能与降级矩阵

| 能力 | Host Audit | Bubblewrap | Rootless Podman | 缺失时如何解释 |
|---|---|---|---|---|
| 宿主环境净化 | 有 | 有 | 有 | 环境构造失败应拒绝；不能回退继承全部 `process.env` |
| 工作区外写防护 | 事后检测 | 挂载边界 | 容器挂载边界 | Host Audit 发现越界只能形成 violation，不是实时阻止 |
| 工作区外读防护 | 无内核边界 | 挂载边界 | 容器挂载边界 | 普通 `read_file` 仍需 Workspace I/O/secret/bounded-reader 闭环 |
| 网络隔离 | 无 | `none`/Cell 内 loopback | `none`/容器内 loopback | `proxy-allowlist` 未形成完整生产强制链；不能宣称域名 allowlist 已执行 |
| 进程 namespace | 无 | 有 | 有 | Host Audit 进程仍在宿主可见 |
| CPU/内存/PID 强制 | 无 | 依赖 delegated cgroup | 容器参数 + Broker/cgroup 证据 | 无委托或 attach 未验证时标记降级/拒绝，不能仅凭配置值宣称生效 |
| seccomp | 无 | 能力可用时 BPF | 能力可用时 OCI profile | 当前是组合硬化层，不是独立沙盒；生成失败会记录降级 |
| Landlock | 无 | 未接线 | 未接线 | 当前 WSL2 不可用；不得宣称强制 |
| Receipt | 有但标记降级 | 有 | 有 | Receipt 缺失、摘要不匹配或 cleanup 未验证时不能满足完成门 |

## 6. 当前 WSL2 观测

2026-08-10 对权威开发环境的只读探测：

| 项 | 观测 |
|---|---|
| Kernel | `6.6.87.2-microsoft-standard-WSL2` |
| Bubblewrap | `/usr/bin/bwrap`, `0.9.0` |
| Podman | `/usr/bin/podman`, `4.9.3` |
| cgroup | cgroup v2 (`cgroup2fs`)；具体 Run 仍须证明委托、attach 和 cleanup |
| seccomp | 当前进程处于 filter mode；不等于每个 Orcana 子进程都加载了期望 profile |
| Landlock | `/sys/kernel/security/lsm` 不可读/不可用 |

二进制“已安装”只表示可以进入真实验证，不表示每次执行都使用了该后端。

## 7. 已知未闭环项

以下项目存在源码或测试基础，但当前不能作为已完成的生产强保证：

1. Broker acquisition 在注册前异常的 reservation/lock/cgroup 释放仍需事务化审计。
2. `run.json.cells` 身份写入及无 cgroup 场景的取消/清理真值仍需收敛。
3. service/MCP/LSP 的 ServiceCell 尚未由 Linux Broker、资源预算和 cgroup 统一管理；readiness 也未绑定 listener 与 Cell 身份。
4. `legacy-process` 仍有 sync 调用方；ServiceCell/service lifecycle 和 workspace overlay 也有直接宿主进程点，生产 `src/` 尚不能宣称只有一个进程创建 authority。
5. `read_file` 和 ContextMap 尚缺统一的 secret-read policy 与真正 bounded read；大文件可能先完整读入。
6. PatchTransaction 的严格 filesystem TOCTOU 仍未由 `openat2`/dirfd/`renameat2` 类原语关闭。
7. Landlock 只有探测/规则接口，没有生产执行接线。
8. `proxy-allowlist` 没有完整可执行 egress enforcement；dependency 默认合同当前可能 fail closed。
9. legacy `src/sandbox/capability.ts` 的启动矩阵没有完整反映 Linux Broker 真值；运行级权威应使用 capability probe、真实 backend lane 和 `SandboxReceipt`。
10. 当前已提交源码基线仍有独立 TypeScript `paused` Stop-hook 类型漂移；修复前不得称为 release-ready。
11. 进程旁路 Gate 的 allowlist 与 dynamic require 覆盖仍需收窄；收口前，`DIRECT_PRODUCT_PROCESS_BYPASS = 0` 不能单独作为唯一执行 authority 的证明。

## 8. 声明与验收规则

允许的状态标签：

- `COMPONENT_IMPLEMENTED`：源码/单元测试存在。
- `LOCAL_REAL_BACKEND_VERIFIED`：指定主机真实 backend lane 已通过。
- `DEGRADED_HOST_AUDIT`：执行发生，但没有强隔离边界。
- `ENV_BLOCKED`：必要后端、委托、镜像、secret 或网络策略不可用。
- `CI_BLOCKED_EXTERNAL`：GitHub runner 未执行步骤；不能转写为 PASS/FAIL。
- `RELEASED`：tag、GitHub Release、npm 包和安装烟雾验证均完成。

声称某次执行具有强 Linux isolation，至少需要：

1. 真实 Bubblewrap/Podman 后端被选择并运行；
2. Receipt 与请求/工作区/后端/策略摘要绑定；
3. `degradationReasons` 不包含所要求边界的缺失；
4. cgroup/网络/cleanup 等声明有真实观测而非配置推断；
5. 对应攻击测试在相同能力环境通过；
6. 无 0-step CI、mock-only 或 conditional skip 冒充真机证据。

相关文件：

- [安全模型](security-model.md)
- [后端契约](backend-contract.md)
- [验收矩阵](acceptance-matrix.md)
- [进程执行点 Inventory](../linux-runtime/process-execution-inventory.md)
- [根安全策略](../../SECURITY.md)
