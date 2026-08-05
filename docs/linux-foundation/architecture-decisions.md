# Orcana Linux 原生执行底座 — 架构决策（LNXF-1.0 ADR）

**状态表：** 决策随阶段实施更新；`已定案` 表示对应阶段完成并验证。

| ADR | 决策 | 状态 | 阶段 |
|---|---|---|---|
| ADR-L1 | **Linux 子进程单一入口**：Linux 上所有子进程必须经过 `LinuxExecutionBroker`；Graph/Skill/模型/普通 Tool 禁止直接 `spawn()`/`execFile`/`Bun.spawn`/`shell:true`；静态门禁 `DIRECT_LINUX_PROCESS_BYPASS = 0`（允许目录仅 `src/runtime/linux/backends/` 与 `src/runtime/linux/process/`） | 待定 | LF-2 |
| ADR-L2 | **Bubblewrap 为默认快速后端**：用户/mount/PID/IPC/UTS/net namespace + 空 mount ns + 只读系统根 + 空 Home + 独立 tmpfs；参数由 Policy Compiler 编译，模型/工具不得拼接 `bwrap` 参数 | 待定 | LF-3 |
| ADR-L3 | **Rootless Podman 为严格后端**：digest 锁定镜像、`--read-only`、`--network=none`、显式 volume、资源限制、标签 `io.orcana.*`；禁止 `--privileged`/host network/宿主 socket/浮动 tag | 待定 | LF-6 |
| ADR-L4 | **Host Audit 仅为降级后端**：现有 SandboxManager 迁移为 HostAuditBackend（环境过滤/超时/进程组/PathGuard/Receipt）；仅 inspect/低风险 build + `minimum=audit` + 显式允许时使用；untrusted/evolution/多 Agent 正式模板禁止 | 待定 | LF-2 |
| ADR-L5 | **cgroup v2 三级层级**：`orcana.scope → run-<runId> → agent-<agentId> → cell-<cellId>`；`memory.oom.group=1`；取消 = `cgroup.kill` 树级；systemd 委托优先序（user Scope+Delegate → 已有委托子树 → 手工委托 → 降级标记），严格 Profile 无委托拒绝 | 待定 | LF-4 |
| ADR-L6 | **显式环境变量系统**：子进程环境 = 空对象 → Runtime 固定变量 → Profile 允许 → Tool 申请 → Secret 注入 → 校验 → 冻结；禁止 `{...process.env, ...requested}`；默认拒绝 `*_API_KEY`/`*_TOKEN`/`AWS_*`/`SSH_AUTH_SOCK`/`DOCKER_HOST` 等 | 待定 | LF-2 |
| ADR-L7 | **网络默认关闭**：新网络 namespace 默认 `none`；`loopback` 仅 Cell/Domain 内；`full-approved` 需人工批准并记录 Receipt；proxy-allowlist 为后续增强，禁止简单 DNS 预解析治理 | 待定 | LF-3/LF-7 |
| ADR-L8 | **Isolation-Domain Lock**：`main-workspace` 独占写锁、`worktree:<agent>` 独占写锁、`cache:<type>:<key>` 独占/读写锁、`artifact:<id>` 不可变；不同 Worktree 并行写、正式工作区单写者 | 待定 | LF-5 |
| ADR-L9 | **严格 Profile 禁止降级**：`allowDegradation:false` 的 Profile（untrusted/evolution）在严格隔离不可用时**拒绝执行**而非回退；`ISOLATION_REQUIREMENT_UNMET`/`DEGRADATION_NOT_ALLOWED` | 待定 | LF-3/LF-6 |
| ADR-L10 | **Receipt 进入 Evidence**：每次执行产生 `SandboxReceipt`，绑定 nodeRunId/cellId/workspaceDigest/backend/profile/cellSpecDigest/resourcePolicyDigest/networkPolicyDigest；HostAudit 结果不能满足 `minimumIsolation=container` 的 Criterion | 待定 | LF-2 |

**记录时点（LF-0 基线）：**
- 直接进程入口计数：**36 处调用 / 7 个源文件**（`src/tools/process.ts` 3、`src/tools/shell.ts` 3、`src/tools/git.ts` 2、`src/tools/mcp.ts` 1、`src/tools/service.ts` 2、`src/verification/collector.ts` 6，其余散布于 lsp/ripple/typescript/codegraph/journal/worktree/post-loop 等）
- Kernel 变更需求：**NO**（不修改 kernel；执行层全部落在 Broker 目录与适配层）
- 环境实测（WSL2 kernel 6.6.87.2）：cgroup v2 ✓（cpu/io/memory/pids 等控制器）、user namespace ✓、seccomp ✓、bwrap ✗、podman ✗、Landlock LSM 未启用
