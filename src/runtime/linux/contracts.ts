/** LNXF-1.0: Linux execution foundation contracts (LF-1).
 *
 *  Data contracts per plan §7: LinuxCapabilities, ExecutionCellSpec,
 *  MountRule, SecretBinding, DomainResourceBudget, SandboxReceipt, plus the
 *  execution-domain / cell / scheduling / cache / port types. All specs are
 *  immutable-by-convention, serializable, hashable, replayable and traceable;
 *  model/tools can never submit a spec directly to a backend.
 */

// ── Capability probe (§7.1) ──

export interface CgroupCapabilities {
  version: 2 | 1 | 0
  mountPath?: string
  delegated: boolean
  delegationSource?: "systemd-user" | "systemd-system" | "container-runtime" | "manual"
  controllers: Array<"cpu" | "memory" | "pids" | "io" | "cpuset">
  supportsKill: boolean
  supportsFreeze: boolean
  supportsPressure: boolean
}

export interface NamespaceCapabilities {
  user: boolean
  mount: boolean
  pid: boolean
  ipc: boolean
  uts: boolean
  network: boolean
  cgroup: boolean
}

export interface LinuxCapabilities {
  schemaVersion: "1.0"
  platform: "linux"
  architecture: string
  kernelRelease: string
  bootId: string

  cgroup: CgroupCapabilities
  namespaces: NamespaceCapabilities

  bubblewrap: { available: boolean; path?: string; version?: string; unprivilegedUsable: boolean }
  podman: { available: boolean; path?: string; version?: string; rootlessReady: boolean; storageDriver?: string }
  landlock: { available: boolean; abi?: number; filesystemRules: boolean; tcpRules: boolean; udpRules: boolean }
  seccomp: { available: boolean; filterMode: boolean }

  filesystem: { tmpfs: boolean; overlayfs: boolean; fuseOverlayfs: boolean }
  systemd: { available: boolean; userManager: boolean; delegationSupported: boolean }

  /** 降级原因 —— 明确的字符串列表，禁止用评分掩盖。 */
  degradationReasons: string[]
}

// ── Capability request（工具/模型声明层，§7.3） ──

/** 工具/模型声明"需要什么"（Capability Request）——绝不提交完整 Spec。
 *
 *  身份字段由 Runtime 生成（编译器是唯一权威）；工具只能声明命令、Profile
 *  与显式需求。override 语义：只能收紧（更高隔离、更小资源），不能放宽。
 */
/** 不可信能力声明（R2 PR-9：INV-A/INV-B）。
 *  工具/模型只能声明能力和资源需求；身份、workspace、宿主路径
 *  全部由 TrustedExecutionAuthority 注入。禁止出现任何身份字段
 *  或宿主物理路径（绝对 cwd / worktreeRoot / ownerFiles）。 */
export interface UntrustedCapabilityRequest {
  command: {
    executable: string
    args: string[]
    /** 相对 AuthorizedWorkspace 的逻辑工作目录（默认 "."）。 */
    relativeCwd?: string
    stdin?: "closed" | "pipe"
  }
  profile: ExecutionProfile
  /** 网络需求：只能比 Profile 默认更严格（none ⊂ loopback ⊂ proxy-allowlist ⊂ full-approved）。 */
  network?: { mode: NetworkMode; allowedHosts?: string[]; allowedPorts?: number[] }
  /** 显式声明的环境变量（受拒绝规则约束，进入 requestedValues）。 */
  env?: Record<string, string>
  /** 显式批准的宿主环境键（唯一宿主继承通道；拒绝集内的键会被策略拒绝）。 */
  allowedHostKeys?: string[]
  timeoutMs?: number
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  memoryMaxBytes?: number
  pidsMax?: number
  /** LNXF-R2 9.3：请求挂载只允许两态 —— workspace-relative（工作区内
   *  相对路径）或 runtime-grant（Runtime 授予的挂载物，暂未开放）。
   *  禁止宿主绝对 source（PR-9 宿主路径漏洞不回归）。 */
  writableMounts?: RequestedMount[]
  readonlyMounts?: RequestedMount[]
  cache?: CacheMountRequest[]
}

/** 请求级挂载（模型声明需求；宿主路径由编译器权威解析，模型不可指定）。 */
export type RequestedMount =
  | {
      source: { type: "workspace-relative"; path: string }
      target: string
      mode: "ro" | "rw"
    }
  | {
      source: { type: "runtime-grant"; grantId: string }
      target: string
      mode: "ro"
    }

/** 授权工作区（R2 PR-9：INV-B）。由 WorkspaceAuthorityRegistry 注册生成，
 *  模型不可构造。workspaceId 由 canonical physical root 稳定生成。 */
export interface AuthorizedWorkspace {
  workspaceId: string
  /** LNXF-R2 9.2：物理冲突域键 —— 由 realpath + stat(dev,ino) 生成；
   *  bind-mount/软链接别名指向同一物理目录时键相同（单写者锁
   *  workspace-physical:<key>，防止 workspaceId 公式旁路）。 */
  physicalWorkspaceKey: string
  projectId: string
  /** realpath 后的物理根目录。 */
  hostRoot: string
  /** main/worktree/system。 */
  kind: "main" | "worktree" | "system"
  /** 是否允许写入。 */
  access: "readonly" | "readwrite"
  /** Runtime 分配的文件所有权。 */
  ownerFiles: readonly string[]
}

/** 可信执行身份（R2 PR-9：INV-A）。由 Runtime 生成，请求不得覆盖。 */
export interface TrustedExecutionIdentity {
  runId: string
  nodeRunId: string
  attempt: number
  agentId?: string
  assignmentId?: string
}

/** 可信执行权威 —— Linux enabled 执行的唯一身份/工作区来源。 */
export interface TrustedExecutionAuthority {
  identity: TrustedExecutionIdentity
  workspace: AuthorizedWorkspace
  domainId?: string
}

/** @deprecated R2 PR-9：已拆分 —— 能力声明见 UntrustedCapabilityRequest，
 *  身份/工作区见 TrustedExecutionAuthority。 */
export interface CapabilityRequest {
  command: { executable: string; args: string[]; cwd?: string; stdin?: "closed" | "pipe" }
  profile: ExecutionProfile
  network?: { mode: NetworkMode; allowedHosts?: string[]; allowedPorts?: number[] }
  env?: Record<string, string>
  allowedHostKeys?: string[]
  timeoutMs?: number
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  memoryMaxBytes?: number
  pidsMax?: number
  writableMounts?: MountRule[]
  readonlyMounts?: MountRule[]
  cache?: CacheMountRequest[]
  runId?: string
  nodeRunId?: string
  agentId?: string
  assignmentId?: string
  attempt?: number
}

/** LNXF-GATE-02 (B7)：统一清理动作 —— broker finally 按序执行并逐项
 *  记录结果（process → mounts → secrets → temp → cgroup → lease）。 */
export interface CleanupAction {
  kind: "process" | "mounts" | "secrets" | "temp" | "cgroup" | "lease" | "secret-file"
  name: string
  ok: boolean
  detail?: string
  at: number
}

/** LNXF-GATE-02 (B7)：secret 交付的生命周期记录（Receipt 审计）。 */
export interface SecretDeliveryRecord {
  leaseId: string
  runId?: string
  cellId?: string
  bindingId: string
  deliveryTarget?: string
  delivery: "sealed-file" | "file-descriptor" | "environment"
  expiresAt: number
  revokedAt?: number
  /** GS-11 语义：实际删除文件才算 verified；失败如实标记。 */
  cleanupVerified: boolean
}

/** 运行期物化材料 —— 不属于策略 Spec，编译完成后由 Runtime 生成并随
 *  上下文传入后端；禁止反向写回 ExecutionCellSpec（P0-1 修复）。 */
export interface ExecutionMaterialization {
  /** 运行期生成的 seccomp 文件路径（bwrap: BPF；podman: OCI JSON）。 */
  seccompFile?: string
  /** Secret 环境注入（bindSecrets 输出，delivery=environment）。 */
  secretEnv?: Record<string, string>
  /** Secret sealed 文件映射（target → 宿主文件）。 */
  secretFiles?: Record<string, string>
  /** 缓存宿主路径映射（target → 宿主源目录；Runtime 决定，模型不可指定）。 */
  cacheHostPaths?: Record<string, string>
  /** B7：secret 交付生命周期记录（dispose 后 revokedAt/cleanupVerified 落真值）。 */
  secretRecords?: SecretDeliveryRecord[]
  /** B7：统一清理动作登记表（dispose 执行时逐项回填 ok/detail）。 */
  cleanupActions?: CleanupAction[]
  /** C5（SECRET_TEMP_RESIDUE）：运行期物化宿主文件的统一清理回调
   *  （sealed secret 文件 + secret root + seccomp 文件；执行结束后调用，
   *  由 Broker 事务 finally 保证触发）。 */
  dispose?: () => void
}

// ── ExecutionCellSpec (§7.2) ──

export type ExecutionProfile = "inspect" | "build" | "test" | "dependency" | "service" | "untrusted" | "evolution"
export type IsolationMinimum = "audit" | "namespace" | "container"
export type BackendId = "host-audit" | "bubblewrap" | "rootless-podman"
export type NetworkMode = "none" | "loopback" | "proxy-allowlist" | "full-approved"

export interface MountRule {
  source: string
  target: string
  mode: "ro" | "rw"
  required: boolean
  recursive: boolean
  noExec?: boolean
  noDev?: boolean
  noSuid?: boolean
}

export interface TmpfsRule {
  target: string
  sizeBytes: number
  mode?: number
}

export interface SecretBinding {
  id: string
  purpose: string
  delivery: "sealed-file" | "file-descriptor" | "environment"
  target?: string
  allowedExecutable?: string
  expiresAt: number
  redactFromTrace: true
}

export interface CacheMountRequest {
  cacheId: string
  kind: "bun" | "npm" | "pnpm" | "typescript" | "repo-map" | "custom"
  key: string
  mode: "ro" | "rw-locked"
  target: string
}

export interface ExecutionCellSpec {
  schemaVersion: "1.0"
  identity: {
    cellId: string
    runId: string
    nodeRunId: string
    attempt: number
    agentId?: string
    assignmentId?: string
  }
  command: { executable: string; args: string[]; cwd: string; stdin: "closed" | "pipe" }
  profile: ExecutionProfile
  isolation: {
    minimum: IsolationMinimum
    preferredBackend: "auto" | "bubblewrap" | "podman" | "host-audit"
    allowDegradation: boolean
  }
  filesystem: {
    readonlyMounts: MountRule[]
    writableMounts: MountRule[]
    tmpfsMounts: TmpfsRule[]
    hiddenPaths: string[]
    emptyHome: boolean
    worktreeRoot?: string
    ownerFiles?: string[]
  }
  network: { mode: NetworkMode; allowedHosts?: string[]; allowedPorts?: number[] }
  environment: {
    variables: Record<string, string>
    /** 显式批准的宿主环境键（唯一宿主继承通道；拒绝集内的键会被策略拒绝）。 */
    allowedHostKeys?: string[]
    inheritHost: false
    locale: string
    pathEntries: string[]
  }
  secrets: SecretBinding[]
  resources: {
    /** LNXF-R2 10.2：CPU 资源记账单位（1000 = 1 核；ResourceLedger 唯一
     *  权威）。cgroup 物化由 cpuQuotaMicros/cpuPeriodMicros 表达。 */
    cpuMillis?: number
    cpuQuotaMicros?: number
    cpuPeriodMicros?: number
    cpuWeight?: number
    memoryHighBytes?: number
    memoryMaxBytes: number
    swapMaxBytes?: number
    ioWeight?: number
    readBpsMax?: number
    writeBpsMax?: number
    wallTimeMs: number
    stdoutMaxBytes: number
    stderrMaxBytes: number
    tmpfsMaxBytes: number
    maxOpenFiles?: number
    pidsMax: number
  }
  cache: CacheMountRequest[]
  lifecycle: {
    killOnParentExit: boolean
    cleanupOnExit: boolean
    retainOnFailure: boolean
    serviceMode: boolean
  }
  policyDigest: string
}

// ── Agent domain / Cell (§5) ──

export interface DomainResourceBudget {
  maxConcurrentCells: number
  cpuQuotaTotal: number
  memoryMaxBytes: number
  pidsMax: number
  maxWallTimeMs: number
  maxOutputBytes: number
  maxTempBytes: number
}

export interface AgentExecutionDomain {
  domainId: string
  runId: string
  agentId: string
  role?: string
  worktreeRoot: string
  ownerFiles: string[]
  cgroupPath: string
  tempRoot: string
  cacheNamespace: string
  resourceBudget: DomainResourceBudget
  createdAt: number
  status: "active" | "cancelling" | "closed" | "failed"
}

export type ExecutionCellState = "pending" | "waiting_resources" | "waiting_backend" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "blocked"

export interface ExecutionCell {
  cellId: string
  runId: string
  nodeRunId: string
  agentId?: string
  spec: ExecutionCellSpec
  state: ExecutionCellState
  receipt?: SandboxReceipt
}

// ── Receipt (§7.6) ──

export interface SandboxViolation {
  code: string
  message: string
  scope?: string
}

/** LR2-0（ADR-LR2-003）：观测三态 —— Receipt 只记录真实观测。
 *  - observed：实测值；
 *  - unsupported：平台/后端不支持该观测；
 *  - unknown：未测量/测量失败。
 *  未观测 ≠ 成功：任何"已验证"断言（receiptComplete、Evidence 绑定）都
 *  不得把 unknown/unsupported 当作成功事实。 */
export type Observed<T> =
  | { status: "observed"; value: T }
  | { status: "unsupported"; reason: string }
  | { status: "unknown"; reason: string }

export interface SandboxReceiptMetrics {
  cpuUsageUsec?: number
  cpuThrottledUsec?: number
  peakMemoryBytes?: number
  peakPids?: number
  readBytes?: number
  writeBytes?: number
}

export interface SandboxReceipt {
  schemaVersion: "1.0"
  /** Receipt 自摘要（完整 Outcome 的 sha256，PR-2；Evidence 绑定此值）。 */
  receiptDigest: string
  cellId: string
  runId: string
  nodeRunId: string
  attempt: number
  agentId?: string
  backend: BackendId
  backendVersion?: string
  profile: ExecutionProfile
  capabilitiesDigest: string
  cellSpecDigest: string
  filesystemPolicyDigest: string
  networkPolicyDigest: string
  resourcePolicyDigest: string
  startedAt: number
  finishedAt: number
  durationMs: number
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  oomKilled: boolean
  pidLimitHit: boolean
  outputLimitHit: boolean
  tempLimitHit: boolean
  /** LR2-0：观测三态（未测量必须 unknown，禁止空对象冒充完整 metrics）。 */
  metrics: Observed<SandboxReceiptMetrics>
  observedWrites: string[]
  observedDeletes: string[]
  unexpectedWrites: string[]
  networkMode: string
  secretBindingIds: string[]
  /** B7: 统一清理动作结果（process→mounts→secrets→temp→cgroup→lease）。 */
  cleanupActions?: CleanupAction[]
  /** B7: secret 交付生命周期记录（revokedAt/cleanupVerified 落真值）。 */
  secretRecords?: SecretDeliveryRecord[]
  violations: SandboxViolation[]
  degradationReasons: string[]
  /** PathGuard 快照有界性证据（OTS-004 事故后加）：跳过的大文件/预算超限/
   *  实际哈希字节数 —— 证明本 cell 的 PathGuard 未把超大文件全量读入
   *  Runtime 进程内存。只有 after 快照（对本 cell 写入内容负责的那份）。 */
  snapshotGuard?: {
    skippedLargeFiles: string[]
    budgetExceeded: boolean
    bytesHashed: number
  }
  cleanup: {
    processesRemaining: number
    mountsReleased: boolean
    cgroupRemoved: boolean
    containerRemoved?: boolean
    worktreeRetained: boolean
    /**
     * GATE（GS-11）：清理是否经真实验证。attach 未验证（进程从未进入
     * Cell cgroup）时不得宣称强保证 —— 空 cgroup 删除成功 ≠ 原进程
     * 已清理。
     */
    cleanupVerified: boolean
  }
}

// ── Scheduling (§12) ──

export interface ResourceRequest {
  cpuQuota: number
  memoryBytes: number
  pids: number
  ioWeight: number
  networkSlots: number
  tempBytes: number
}

export interface ResourceReservation {
  reservationId: string
  runId: string
  agentId?: string
  cellId: string
  requested: ResourceRequest
  granted: ResourceRequest
  createdAt: number
  releasedAt?: number
}

// ── Environment / secrets / ports (§15/§18) ──

export interface EnvironmentPolicy {
  baseProfile: "minimal" | "node" | "build" | "service"
  allowedHostKeys: string[]
  fixedValues: Record<string, string>
  requestedValues: Record<string, string>
  deniedKeys: string[]
}

export interface PortLease {
  leaseId: string
  runId: string
  cellId: string
  agentId?: string
  internalPort: number
  hostPort?: number
  bindAddress: "127.0.0.1"
  expiresAt: number
}

// ── Backend contract (§10 / backend-contract.md) ──

export interface BackendAvailability {
  id: BackendId
  available: boolean
  version?: string
  degradationReasons: string[]
}

export interface CompiledExecution {
  backend: BackendId
  /** 后端专属启动参数（Policy Compiler 唯一来源，模型不可见）。 */
  argv: string[]
  /** 额外环境变量（后端进程自身使用）。 */
  env: Record<string, string>
  /** 宿主侧 spawn 工作目录 —— 必须是真实存在的宿主目录
   *  （PR-4：与沙盒内部 cwd 分离；内部 cwd 由后端 argv 决定）。 */
  cwd: string
  /** bwrap seccomp BPF 文件：supervisor 以 FD 3 打开并传入（--seccomp 3）。 */
  seccompFdPath?: string
}

export interface BackendRunContext {
  /** 能力探测结果（Broker 缓存传入）。 */
  capabilities: LinuxCapabilities
  /** 宿主保留预留之外的资源账本引用（LF-5 接线）。 */
  resourceState?: unknown
}

export type ExecutionCellEvent =
  | { type: "cell.status"; cellId: string; state: ExecutionCellState; at: number }
  | { type: "cell.stdout"; cellId: string; data: string; at: number }
  | { type: "cell.stderr"; cellId: string; data: string; at: number }
  | { type: "cell.exit"; cellId: string; exitCode: number | null; signal: string | null; at: number }
  | { type: "cell.receipt"; cellId: string; receipt: SandboxReceipt; at: number }
