# Orcana Linux 原生执行底座 — 后端契约（LNXF-1.0）

> 当前状态（2026-08-10）：本文件定义后端合同；不是所有执行路径均已满足
> 合同。Linux 普通短进程已进入 Broker，service/MCP/LSP 仍走直接 spawn 的
> 过渡期 ServiceCell。运行级强制与降级裁决见
> [当前状态与降级矩阵](current-status.md)。

## 1. Backend 接口

```ts
interface ExecutionBackend {
  readonly id: "host-audit" | "bubblewrap" | "rootless-podman"
  /** 后端可用性（依赖能力探测缓存）。 */
  availability(): BackendAvailability
  /** 校验 spec 是否满足该后端约束；拒绝时给出错误码。 */
  validateSpec(spec: ExecutionCellSpec): string[]          // [] = 可执行
  /** 编译后端专属启动参数（模型/工具不可见，Policy Compiler 唯一来源）。 */
  compile(spec: ExecutionCellSpec): CompiledExecution
  /** 执行 cell，产出事件流与 Receipt。 */
  run(spec: ExecutionCellSpec, ctx: BackendRunContext): AsyncIterable<ExecutionCellEvent>
}
```

**契约约束：**
- `compile` 产物不可由模型/工具直接提交给后端（spec 必须经过 Broker 与 Policy Compiler）。
- `run` 必须：进程归零、资源释放、写入审计、产出 `SandboxReceipt`。
- 后端不可用时：`minimum=audit` 且 `allowDegradation=true` 才允许降级；否则拒绝（`ISOLATION_REQUIREMENT_UNMET` / `DEGRADATION_NOT_ALLOWED`）。

## 2. 后端职责矩阵

| 能力 | Host Audit | Bubblewrap | Rootless Podman |
|---|---|---|---|
| 环境过滤 | ✓ | ✓（clearenv + 显式构造） | ✓（容器 env 显式） |
| 超时/取消 | 进程组 best-effort | `--die-with-parent`；cgroup 仅在委托/attach 验证后 | 容器 stop/kill；最终结果仍看 Receipt |
| 网络隔离 | ✗ | ✓（--unshare-net，none/loopback） | ✓（--network=none） |
| 文件系统拦截 | ✗（事后 PathGuard） | ✓（只读根 + 挂载白名单） | ✓（只读根 + volume） |
| 空 Home | ✗（不可保证） | ✓（/home/orcana 空目录） | ✓（镜像内） |
| 资源限制 | ✗ | delegated cgroup 且 attach 验证后 | 容器参数 + Broker/cgroup 观测后 |
| 进程可见性 | 宿主可见 | 新 PID namespace | 容器内 |
| Receipt | ✓（降级标记） | ✓ | ✓ |
| 适用 Profile | inspect / 低风险 build（显式允许） | inspect/build/test/service | dependency/untrusted/evolution/service |

补充限制：

- Host Audit 的 PathGuard 是事后检测，不能阻止执行中的越界读写；
- Bubblewrap/Podman 的 seccomp 是额外硬化层，加载失败或不可用必须进入
  degradation/拒绝裁决；
- Podman 当前只接受 `none`/`loopback`，尚不能满足 `dependency` 默认的
  `proxy-allowlist`；
- Rootless Podman 共享宿主内核，不等于 VM；
- Landlock 不属于当前生产后端强制链；
- ServiceCell 不通过本 Backend 接口，不能按本表推导其隔离能力。

## 3. Receipt 契约（SandboxReceipt 必需字段）

```ts
interface SandboxReceipt {
  schemaVersion: "1.0"
  cellId: string; runId: string; nodeRunId: string; attempt: number; agentId?: string
  backend: "host-audit" | "bubblewrap" | "rootless-podman"
  backendVersion?: string
  profile: ExecutionCellSpec["profile"]
  capabilitiesDigest: string
  cellSpecDigest: string
  filesystemPolicyDigest: string
  networkPolicyDigest: string
  resourcePolicyDigest: string
  startedAt: number; finishedAt: number; durationMs: number
  exitCode: number | null; signal: string | null
  timedOut: boolean; cancelled: boolean; oomKilled: boolean
  pidLimitHit: boolean; outputLimitHit: boolean; tempLimitHit: boolean
  metrics: { cpuUsageUsec?; cpuThrottledUsec?; peakMemoryBytes?; peakPids?; readBytes?; writeBytes? }
  observedWrites: string[]; observedDeletes: string[]; unexpectedWrites: string[]
  networkMode: string; secretBindingIds: string[]
  violations: SandboxViolation[]; degradationReasons: string[]
  cleanup: { processesRemaining: number; mountsReleased: boolean; cgroupRemoved: boolean; containerRemoved?: boolean; worktreeRetained: boolean }
}
```

## 4. 错误码 → 结果映射

| 错误码 | 映射 |
|---|---|
| MOUNT_POLICY_INVALID / PATH_ESCAPE_BLOCKED / NETWORK_POLICY_UNAVAILABLE / SECRET_BINDING_DENIED / HOST_ENV_INHERITANCE_BLOCKED / ISOLATION_REQUIREMENT_UNMET / DEGRADATION_NOT_ALLOWED | `blocked` |
| LINUX_PLATFORM_REQUIRED / *_UNAVAILABLE / PROBE_FAILED / EXECUTION_SPEC_INVALID / RESOURCE_RESERVATION_FAILED / CGROUP_CREATE_FAILED / PROCESS_START_FAILED | `execution_failed` |
| 程序退出非零 | `domain_failed` 或 `execution_failed` |
| PROCESS_CANCELLED | `cancelled` |
| PROCESS_TIMEOUT | `timed_out` |
| PROCESS_OOM_KILLED / PROCESS_PID_LIMIT / PROCESS_OUTPUT_LIMIT / TEMP_STORAGE_LIMIT | `execution_failed` + 明确 errorCode |
| SANDBOX_VIOLATION / SANDBOX_CLEANUP_INCOMPLETE / SANDBOX_RECEIPT_INCOMPLETE | `execution_failed` + violation 详情 |

## 5. Evidence 绑定

完成门区分环境：`测试通过但运行于 HostAudit 降级环境` vs `测试通过且运行于真实 Bubblewrap/Podman`。高风险任务要求 `minimumIsolation = container`，HostAudit 结果不满足该 Criterion。类型化 Criterion 包括：`sandbox_profile` / `sandbox_backend` / `sandbox_no_degradation` / `resource_limit_applied` / `network_isolated`。

只有后端真实运行、Receipt 摘要与请求/工作区/策略绑定、所需边界无降级，且
资源 attach 与 cleanup 被观测时，Criterion 才能通过。配置值、Mock、Skip、
0-step CI 或“后端已安装”都不是 Evidence。
