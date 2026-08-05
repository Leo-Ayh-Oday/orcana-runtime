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
| LF-8 | 冻结门禁全绿（typecheck/测试/build/pack/Replay/Linux Eval/Multi-Agent Eval/Fault Injection/Perf/Security） | **PASS (v0.8.15)** | evals/linux-sandbox-eval.ts 35 场景 LX-001~LX-035：本机 34 PASS + 1 SKIP（LX-030 podman 环境依赖，策略层已验）。能力探测/fail-closed/环境与凭证可见性 0/Home 与 Socket 拒/项目与符号链接逃逸 0/网络（egress none/loopback/rebinding+重定向复查）/资源（输出/内存/pids/cpu/OOM 指标/超时）/取消（Cell/Agent/Run + 后台进程归零）/并发（worktree 并行/main 单写者/cache 锁/端口租约）/严格后端（digest 锁定/禁降级）/恢复 Janitor（旧 boot 清理、同 boot 不误杀）/seccomp+Landlock 规则与兼容门/Receipt+Evidence 绑定/单 Agent shadow 兼容；全量 3089 pass / 245 文件；typecheck/build/pack/diff-check/bench:mini 全绿 |

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
