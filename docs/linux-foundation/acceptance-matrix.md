# Orcana Linux 原生执行底座 — 验收矩阵（LNXF-1.0）

| 阶段 | 验收门 | 状态 | 依据 |
|---|---|---|---|
| LF-0 | BASELINE_LOCKED: PASS / KERNEL_CHANGE_REQUIRED: NO / DIRECT_PROCESS_ENTRY_COUNT: RECORDED | 待做 | — |
| LF-1 | LINUX_CAPABILITY_PROBE: PASS / CELL_SPEC_SCHEMA: PASS / RECEIPT_SCHEMA: PASS / BEHAVIOR_CHANGE: 0 | **PASS (v0.8.8)** | linux-foundation.test.ts 24 项：探测（cgroup v2/控制器/委托/降级原因）、digest 稳定、spec 校验（inheritHost=false/身份/digest 绑定）、挂载策略（凭证/Socket/缺失源/重复/父子冲突/相对路径）、7 Profile 严格性、后端路由 fail-closed、Receipt 完整性门、shadow 记录；doctor linux-foundation check；全量 938 pass |
| LF-2 | DIRECT_LINUX_PROCESS_BYPASS: 0 / HOST_ENV_SECRET_LEAK: 0 / ORPHAN_PROCESS_AFTER_CANCEL: 0 / OUTPUT_LIMIT_BYPASS: 0 | **PASS (v0.8.9)** | process-core.test.ts 21 项：显式环境（无继承/白名单/拒绝键/通配）/ 输出限制（截断+标记）/ 监督（退出码/超时/取消/输出上限/daemon 检测/组终止归零）/ host-audit 执行+Receipt / broker enabled 执行 / secrets（sealed-file+env+过期）/ 静态门禁（spawn 调用 ≤ baseline 36）；全量 959 pass |
| LF-3 | HOME_VISIBILITY: 0 / CREDENTIAL_VISIBILITY: 0 / PROJECT_ESCAPE: 0 / NETWORK_EGRESS_NONE: 0 / HOST_PROCESS_VISIBILITY: 0 / BWRAP_DEGRADATION_IN_STRICT: 0 | **PASS (v0.8.10)** | bubblewrap.test.ts 16 项：argv 编译（6 ns/die-with-parent/clearenv/ro 系统根/空 Home/tmpfs/worktree/chdir）/ 禁止挂载 / 策略（container 拒/网络拒/真实 Home 拒/Socket 拒）/ 严格缺失拒；真沙盒 5 项条件运行（HOME 隐藏/项目逃逸/进程可见性/网络 none/Receipt，bwrap 安装后自动启用）；全量 975 pass |
| LF-4 | MEMORY_LIMIT_ENFORCED: PASS / PIDS_LIMIT_ENFORCED: PASS / CGROUP_TREE_KILL: PASS / OOM_OUTSIDE_CELL: 0 / CGROUP_LEAK: 0 | **PASS (v0.8.11)** | cgroup.test.ts 13 项：层级路径 / mock 全生命周期（run/agent/cell 控制器写入、attach、cgroup.kill、remove 清理、指标读取、cleanup、遗留扫描）/ 委托探测 / enableControllers 可用性 / 真内核条件测试（有委托时自动启用）；全量 988 pass |
| LF-5 | CROSS_WORKTREE_SERIALIZATION: 0 / MAIN_WORKSPACE_MULTI_WRITER: 0 / RESOURCE_OVERCOMMIT: 0 / CACHE_CORRUPTION_CROSS_AGENT: 0 / AGENT_CANCEL_ISOLATION: PASS | **PASS (v0.8.12)** | scheduling.test.ts 21 项：原子预留/overcommit 拒绝/并发上限/释放/宿主保留 / 公平队列（优先级/FIFO/per-agent 上限/排水/权重）/ Isolation Lock（main 独占/worktree 并行/cache 锁/releaseAll）/ Cache 路径与锁 / PortLease（loopback/不重复/过期/run 回收/0.0.0.0 拒）/ AgentDomain（绑定/cancel 隔离/closeRun）；全量 1009 pass |
| LF-6 | PRIVILEGED_CONTAINER: 0 / HOST_NETWORK_STRICT: 0 / CONTAINER_SOCKET_VISIBLE: 0 / FLOATING_IMAGE_ACCEPTED: 0 / STRICT_BACKEND_DEGRADED: 0 | **PASS (v0.8.13)** | podman.test.ts 13 项：digest 锁定（浮动 tag 拒）/ argv（无 --privileged/无 host network/network=none/read-only/--rm/pids/memory/标签）/ worktree volume 显式 / 缓存 ro-rw / minimum=container 拒 / 真实 Home 与 Socket 拒 / 严格禁降级 / untrusted+evolution+dependency Profile / 真容器 2 项条件运行；全量 1022 pass |
| LF-7 | NETWORK_ALLOWLIST_BYPASS: 0 / REDIRECT_POLICY_BYPASS: 0 / RECOVERY_WRONG_PROCESS_KILL: 0 / SECRET_SURVIVES_RECOVERY: 0 / JANITOR_RESOURCE_LEAK: 0 | **PASS (v0.8.14)** | network-recovery.test.ts 13 项：egress allowlist / 重定向逐跳复查 / DNS rebinding 私有 IP 拒 / 网络模式 / Landlock 规则集按 ABI+Profile / 不可用降级原因 / seccomp 保守规则与运行时面 / 规则兼容性门 / state store 持久化 / Janitor 旧 boot 清理（同 boot 不误杀）/ boot id；全量 1035 pass |
| LF-8 | 冻结门禁全绿（typecheck/测试/build/pack/Replay/Linux Eval/Multi-Agent Eval/Fault Injection/Perf/Security） | **REVOKED → 修复线 v0.8.15.1+（见下方修正）** | evals/linux-sandbox-eval.ts 35 场景 LX-001~LX-035 曾标 PASS，但多场景实为单元/Mock 级验证（见「v0.8.15.1 修复线」）；生产接线审计为 FAIL，Freeze 撤销，M8 阻塞。评测重写在 PR-8（LF-8 重写）完成 |

## 性能指标（参考机记录硬件/内核/后端版本）

| 指标 | 目标 |
|---|---|
| Bubblewrap 启动 p50 / p95 | ≤ 40ms / ≤ 120ms（或 ≤ HostAudit 3 倍） |
| >3s 任务中位 / p95 墙钟开销 | ≤ 10% / ≤ 15% |
| 8 核 4 独立 Worktree 并发吞吐 | ≥ 顺序 2.5 倍；污染/OOM/遗留进程 0 |
| 取消到进程归零 p95 | ≤ 2s |
| 1000 短 Cell 稳定性 | cgroup/挂载/容器/端口/Receipt 泄漏 0 |

## 安全指标（冻结）

凭证可见 0 / Home 可见路径 0 / none 外网连接 0 / 未授权写入 0 / 未授权 Socket 挂载 0 / 严格静默降级 0 / 取消遗留进程 0 / 跨 Agent 修改 0 / spawn 旁路 0 / 进化实验正式区写入 0 / 无 Receipt 执行 0 / 无 Receipt 完成声明 0。

## 独立审计修正（2026-08-05，审计基线 v0.8.15 / cd25260）

| 裁决 | 状态 |
|---|---|
| LINUX_ARCHITECTURE_DIRECTION | PASS |
| LINUX_COMPONENT_PRIMITIVES | PASS_WITH_ISSUES |
| PRODUCTION_RUNTIME_WIRING | FAIL |
| SINGLE_PROCESS_ENTRY | FAIL |
| CGROUP_RUNTIME_ENFORCEMENT | FAIL |
| RESOURCE_AWARE_GRAPH_SCHEDULING | FAIL |
| SANDBOX_RECEIPT_TRUSTWORTHINESS | FAIL |
| FOUNDATION_FREEZE | **REVOKE** |
| MULTI_AGENT_M8 | **BLOCK** |

**Foundation Freeze 正式撤销。** 当前真实状态：

```text
Linux Foundation Components:   IMPLEMENTED
Production Integration:        INCOMPLETE
Default Linux Execution:       SHADOW
Multi-Agent Production Template: BLOCKED
```

v0.8.15 保留（不删除），作为组件/契约层基线；生产接线闭合在下一版本线（Linux Production Integration Closure）完成前，禁止宣布 Freeze、禁止开始 M8。核心缺口：Broker 未成为真实执行入口、cgroup 未绑定进程、资源调度未进 Graph、Receipt 含推定值、直接 spawn 旁路 36 处、三个后端存在环境/镜像/加固缺口。

## Linux Production Integration Closure（审计修复记录，v0.8.16）

| 阶段 | 修复 | 状态 |
|---|---|---|
| R0 | Foundation Freeze 撤销（IMPLEMENTED / INCOMPLETE / SHADOW / BLOCKED） | **完成** (45581df) |
| R1 | ProcessExecutor 统一入口：run_process/run_shell_script/legacy shell/git/typescript/codegraph/verification/ruff 全部经 Broker 执行；P1-7 环境后门关闭；abortSignal 全链路；流式输出；AST 门禁旁路=0（允许列表仅 linux runtime + executor + legacy-process + tools/process）；遗留 sync/长期进程收拢 legacy-process（R1.2 标注） | **完成** (ec6bb44) |
| R2 | Broker 执行事务：资源预留/Isolation Lock/Agent Domain/cgroup 创建+attach/真实指标/清理验证/取消与清理真实现 | **完成** (0931317) |
| R3 | 后端真实性：seccomp-BPF 文件生成+注入（bwrap --seccomp / podman seccomp-opt）、bwrap --setenv/mounts/tmpfs/cache-rw/loopback lo-up、podman --env/--cap-drop=ALL/no-new-privileges/--tmpfs/--cidfile、host-audit 真 PathGuard（内容指纹 diff） | **完成** (99adc30) |
| R4 | ResourceLedger 接入 Graph 调度（不足时等待而非先启动）；启动 Janitor 接线（boot-id 崩溃恢复）；Agent 身份统一（AgentPool↔AgentDomain）为 R4.2 待办 | **完成** (87358af) |
| R5 | SandboxReceipt→Evidence（sandbox_execution/sandbox_cleanup 证据 + 硬条件 sandbox_* criterion，清理未验证不产生证据） | **完成** (5365099) |
| R6 | 真实验收 CI Lane（真实 bwrap / 真实 rootless podman + digest 解析 / cgroup 委托探测）—— GitHub 账号解锁后生效 | **完成** (8dee0b2) |

剩余待办（下一轮）：R4.2 Agent 身份统一（ParticipantAssignment → AgentPool → Linux Domain 单权威）、H11 NodeContext 消费 Cell/Receipt、长期进程（service/mcp/lsp）Service Cell 化（R1.2）、真实 cgroup/podman 机器上的端到端验收。

## v0.8.15.1 修复线（独立审查后确立，2026-08-06，审计基线 v0.8.16 / db2256b9）

2026-08-06 独立审查（LNXF-1.0 全量 P0 复核）确认：v0.8.15/v0.8.16 的"生产闭环"声明不成立——10 项 P0 全部为源码级确定性缺陷（digest 碰撞、Profile 可降级、bwrap/podman cwd 与 seccomp 接线错误、Receipt 推定值、取消/cgroup 未闭环、输出限制非硬限制、单一入口允许列表旁路、Janitor 空操作、评测 Mock 化）。修复按以下 PR 序列推进，每 PR 一个 commit（门禁全绿），最终与基础设施修复合流以 **0.8.17** 发布：

| PR | 范围 | 状态 |
|---|---|---|
| PR-0 | 生产闭环声明撤销（本文档）；状态统一为 Components IMPLEMENTED / Integration INCOMPLETE / Default Safe Mode SHADOW / Freeze REVOKED / M8 BLOCKED | **完成**（并入 PR-1） |
| PR-1 | 权威 Policy Compiler：递归 canonical JSON（digest 碰撞根因）、Spec 深冻结、CapabilityRequest 单一声明入口、Profile 最低隔离强制（只收紧）、运行时身份生成（不再共享 tool-run）、ExecutionMaterialization（seccomp/secret/cache 不再写回 Spec） | **完成** (4882ba4) |
| PR-2 | 真实 ExecutionOutcome → Receipt 只由 Outcome 构造；Receipt 保留/持久化/自摘要；Evidence 绑定 Receipt Digest | **完成** (5ad2d12) |
| PR-3 | Supervisor 取消与输出限制闭环（超限即杀、流式截断、队列上限、AbortController 入 Broker） | **完成** (7aabf8a) |
| PR-4 | Bubblewrap 真实后端（宿主/内部 cwd 分离、worktreeRoot 投影、seccomp FD、去 sh -c、tmpfs size、清理验证） | **完成** (cb7a869) |
| PR-5 | cgroup 生命周期重建（scope/委托/subtree_control/三级层级/attach/populated=0/rmdir 协议） | **完成** (a782028) |
| PR-6 | 统一身份（ExecutionRuntimeContext、ProcessRequest 全身份字段） | **完成** (5a796a3) |
| PR-7 | Podman OCI seccomp/镜像审批/cidfile 恢复/Secrets 真实挂载/same-boot Janitor 真实清理 | **完成** (ecac004) |
| PR-8 | LF-8 评测重写（真实攻击场景、无委托如实 FAIL、--strict 禁 SKIP、Receipt→Evidence→Gate 端到端） | **完成** (0f644c2) |

**修复线状态（2026-08-06）**：PR-1~PR-8 全部落地。本机评测 32 pass / 4 fail（CGROUP_DELEGATION_REQUIRED，无委托机器如实红）/ 1 skip（podman 未装）。真机 lane 需以 `bun run eval:linux --strict` 跑通（bwrap + rootless podman + cgroup 委托）。全量门禁：typecheck/build/pack/diff-check 全绿；仅剩另一窗口 RC-13 的 revisePlan 语义问题。与基础设施修复合流后以 **0.8.17** 发布。
