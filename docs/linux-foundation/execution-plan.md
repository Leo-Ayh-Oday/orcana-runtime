# Orcana Linux 原生执行底座 — 实施计划（LNXF-1.0）

**计划编号：** LNXF-1.0
**英文名称：** Orcana Linux Native Execution Foundation
**当前基线：** Orcana Runtime `v0.8.7`（M7 已完成；计划原文基线 v0.8.6 已超越）
**基线提交：** `fa3b870`
**实施目标：** 为单 Agent、Typed Graph、多 Agent、服务运行和递归进化提供统一、快速、稳定、可治理的 Linux 原生执行层。
**核心原则：** Linux First、单一执行入口、默认最小权限、隔离域内并行、权威提交点串行、严格任务禁止静默降级。

> 记录说明：LNXF 实施期间所有产出**不进入 0.9 版本线**，版本继续沿 0.8.x 推进。

---

## 一、项目裁决

多 Agent 主线已完成 M1–M7；M8–M10 阻塞于执行边界问题。立即切换到 LNXF Linux 原生执行底座，完成后再恢复 M8–M10。

原因：M8 以后会真正并发运行多个模型生成的程序、测试、构建和服务。没有可靠的 Linux 进程、资源、文件系统和网络边界，多 Agent 只是放大风险。

## 二、当前源码的真实问题

1. **现有 SandboxManager 不是 Linux 安全边界** —— Linux/macOS 主要退化为环境过滤与超时；没有网络隔离、没有执行期间文件系统拦截；PathGuard 是事后审计。重新定义为 `Host Audit Backend`。
2. **进程执行存在环境继承风险** —— `{ ...process.env, ...params.env }` 意味着宿主 API Key、代理、SSH、云凭证可能被子进程继承。子进程环境 = Runtime 明确构造的完整集合。
3. **Worktree 不等于系统隔离** —— 无法防止读取真实 Home、SSH/GPG/云凭证、Docker/Podman Socket、任意联网、fork bomb、内存耗尽、无限写临时文件、后台进程逃逸、访问本地敏感服务。

## 三、目标定义

> 所有本地 Linux 子进程、工具节点、验证节点、服务节点和多 Agent 工作负载的统一执行、隔离、资源治理、并发调度和审计层。

它不是：Bubblewrap 命令封装；Podman 包装器；Shell 正则；新的 Graph 调度器；绕过 Harness 的旁路；让模型自行选择安全等级的接口。

## 四、目标架构

```
Graph / Single-Agent Kernel → H11 Node Runtime → CapabilityExecutor
→ Linux Execution Broker
  ├── Capability Probe       ├── Policy Compiler
  ├── Resource Scheduler     ├── Cgroup Manager
  ├── Workspace / Cache Manager
  ├── Process Supervisor     ├── Backend Router
  ├── Recovery Janitor       └── Receipt Writer
→ Host Audit(降级) / Bubblewrap(快速) / Rootless Podman(严格)
→ Linux Kernel（namespaces · cgroup v2 · Landlock · seccomp）
```

Orcana 必须拥有自己的 **Sandbox Policy Compiler**，禁止模型或工具拼接 `bwrap` 参数。

## 五、核心运行模型

### 5.2 Agent Execution Domain

```ts
interface AgentExecutionDomain {
  domainId: string; runId: string; agentId: string
  role?: string; worktreeRoot: string; ownerFiles: string[]
  cgroupPath: string; tempRoot: string; cacheNamespace: string
  resourceBudget: DomainResourceBudget
  createdAt: number
  status: "active" | "cancelling" | "closed" | "failed"
}
```

### 5.3 Execution Cell

每次真实命令/测试/构建/服务启动对应一个短生命周期 Cell：

```ts
interface ExecutionCell {
  cellId: string; runId: string; nodeRunId: string; agentId?: string
  spec: ExecutionCellSpec
  state: ExecutionCellState
  receipt?: SandboxReceipt
}
```

Cell 结束：进程归零、资源释放、写入审计、Receipt 生成。

## 六、架构不变量（15 条）

1. Linux 上所有子进程必须经过 Linux Execution Broker。
2. Graph、Skill、模型和普通 Tool 不得直接调用 `spawn()`。
3. 模型只能声明执行需求，不能选择更弱隔离。
4. 严格隔离不可用时必须拒绝，禁止静默回退。
5. 网络默认关闭。
6. 真实 Home、凭证目录和容器 Socket 默认不可见。
7. 子进程环境变量必须显式构造。
8. Agent 只能写入自己的 Worktree 和所有权范围。
9. 不同 Worktree 可以并行写，正式工作区仍是单写者。
10. 取消必须终止整个 Cell、Agent 或 Run 的 cgroup 树。
11. 自进化实验永远不能直接运行在正式工作区。
12. 所有执行必须产生 Sandbox Receipt。
13. Receipt 必须进入 Trace、Evidence 和失败诊断。
14. 权限只能继续收紧，不能由模型或 Skill 扩大。
15. Host Audit 不能被宣传为强安全边界。

## 七、核心数据契约

- `LinuxCapabilities`（schemaVersion "1.0"）：platform/architecture/kernelRelease/bootId；cgroup（version 2|1|0、delegated、controllers、supportsKill/Freeze/Pressure）；namespaces 八项；bubblewrap/podman/landlock/seccomp/filesystem/systemd 探测；degradationReasons[]。
- `ExecutionCellSpec`（"1.0"）：identity（cellId/runId/nodeRunId/attempt/agentId/assignmentId）；command（executable/args/cwd/stdin）；profile（inspect/build/test/dependency/service/untrusted/evolution）；isolation（minimum: audit|namespace|container、preferredBackend、allowDegradation）；filesystem（readonlyMounts/writableMounts/tmpfsMounts/hiddenPaths/emptyHome/worktreeRoot/ownerFiles）；network（none|loopback|proxy-allowlist|full-approved）；environment（variables/inheritHost:false/locale/pathEntries）；secrets；resources（cpu/memory/pids/io/tmpfs/wallTime/stdout/stderr/maxOpenFiles）；cache；lifecycle；policyDigest。**不可变、可序列化、可哈希、可回放、可进 Trace、不可由模型直接提交给后端。**
- `MountRule`（source/target/mode ro|rw/required/recursive/noExec/noDev/noSuid）—— 必须经过路径规范化、realpath、符号链接检查、系统路径策略、所有权策略、重复目标、父子挂载冲突检查。
- `SecretBinding`（delivery: sealed-file|file-descriptor|environment；默认优先 fd 或 /run/secrets 只读文件）。
- `DomainResourceBudget`（maxConcurrentCells/cpuQuotaTotal/memoryMaxBytes/pidsMax/maxWallTimeMs/maxOutputBytes/maxTempBytes）。
- `SandboxReceipt`（"1.0"）：backend/version/profile；五类 digest（capabilities/cellSpec/filesystemPolicy/networkPolicy/resourcePolicy）；时间戳与退出码/信号；timedOut/cancelled/oomKilled/pidLimitHit/outputLimitHit/tempLimitHit；metrics（cpuUsageUsec/cpuThrottledUsec/peakMemoryBytes/peakPids/readBytes/writeBytes）；observedWrites/observedDeletes/unexpectedWrites；networkMode/secretBindingIds；violations/degradationReasons；cleanup 五状态。

## 八、错误模型

错误码（节选）：`LINUX_PLATFORM_REQUIRED`、`CGROUP_V2_UNAVAILABLE`、`CGROUP_DELEGATION_UNAVAILABLE`、`CGROUP_CONTROLLER_UNAVAILABLE`、`USER_NAMESPACE_UNAVAILABLE`、`BUBBLEWRAP_UNAVAILABLE`、`BUBBLEWRAP_PROBE_FAILED`、`ROOTLESS_PODMAN_UNAVAILABLE`、`PODMAN_STORAGE_UNAVAILABLE`、`ISOLATION_REQUIREMENT_UNMET`、`DEGRADATION_NOT_ALLOWED`、`EXECUTION_SPEC_INVALID`、`MOUNT_POLICY_INVALID`、`MOUNT_SOURCE_MISSING`、`PATH_ESCAPE_BLOCKED`、`SECRET_BINDING_DENIED`、`HOST_ENV_INHERITANCE_BLOCKED`、`NETWORK_POLICY_UNAVAILABLE`、`RESOURCE_RESERVATION_FAILED`、`CGROUP_CREATE_FAILED`、`CGROUP_ATTACH_FAILED`、`PROCESS_START_FAILED`、`PROCESS_ORPHANED`、`PROCESS_TIMEOUT`、`PROCESS_CANCELLED`、`PROCESS_OOM_KILLED`、`PROCESS_PID_LIMIT`、`PROCESS_OUTPUT_LIMIT`、`TEMP_STORAGE_LIMIT`、`SANDBOX_VIOLATION`、`SANDBOX_CLEANUP_INCOMPLETE`、`SANDBOX_RECEIPT_INCOMPLETE`。

映射：策略拒绝 → `blocked`；后端启动失败 → `execution_failed`；程序退出非零 → `domain_failed` 或 `execution_failed`；用户取消 → `cancelled`；超时 → `timed_out`；OOM/PID 限制 → `execution_failed` + 明确 errorCode。

## 九、Sandbox Profile（7 个）

| Profile | 后端 | Worktree | 网络 | Home | 内存 | PIDs |
|---|---|---|---|---|---|---|
| inspect | Bubblewrap | ro | none | 空 | 256–512MB | 32 |
| build | Bubblewrap | rw | none | 空 | 1–2GB | 128 |
| test | Bubblewrap | rw | none/loopback | 空 | 按项目 | 按项目 |
| dependency | Rootless Podman 优先 | rw+缓存 | proxy-allowlist | 不可见 | 按策略 | 按策略 |
| service | Bubblewrap/Podman | rw | 独立 ns+loopback | 空 | 按策略 | 按策略 |
| untrusted | Rootless Podman | 单独挂载 | none | 不可见 | 严格 | 严格 |
| evolution | Rootless Podman | 实验区唯一可写 | none | 不可见 | 严格 | 严格 |

`allowDegradation: false`：untrusted、evolution。dependency 的 postinstall 需策略批准。

## 十、后端设计

### 10.1 Host Audit Backend（降级）
现有 SandboxManager 迁移，只保留：环境过滤、超时、进程组、PathGuard、执行收据、低风险兼容。允许条件：profile=inspect/低风险 build、minimum=audit、用户显式允许。禁止：untrusted、evolution、未知依赖安装、高风险脚本、多 Agent 正式模板、需网络隔离任务。

### 10.2 Bubblewrap Fast Backend
默认 `--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-net --die-with-parent --new-session --clearenv`。根布局：/usr、/bin、/lib、/lib64 ro；/etc/ssl/certs ro；/proc 新 PID ns；/dev 最小；/tmp、/run 独立 tmpfs；/home/orcana 空；/workspace Worktree；/cache/* 显式挂载。**禁止挂载**：真实 $HOME、~/.ssh、~/.gnupg、~/.aws、~/.config/gcloud、~/.orcana/auth.json、/run/docker.sock、Podman Socket、SSH_AUTH_SOCK、宿主 /tmp、其他项目、D-Bus/桌面 Socket。参数由 Backend 编译器产生，模型不得控制。

### 10.3 Rootless Podman Strict Backend
规则：不得 `--privileged`；不得挂载宿主 Socket；不得 host network；不得暴露真实 Home；不得自动拉取未批准镜像；镜像 digest 锁定。容器命名 `orcana-<runId>-<cellId>`，标签 `io.orcana.run/cell/agent` 用于恢复清理。

## 十一、cgroup v2 资源层

层级：`orcana.scope → run-<runId> → {agent-<A>, agent-<B>, system}`，agent 下 cell-*。Run 层：总内存/CPU/PIDs/并发/输出/临时磁盘/全局取消。Agent 层：内存上限、CPU 权重、累计执行时间、并发 Cell、最大进程数、累计输出。Cell 层：`cpu.max`、`cpu.weight`、`memory.high/max`、`memory.swap.max`、`memory.oom.group=1`、`pids.max`、`io.weight`。systemd 委托优先顺序：systemd 用户 Scope+Delegate → 已存在委托子树 → 手工委托 cgroup → 无委托标记降级；严格 Profile 无委托拒绝。

## 十二、资源感知调度器

`ResourceRequest`（cpuQuota/memoryBytes/pids/ioWeight/networkSlots/tempBytes）→ 原子预留 `ResourceReservation` → 成功创建 Cell，失败 `waiting_resources`。禁止部分预留、禁止"先启动再观察 OOM"。公平性：按 Run/Agent 分层加权公平队列；交互优先、验证高于低优先级分析、同 Agent 不长期占满、Evolution 默认低优先级、人工等待中的 Run 不占资源。宿主保留：CPU 1 核或 15%、内存 1GB 或 20% 取较大者。

## 十三、多 Agent 并发模型

Isolation-Domain Lock：`main-workspace` 独占写锁；`worktree:<agent>` 独占写锁；`cache:<type>:<key>` 独占或读写锁；`artifact:<id>` 不可变。并发条件 8 条（资源预留成功、Worktree 不同或均只读、缓存锁不冲突、无正式工作区写入、网络槽位足够、计划依赖允许、无用户中断、隔离后端可用）。取消层级：Cell → `cgroup.kill(cell)`；Agent → `cgroup.kill(agent)`；Run → `cgroup.kill(run)`。

## 十四、统一进程执行

`LinuxExecutionBroker` 接口：probe / createAgentDomain / execute (AsyncIterable<ExecutionCellEvent>) / inspectCell / cancelCell / cancelAgent / cancelRun / closeAgentDomain / cleanupRun。**禁止入口**：`child_process.spawn/exec/execFile`、`Bun.spawn`、`Deno.Command`、`shell:true`（Linux 上除 Broker backends 目录外）。静态门禁 `DIRECT_LINUX_PROCESS_BYPASS = 0`。迁移对象：`src/tools/process.ts`、`src/tools/shell.ts`、Git、服务、MCP Server、验证工具 → Broker Client。

## 十五、显式环境变量系统

`EnvironmentPolicy`（baseProfile: minimal|node|build|service、allowedHostKeys、fixedValues、requestedValues、deniedKeys）。流程：空对象 → Runtime 固定安全变量 → Profile 允许变量 → Tool 明确申请 → Secret Broker 注入 → 策略校验 → 冻结。默认变量：PATH、HOME=/home/orcana、TMPDIR=/tmp、LANG、LC_ALL、TERM（需要时）、NODE_ENV、ORCANA_RUN_ID、ORCANA_NODE_RUN_ID、ORCANA_SANDBOX=1。默认拒绝：`*_API_KEY`、`*_TOKEN`、`AWS_*`、`GITHUB_TOKEN`、`SSH_AUTH_SOCK`、`DOCKER_HOST`、`KUBECONFIG`、`DATABASE_URL`、HTTP(S)_PROXY（除非批准）。

## 十六、网络治理

第一版：none / loopback / full-approved。proxy-allowlist 为后续增强（Cell 无直接外网，仅连 Orcana Egress Proxy，逐跳复查 DNS/重定向/非 HTTP）。dependency Profile 在 proxy-allowlist 完成前优先 Rootless Podman + 人工批准网络。

## 十七、缓存和工作区

项目层：只读基础仓库 + 每 Agent Git Worktree + 每 Cell 独立 tmpfs（禁止每 Cell 复制项目）。缓存分类：只读共享（内容寻址下载、Repo Map、AST 索引、已完成的工具链镜像、不可变编译 Artifact）；Key 锁（Bun/npm/pnpm 下载缓存、构建缓存、TS 增量缓存、测试资源）；不允许共享（node_modules 写入过程、测试数据库、服务状态、临时端口文件、不完整安装目录、Agent 私有输出）。`CacheMountRequest`（cacheId/kind/key/mode ro|rw-locked/target）——缓存宿主路径由 Runtime 决定。

## 十八、服务和端口

`PortLeaseManager` + `PortLease`（leaseId/runId/cellId/agentId/internalPort/hostPort/bindAddress "127.0.0.1"/expiresAt）。默认服务只在隔离 namespace 内可见；不自动映射宿主端口；需浏览器/用户访问才申请 Host Lease；禁止绑定 0.0.0.0；Run 结束自动回收；端口进 Receipt。

## 十九、Landlock 与 seccomp

定位：Bubblewrap/Podman + Landlock + seccomp 组合（不是单独承担）。第一版：完成探测和接口；不强制所有语言共享同一 seccomp 列表；先为 inspect/untrusted 提供保守规则；规则变更必须有兼容性测试。

## 二十、持久化与崩溃恢复

Runtime 状态目录 `~/.orcana/runtime/linux/`（capabilities.json、runs/<runId>/{run.json,domains,cells,receipts,cleanup.json}、locks）。启动 Janitor：读 Boot ID → 扫描未关闭 Run → 检查 cgroup/bwrap 父进程/Podman Label/Worktree/端口租约 → 杀死确认属于旧 Run 的遗留进程（禁止只按 PID）→ 释放资源 → Recovery Receipt。Retain on Failure：保留 Worktree/Receipt/日志/Spec，但必须已杀进程、关网络、卸挂载、删 cgroup、删 SecretBinding。

## 二十一、配置设计

`linux` 配置节：enabled/mode（off|shadow|enabled|enforced）/preferredBackend/strictBackend/allowHostAudit；resources（hostCpuReserve/hostMemoryReserveMb/maxConcurrentCells/defaultMemoryMb/defaultPids）；network（default none/allowFullWithApproval）；bubblewrap（enabled/disableNestedUserNamespaces）；podman（enabled/pullPolicy never/approvedImages）；recovery（cleanupOnStartup/retainFailedWorktrees）。渐进迁移：off → shadow → enabled → enforced。

## 二十二、源码目录规划

```
src/runtime/linux/
├── index.ts contracts.ts errors.ts capability-probe.ts profiles.ts
├── policy-compiler.ts backend-router.ts broker.ts receipt.ts
├── environment.ts secrets.ts network-policy.ts
├── process/{supervisor,output-limiter,termination}.ts
├── backends/{backend,host-audit,bubblewrap,podman}.ts
├── cgroup/{probe,delegation,manager,hierarchy,metrics,cleanup}.ts
├── scheduler/{resource-ledger,reservation,queue,fairness}.ts
├── workspace/{agent-domain,isolation-lock,cache-manager,port-lease,mount-validator}.ts
└── recovery/{state-store,janitor,boot-identity}.ts
```
兼容适配：`src/sandbox/sandbox.ts` → HostAuditBackend 适配器；`src/tools/process.ts` → LinuxExecutionBroker Client。

## 二十三、实施阶段（LF-0 ~ LF-8）

| 阶段 | 版本 | 内容 | 验收门 |
|---|---|---|---|
| LF-0 | 文档提交 | 基线冻结 + 5 文档 + 10 ADR | BASELINE_LOCKED: PASS / KERNEL_CHANGE_REQUIRED: NO / DIRECT_PROCESS_ENTRY_COUNT: RECORDED |
| LF-1 | v0.8.8 | 契约 + 能力探测 + `orcana doctor linux` + shadow | LINUX_CAPABILITY_PROBE: PASS / CELL_SPEC_SCHEMA: PASS / RECEIPT_SCHEMA: PASS / BEHAVIOR_CHANGE: 0 |
| LF-2 | v0.8.9 | ProcessSupervisor + 显式环境 + HostAuditBackend + 进程迁移 + 静态门禁 | DIRECT_LINUX_PROCESS_BYPASS: 0 / HOST_ENV_SECRET_LEAK: 0 / ORPHAN_PROCESS_AFTER_CANCEL: 0 / OUTPUT_LIMIT_BYPASS: 0 |
| LF-3 | v0.8.10 | Bubblewrap 后端 + 挂载验证 + 空 Home + Receipt | HOME_VISIBILITY: 0 / CREDENTIAL_VISIBILITY: 0 / PROJECT_ESCAPE: 0 / NETWORK_EGRESS_NONE: 0 / HOST_PROCESS_VISIBILITY: 0 / BWRAP_DEGRADATION_IN_STRICT: 0 |
| LF-4 | v0.8.11 | cgroup v2 资源治理（委托/三级层级/cpu/memory/pids/cgroup.kill/metrics） | MEMORY_LIMIT_ENFORCED / PIDS_LIMIT_ENFORCED / CGROUP_TREE_KILL / OOM_OUTSIDE_CELL: 0 / CGROUP_LEAK: 0 |
| LF-5 | v0.8.12 | AgentExecutionDomain + ResourceLedger + 公平队列 + Isolation-Domain Lock + Cache/Port 管理 + waiting_resources | CROSS_WORKTREE_SERIALIZATION: 0 / MAIN_WORKSPACE_MULTI_WRITER: 0 / RESOURCE_OVERCOMMIT: 0 / CACHE_CORRUPTION_CROSS_AGENT: 0 / AGENT_CANCEL_ISOLATION: PASS |
| LF-6 | v0.8.13 | Rootless Podman 严格后端 + evolution/untrusted/dependency Profile | PRIVILEGED_CONTAINER: 0 / HOST_NETWORK_STRICT: 0 / CONTAINER_SOCKET_VISIBLE: 0 / FLOATING_IMAGE_ACCEPTED: 0 / STRICT_BACKEND_DEGRADED: 0 |
| LF-7 | v0.8.14 | Egress Proxy + Landlock + seccomp + Runtime State Store + Startup Janitor | NETWORK_ALLOWLIST_BYPASS: 0 / REDIRECT_POLICY_BYPASS: 0 / RECOVERY_WRONG_PROCESS_KILL: 0 / SECRET_SURVIVES_RECOVERY: 0 / JANITOR_RESOURCE_LEAK: 0 |
| LF-8 | v0.8.15 | 生产评测（35 场景 LX-001~LX-035）+ Foundation Freeze | typecheck/完整测试/build/pack/Replay/Linux Sandbox Eval/Multi-Agent Eval/Fault Injection/Perf Benchmark/Security Regression |

## 二十四、性能验收指标

Bubblewrap 启动：p50 ≤ 40ms、p95 ≤ 120ms（达不到则以相对基线：≤ HostAudit 3 倍）。构建测试（>3s 任务）：中位墙钟开销 ≤ 10%、p95 ≤ 15%。并发扩展：8 核、4 独立 Worktree → 4 Cell 总吞吐 ≥ 顺序 2.5 倍，跨 Worktree 污染/OOM/遗留进程 = 0。取消：p95 ≤ 2 秒进程归零。稳定性：1000 短 Cell → cgroup/挂载/容器/端口/Receipt 泄漏 = 0。这些是工程验收目标，不是当前已实现的性能事实。

## 二十五、安全验收指标

宿主凭证可见 0；真实 Home 可见路径 0；none 模式外网连接 0；未授权项目外写入 0；未授权 Socket 挂载 0；严格任务静默降级 0；取消后遗留进程 0；跨 Agent Worktree 修改 0；直接 spawn 旁路 0；进化实验正式工作区写入 0；无 Receipt 执行 0；无 Receipt 完成声明 0。

## 二十六、Evidence 接入

SandboxReceipt 绑定：nodeRunId/cellId/workspaceDigest/backend/profile/cellSpecDigest/resourcePolicyDigest/networkPolicyDigest。完成门区分 HostAudit 降级与 Bubblewrap 无网络受限执行。高风险任务可要求 minimumIsolation=container。新增类型化 Criterion：sandbox_profile / sandbox_backend / sandbox_no_degradation / resource_limit_applied / network_isolated。

## 二十七、递归进化接入

低风险文档/测试提案 → Bubblewrap；普通代码提案 → Bubblewrap + 独立 Worktree；Runtime/Permission/Sandbox 提案 → Rootless Podman + 独立 Worktree + 人工批准。Evolution 不能修改当前 Broker/Policy Compiler/Sandbox Backend；避免"沙盒中的 Orcana 修改正在保护自己的沙盒"。高风险升级在独立 Run 中生效。

## 二十八、与多 Agent 主线恢复顺序

LNXF 完成后：M7（已完成）→ M8 静态 Reviewed Change 模板 → M9 确定性裁决 → M10 生产评测。M8 验收必须：每 Coder 用 AgentExecutionDomain、每命令用 ExecutionCell、每 Cell 有 cgroup+Receipt、不同 Worktree 并发、合并点单写者、严格任务禁 HostAudit。

## 二十九、明确延期范围

Kubernetes、分布式远程 Agent、跨机器 cgroup、GPU 隔离、完整 VM 后端、Firecracker、gVisor、任意协议域名级网络代理、内核模块、eBPF 全量行为监控、自动选择任意第三方容器镜像、Agent 自行定义 seccomp、模型直接操作 systemd、公网服务部署、全系统级守护进程。

## 三十、全局停止条件

1. 必须绕过 Harness 才能执行；2. 必须修改 Kernel 才能建立 Linux 执行；3. Bubblewrap 必须暴露真实 Home 才能工作；4. 无 cgroup 委托却继续宣传资源隔离；5. 多 Agent 并发性能无收益（保持受限并发）；6. 安全规则只能依赖命令字符串判断；7. Receipt 不能反映实际后端；8. 沙盒策略出现多套权威（Policy Compiler 必须是唯一正式入口）。

## 三十一、最终验收定义（20 条）

1. Linux 上所有子进程均经过统一 Broker；2. 子进程默认不继承宿主环境；3. Bubblewrap 成为普通任务默认快速后端；4. Podman 成为未知代码和自进化严格后端；5. 网络默认关闭；6. Home/凭证/容器 Socket 默认不可见；7. cgroup v2 三级资源生效；8. Cell/Agent/Run 完整取消；9. 多 Agent 不同 Worktree 安全并发写；10. 正式工作区单写者；11. 资源不足时等待而非先启动；12. 缓存共享不跨 Agent 污染；13. 每次执行有完整 Receipt；14. Receipt 与 Evidence/Trace/完成门绑定；15. 崩溃后可清理遗留资源；16. Evolution 不触碰正式运行时；17. HostAudit 不满足严格隔离条件；18. 单 Agent 和 Windows 现有路径无无意回归；19. 安全/稳定/性能评测全达门禁；20. 文档中的 Linux 能力和源码真实一致。

完成前只能称为 "Linux Execution Foundation 实验实现"。
