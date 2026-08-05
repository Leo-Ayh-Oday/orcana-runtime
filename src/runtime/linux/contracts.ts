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
  environment: { variables: Record<string, string>; inheritHost: false; locale: string; pathEntries: string[] }
  secrets: SecretBinding[]
  resources: {
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

export type ExecutionCellState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "blocked"

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

export interface SandboxReceipt {
  schemaVersion: "1.0"
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
  metrics: {
    cpuUsageUsec?: number
    cpuThrottledUsec?: number
    peakMemoryBytes?: number
    peakPids?: number
    readBytes?: number
    writeBytes?: number
  }
  observedWrites: string[]
  observedDeletes: string[]
  unexpectedWrites: string[]
  networkMode: string
  secretBindingIds: string[]
  violations: SandboxViolation[]
  degradationReasons: string[]
  cleanup: {
    processesRemaining: number
    mountsReleased: boolean
    cgroupRemoved: boolean
    containerRemoved?: boolean
    worktreeRetained: boolean
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
  cwd: string
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
