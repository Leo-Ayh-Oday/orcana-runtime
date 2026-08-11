/** LNXF-1.0: Linux execution broker (LF-1 骨架) — 单一执行入口（ADR-L1）。
 *
 *  LF-1 提供接口、能力缓存、shadow 记录器与 spec 编译门。
 *  R1: execute() 接线真实后端执行 + abortSignal 透传。
 *  R2: execute() 成为完整执行事务 ——
 *    编译 → 资源预留 → Isolation Lock → Agent Domain → Cell cgroup →
 *    启动后端 → attach 进程 → 流式事件 → 真实 Receipt（cgroup 指标 +
 *    清理验证）→ 清理 → 释放锁与资源。cancelCell/cancelAgent/cancelRun/
 *    cleanupRun 全部真实现（不再空壳）。
 */

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { CrossProcessWorkspaceLease } from "./workspace/workspace-lease"
import { spawnSync } from "node:child_process"
import { killProcessGroup } from "./process/termination"
import { processDead } from "./recovery/state-store"
import type {
  AgentExecutionDomain,
  CapabilityRequest,
  ExecutionCell,
  ExecutionCellEvent,
  ExecutionCellSpec,
  ExecutionMaterialization,
  LinuxCapabilities,
  SandboxReceipt,
  SecretDeliveryRecord,
  TrustedExecutionAuthority,
  UntrustedCapabilityRequest,
} from "./contracts"
import type { DomainResourceBudget } from "./contracts"
import { probeLinuxCapabilities, requireLinuxPlatform } from "./capability-probe"
import { compileCapabilityRequest, compileCapabilityRequestCached, compileCellSpec } from "./policy-compiler"
import { selectBackend } from "./backend-router"
import type { BackendSelection } from "./backend-router"
import { isStrictProfile } from "./profiles"
import { LinuxExecutionError } from "./errors"
import { createHostAuditBackend } from "./backends/host-audit"
import { createBubblewrapBackend } from "./backends/bubblewrap"
import { createPodmanBackend } from "./backends/podman"
import type { ExecutionBackend } from "./backends/backend"
import { ResourceLedger } from "./scheduler/resource-ledger"
import type { ResourceRequest } from "./contracts"
import { IsolationDomainLock } from "./workspace/isolation-lock"
import { AgentDomainManager } from "./workspace/agent-domain"
import { CgroupManager, hierarchyPaths } from "./cgroup/manager"
import { detectDelegatedRoot } from "./cgroup/delegation"
import { readCgroupMetrics as readMetrics } from "./cgroup/metrics"
import { RuntimeStateStore } from "./recovery/state-store"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeSeccompBpfFile } from "./seccomp-bpf"
import { writeOciSeccompFile } from "./seccomp-oci"
import { compileSeccompProfile } from "./landlock-seccomp"
import { bindSecrets } from "./secrets"
import { CacheManager } from "./workspace/cache-port"
import { countProcessGroup } from "./process/termination"
import { computeReceiptDigest } from "./receipt"

export interface ShadowExecutionRecord {
  cellId: string
  runId: string
  nodeRunId: string
  profile: ExecutionCellSpec["profile"]
  backend: BackendSelection["backend"]
  degradationReasons: string[]
  compiled: boolean
  executed: "legacy" // LF-1: shadow 模式仍由旧路径执行
  recordedAt: number
}

export interface LinuxBrokerOptions {
  /** shadow = 编译 spec + 记录后端选择，仍走旧执行路径（LF-1）。 */
  mode: "shadow" | "enabled" | "enforced"
  /** Deterministic capability fixture for tests. Rejected unless
   *  NODE_ENV=test; production always uses the live probe. */
  testCapabilities?: LinuxCapabilities
  onShadow?: (record: ShadowExecutionRecord) => void
  /** R2: 注入 cgroup 管理器（无委托时 Broker 自动降级为无 cgroup）。 */
  cgroup?: CgroupManager
  /** R2: 注入资源账本（默认宿主预留 + 6 并发 Cell）。 */
  ledger?: ResourceLedger
  /** R2: 状态持久化（默认 ~/.orcana/runtime/linux）。 */
  stateStore?: RuntimeStateStore
  /** 缓存宿主根（CacheManager 权威路径；默认 stateStore root/cache）。 */
  cacheRoot?: string
  /** Secret 值来源（Runtime 持有，模型不可见；未提供时环境注入为空）。 */
  secretValues?: Record<string, string>
  /** PR-7: 已批准镜像策略（digest 全串或 registry 前缀；命中才允许 podman 执行）。 */
  approvedImages?: string[]
  /** LR2-2（P2-D）：Sandbox Plan Cache —— 同 workspace 同策略请求跳过
   *  完整 Policy Compiler（命中注入新身份）。 */
  planCache?: import("./cache/plan-cache").PlanCache
  /** IC02: 确定性 fault/barrier 注入（仅 NODE_ENV=test；production
   *  传入即抛错，同 testCapabilities 模式）。 */
  testHooks?: BrokerTestHooks
}

/** IC02: acquisition 事务内的确定性 fault checkpoint。
 *  NODE_ENV=test 时由 testHooks.faultAt 抛错 / waitAt 等待（barrier）。 */
export type BrokerFaultPoint =
  | "after-register-starting"
  | "materialize-internal"
  | "after-materialize"
  | "before-lock"
  | "after-lock"
  | "before-create-run"
  | "after-create-run"
  | "after-create-agent"
  | "before-create-cell"
  | "after-create-cell"
  | "before-backend-run"

export interface BrokerTestHooks {
  /** 在 checkpoint 抛错（确定性故障注入）。返回 Error → 抛；undefined → 继续。 */
  faultAt?: (point: BrokerFaultPoint) => Error | void
  /** 在 checkpoint 等待（cancel-during-starting barrier；不得含随机 sleep）。 */
  waitAt?: (point: BrokerFaultPoint) => Promise<void> | void
}

/** IC02: acquisition truth —— 资源所有权/清理的唯一真相。
 *
 *  每个资源一旦 acquire 成功，必须在下一个可能 throw 的操作之前写入本记录；
 *  cleanupAcquired 只读本记录做释放。cellRuns registry 不是 cleanup 依赖。
 */
export interface BrokerAcquiredResources {
  runId: string
  cellId: string
  agentId?: string
  backendId: string
  /** ledger.reserve 成功后写入（清理时 ledger.release，绝不从 registry 找）。 */
  reservationId?: string
  lockKeys: string[]
  /** CrossProcessWorkspaceLease 释放回调（跨进程写互斥）。 */
  leaseRelease?: () => void
  cgroupRunPath?: string
  cgroupAgentPath?: string
  cgroupCellPath?: string
  /** run 层属于 broker-managed hierarchy（无 AgentDomain 时整个 run/agent
   *  层都由 Broker Cell 管理）。任一 Cell 成为最后使用者时都可清理 ——
   *  last-user cleanup（creator 先退不残留：并行 Cell 存在时不删，
   *  最后使用者回收）。AgentDomain parent（domain.cgroupPath）→ false，
   *  Broker Cell 永不删。 */
  cgroupRunBrokerManaged: boolean
  /** agent 层属于 broker-managed hierarchy（语义同 run 层）。 */
  cgroupAgentBrokerManaged: boolean
  podmanCidfile?: string
  materialization?: ExecutionMaterialization
  controller: AbortController
  spawnedPid?: number
  cleanupStarted: boolean
}

type CellRunPhase = "starting" | "running" | "cleaning"

interface CellRunRecord {
  runId: string
  agentId?: string
  phase: CellRunPhase
  acquired: BrokerAcquiredResources
}

/** PR-6：统一 ExecutionRuntimeContext —— Graph 调度 / ProcessExecutor /
 *  Broker 共享同一套资源权威（单账本、单锁、单缓存、单状态存储）。 */
export interface ExecutionRuntimeContext {
  ledger: ResourceLedger
  locks: IsolationDomainLock
  domainManager: AgentDomainManager
  cacheManager: CacheManager
  stateStore: RuntimeStateStore
}

export interface ExecuteOptions {
  /** 取消信号（透传到后端 runSupervised）。 */
  abortSignal?: AbortSignal
  /** 指定 Agent Domain（多 Agent 执行身份投影，R4 接线）。 */
  domain?: AgentExecutionDomain
  /** R2 PR-9: 可信执行权威（executeRequest 传入；enabled 下必填）。 */
  authority?: TrustedExecutionAuthority
  /** LNXF-R2 9.5: full-approved 网络的人工批准凭证 —— 由调用方（UI/
   *  人工确认路径）显式授予，Receipt 记录批准事实。缺省拒绝。 */
  approvedNetwork?: boolean
}

export interface LinuxExecutionBroker {
  probe(options?: { refresh?: boolean }): LinuxCapabilities
  /** 编译并校验一个执行 spec（Policy Compiler 唯一入口）。 */
  compileSpec(spec: ExecutionCellSpec): ExecutionCellSpec
  /** Capability Request + 可信权威 → 冻结 Spec（R2 PR-9：身份/工作区只来自
   *  authority；enabled 模式缺 authority 即 fail-closed）。 */
  compileRequest(request: UntrustedCapabilityRequest, authority?: TrustedExecutionAuthority): ExecutionCellSpec
  /** 选择后端（不执行）。 */
  selectBackendFor(spec: ExecutionCellSpec): BackendSelection
  /** Shadow：记录拟用 spec/后端，不执行。 */
  shadow(spec: ExecutionCellSpec): ShadowExecutionRecord
  /** 执行（R2: 完整事务）。 */
  execute(spec: ExecutionCellSpec, options?: ExecuteOptions): AsyncIterable<ExecutionCellEvent>
  /** 执行 Untrusted Capability Request（编译 → 执行）。 */
  executeRequest(request: UntrustedCapabilityRequest, options?: ExecuteOptions): AsyncIterable<ExecutionCellEvent>
  createAgentDomain(input: { runId: string; agentId: string; worktreeRoot: string; ownerFiles: string[]; resourceBudget: DomainResourceBudget; role?: string }): AgentExecutionDomain
  cancelCell(cellId: string): Promise<void>
  cancelAgent(agentId: string): Promise<void>
  cancelRun(runId: string): Promise<void>
  cleanupRun(runId: string): Promise<{ removed: number; servicesCleaned: number; portsCleaned: number }>
  /** R2: 当前运行中 Cell（诊断/测试）。 */
  activeCells(): ExecutionCell[]
  /** R2: 资源账本（调度接入）。 */
  ledger(): ResourceLedger
  /** PR-6: 统一运行时上下文（Graph 调度与 Broker 共享单一账本/锁/缓存）。 */
  runtimeContext(): ExecutionRuntimeContext
  /** execd v2（L2-A）：cgroup 委托基路径（无委托 → undefined）。
   *  供执行句柄记录计算 cell 专属 cgroup 路径。 */
  cgroupBase(): string | undefined
}

/** 全进程共享的 broker 实例（能力探测缓存）。 */
let shared: LinuxExecutionBroker | null = null

/** 已注册后端实现（仅 backends/ 目录可注册）。 */
const backendImplementations: Record<string, ExecutionBackend> = {
  "host-audit": createHostAuditBackend(),
  "bubblewrap": createBubblewrapBackend(),
  "rootless-podman": createPodmanBackend(),
}

export function registerBackend(backend: ExecutionBackend): void {
  backendImplementations[backend.id] = backend
}

function backendOf(id: string): ExecutionBackend | undefined {
  return backendImplementations[id]
}

function resourceRequestOf(spec: ExecutionCellSpec): ResourceRequest {
  return {
    // LNXF-R2 10.2：CPU 记账统一 cpuMillis（1000 = 1 核）——
    // 旧换算（quotaMicros/10000 vs ledger cores×10000）相差 1000 倍，
    // 使 CPU 维度 overcommit 拒绝形同虚设。
    cpuQuota: spec.resources.cpuMillis ?? 1000,
    memoryBytes: spec.resources.memoryMaxBytes,
    pids: spec.resources.pidsMax,
    ioWeight: spec.resources.ioWeight ?? 0,
    networkSlots: spec.network.mode === "full-approved" ? 1 : 0,
    tempBytes: spec.resources.tmpfsMaxBytes,
  }
}

export function createLinuxBroker(options: LinuxBrokerOptions): LinuxExecutionBroker {
  const mode = options.mode
  if (options.testCapabilities && process.env.NODE_ENV !== "test") {
    throw new Error("test capability injection requires NODE_ENV=test")
  }
  if (options.testHooks && process.env.NODE_ENV !== "test") {
    throw new Error("test hook injection requires NODE_ENV=test")
  }
  const caps = options.testCapabilities ?? requireLinuxPlatform()
  const shadowRecords: ShadowExecutionRecord[] = []
  const cells = new Map<string, ExecutionCell>()
  const cellRuns = new Map<string, CellRunRecord>()

  /** IC02: deterministic fault/barrier checkpoint —— NODE_ENV=test 时才可能
   *  生效（options.testHooks 构造时已校验）；production 语义不受影响。 */
  const checkpoint = async (point: BrokerFaultPoint): Promise<void> => {
    if (process.env.NODE_ENV !== "test") return
    const hooks = options.testHooks
    if (!hooks) return
    const error = hooks.faultAt?.(point)
    if (error) throw error
    await hooks.waitAt?.(point)
  }

  /** IC02: run 当前 Cell ID 集合（run.json.cells 的真实 Cell identity，
   *  绝不写 runId —— RUN_STATE_CELL_ID_CORRUPTION = 0）。 */
  const runCellIds = (runId: string): string[] => {
    const ids: string[] = []
    for (const [cellId, record] of cellRuns) {
      if (record.runId === runId) ids.push(cellId)
    }
    return ids
  }

  const ledger = options.ledger ?? new ResourceLedger()
  const stateStore = options.stateStore ?? new RuntimeStateStore()
  const domainManager = new AgentDomainManager({ ledger })
  // GATE（GS-13）：跨进程 workspace lease（mkdir 原子锁）。
  const workspaceLease = new CrossProcessWorkspaceLease()
  const cacheManager = new CacheManager(options.cacheRoot ?? join(stateStore.capabilitiesPath(), "..", "cache"))

  // cgroup：仅在有真实委托时启用（无委托 → cgroupPath 为空，严格任务已在
  // selectBackend 层拒绝；P0-4 修复前绝不假装资源限制生效）。
  const delegated = detectDelegatedRoot()
  // 单元测试默认不接入宿主真实 cgroup：测试必须显式注入 mock manager；
  // 真实内核路径由 cgroup.test 与 eval:linux 的 delegated lane 覆盖。这样
  // 测试超时/进程中断不会在宿主留下 run-* 空目录。
  const autoCgroup = process.env.NODE_ENV !== "test" && caps.cgroup.delegated && delegated.writable
    ? new CgroupManager({ base: delegated.base })
    : undefined
  const cgroup = options.cgroup ?? autoCgroup
  const locks = new IsolationDomainLock()

  const compileOrThrow = (spec: ExecutionCellSpec): ExecutionCellSpec => {
    const compiled = compileCellSpec(spec)
    if (!compiled.ok) {
      throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `spec invalid: ${compiled.errors.join("; ")}`)
    }
    return compiled.spec
  }

  /** 运行期物化：seccomp 文件、secret 注入、缓存宿主路径。
   *  P0-1 修复：绝不写回 compiled spec —— 策略 Spec 在编译后冻结。
   *  PR-7：seccomp 按后端协议生成（bwrap=raw BPF；podman=OCI JSON）；
   *  sealed-file secrets 生成宿主文件并登记挂载目标；cidfile 登记供清理。
   *  IC02（P0-2 复审）：自身 exception-safe —— materialization 创建后
   *  立即定义 dispose，任一步骤（seccomp/secret/cache hostPath）抛错即
   *  rollback 已产生的临时材料后 rethrow；调用方拿不到 materialization
   *  也绝无临时残留。 */
  const materializeExecution = async (spec: ExecutionCellSpec, backendId: string): Promise<ExecutionMaterialization> => {
    const materialization: ExecutionMaterialization = {
      // B7：统一清理动作登记表 —— dispose 执行时逐项回填 ok/detail。
      cleanupActions: [],
    }
    // C5：sealed secret 的清理回调（删文件 + 空 root 目录）；环境注入类无文件。
    let secretCleanup: (() => void) | undefined
    // IC02：尽早建立 rollback —— 后续步骤抛错时 dispose 已可调用。
    materialization.dispose = () => {
      const actions = materialization.cleanupActions ?? []
      // temp：seccomp 宿主文件（best-effort，结果如实记录）。
      if (materialization.seccompFile) {
        try {
          rmSync(materialization.seccompFile, { force: true })
          actions.push({ kind: "temp", name: "seccomp-file", ok: true, at: Date.now() })
        } catch (error) {
          actions.push({ kind: "temp", name: "seccomp-file", ok: false, detail: error instanceof Error ? error.message : String(error), at: Date.now() })
        }
      }
      // secrets：逐文件删除并验证（cleanupVerified 真值 —— 失败如实标记，
      // 不因 best-effort 伪装干净）。
      for (const record of materialization.secretRecords ?? []) {
        if (record.deliveryTarget) {
          try {
            rmSync(record.deliveryTarget, { force: true })
            record.cleanupVerified = !existsSync(record.deliveryTarget)
          } catch {
            record.cleanupVerified = false
          }
          record.revokedAt = Date.now()
        } else {
          // environment 交付无文件 —— 撤销即记录时间戳。
          record.revokedAt = Date.now()
          record.cleanupVerified = true
        }
        actions.push({
          kind: "secret-file",
          name: record.bindingId,
          ok: record.cleanupVerified,
          at: record.revokedAt ?? Date.now(),
        })
      }
      // 兜底：secret root 空目录清理（C5）。
      try {
        secretCleanup?.()
        actions.push({ kind: "secrets", name: "secret-root", ok: true, at: Date.now() })
      } catch (error) {
        actions.push({ kind: "secrets", name: "secret-root", ok: false, detail: error instanceof Error ? error.message : String(error), at: Date.now() })
      }
    }
    // IC02：任一步骤抛错 → rollback 已产生材料 → rethrow。
    const rollbackOnError = (error: unknown): never => {
      try { materialization.dispose?.() } catch { /* best-effort */ }
      throw error
    }
    try {
      if ((backendId === "bubblewrap" || backendId === "rootless-podman")
        && (spec.profile === "inspect" || spec.profile === "untrusted")) {
        try {
          const target = spec.profile === "untrusted" ? "untrusted" : "inspect"
          if (backendId === "bubblewrap") {
            const filePath = join(tmpdir(), `orcana-seccomp-${spec.identity.cellId}.bpf`)
            writeSeccompBpfFile(compileSeccompProfile(target), filePath)
            materialization.seccompFile = filePath
          } else {
            const filePath = join(tmpdir(), `orcana-seccomp-${spec.identity.cellId}.json`)
            writeOciSeccompFile(compileSeccompProfile(target), filePath)
            materialization.seccompFile = filePath
          }
        } catch {
          // seccomp 不可用（非 x86_64 等）→ 降级原因记录，不阻断。
        }
      }
      if (spec.secrets.length > 0) {
        const bound = bindSecrets({ bindings: spec.secrets, values: options.secretValues ?? {} })
        if (!bound.ok) {
          // C5：失败路径同样清理 —— 部分 binding 可能在校验失败前已写入文件。
          bound.cleanup()
          throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `secret binding failed: ${bound.errors.join("; ")}`)
        }
        materialization.secretEnv = bound.envInjections
        // PR-7：sealed-file 交付 → 宿主文件真实挂载进沙盒/容器。
        const secretFiles: Record<string, string> = {}
        const secretRecords: SecretDeliveryRecord[] = []
        for (const item of bound.bound) {
          if (item.deliveryTarget) {
            const target = item.binding.target ?? `/run/secrets/${item.binding.id}`
            secretFiles[target] = item.deliveryTarget
          }
          // B7：交付生命周期记录（Receipt 审计；dispose 后落 revokedAt/verified）。
          secretRecords.push({
            leaseId: item.binding.id,
            runId: spec.identity.runId,
            cellId: spec.identity.cellId,
            bindingId: item.binding.id,
            deliveryTarget: item.deliveryTarget,
            delivery: item.binding.delivery,
            expiresAt: item.binding.expiresAt,
            cleanupVerified: false,
          })
        }
        materialization.secretFiles = secretFiles
        materialization.secretRecords = secretRecords
        // C5：文件不在此处清理 —— 统一由 dispose（execute 事务 finally）调用，
        // 保证执行结束（含异常/取消路径）后 /tmp 无密钥残留。
        secretCleanup = bound.cleanup
        // IC02：checkpoint —— sealed secret 材料已生成、cache 步骤之前。
        // 此处抛错（faultAt）→ rollbackOnError 清理 secret 文件后 rethrow。
        await checkpoint("materialize-internal")
      }
      for (const cache of spec.cache) {
        materialization.cacheHostPaths = {
          ...materialization.cacheHostPaths,
          [cache.target]: cacheManager.hostPath(cache),
        }
      }
      return materialization
    } catch (error) {
      return rollbackOnError(error)
    }
  }

  /** PR-7: approved image policy —— 命中已批准列表才允许 podman 执行。 */
  const approvedImage = (image: string): boolean => {
    const policy = options.approvedImages ?? []
    if (policy.length === 0) return false
    return policy.some(entry => image === entry || image.startsWith(entry))
  }

  /** PR-7: podman 容器按 label/cidfile 停止（后端特异清理）。 */
  const podmanCleanup = (runId: string, cellId: string, cidfile: string | undefined): void => {
    // shadow 模式不管理真实容器 —— 跳过 podman 兜底（避免 WSL 上
    // podman ps 的 10s 级慢调用拖垮 cleanup 路径）。
    if (mode === "shadow") return
    const podmanPath = caps.podman.path ?? "podman"
    // 1. cidfile：直接停止残留容器（--rm 未生效的异常路径）。
    if (cidfile) {
      try {
        const cid = readFileSyncSafe(cidfile)
        if (cid.trim()) {
          spawnSync(podmanPath, ["rm", "-f", cid.trim()], { stdio: "ignore", timeout: 10_000 })
        }
      } catch {
        // cidfile 不存在 = 容器从未启动
      }
    }
    // 2. label 兜底：按 run/cell 标签清理。
    try {
      const listed = spawnSync(podmanPath, ["ps", "-a", "-q", "--filter", `label=io.orcana.run=${runId}`, "--filter", `label=io.orcana.cell=${cellId}`], { encoding: "utf8", timeout: 15_000 })
      if (listed.status === 0 && listed.stdout.trim()) {
        spawnSync(podmanPath, ["rm", "-f", ...listed.stdout.trim().split(/\s+/)], { stdio: "ignore", timeout: 15_000 })
      }
    } catch {
      // podman 不可用
    }
  }

  function readFileSyncSafe(path: string): string {
    return readFileSync(path, "utf8")
  }

  /** IC02: 统一 cleanup routine —— 以 acquired 为唯一资源真相，幂等，
   *  任一步 throw 不跳过后续释放，输出 cleanup outcome 供 Receipt 使用。
   *
   *  固定顺序（与 IC02 计划 §11 一致）：
   *  abort/kill → backend → cgroup → locks/lease → reservation →
   *  materialization.dispose → receipt 持久化（失败不阻断）→ registry。
   */
  const cleanupAcquired = (
    acquired: BrokerAcquiredResources,
    ctx: {
      cellReceipt?: SandboxReceipt
      attachFailure?: string
      attachVerified: boolean
      compiled: ExecutionCellSpec
    },
  ): { cgroupRemoved: boolean; receiptPersisted: boolean } => {
    if (acquired.cleanupStarted) return { cgroupRemoved: false, receiptPersisted: false }
    acquired.cleanupStarted = true
    const record = cellRuns.get(acquired.cellId)
    if (record) record.phase = "cleaning"

    // 1. abort / kill —— AbortController 是主取消通道；cgroup.kill 是
    //    树级兜底（仅进程已知时）。
    acquired.controller.abort()
    if (cgroup && acquired.cgroupCellPath && acquired.spawnedPid) {
      try { cgroup.kill(acquired.cgroupCellPath) } catch { /* best-effort */ }
    }

    // 2. backend cleanup（podman cidfile + label 残留容器）。
    if (acquired.podmanCidfile) {
      podmanCleanup(acquired.runId, acquired.cellId, acquired.podmanCidfile)
      try { rmSync(acquired.podmanCidfile, { force: true }) } catch { /* best-effort */ }
    }

    // 3. cgroup cleanup：intended paths（调用前记录）为清理目标 ——
    //    createXxx 部分创建后抛错同样能移除。
    //    - cell：总是尝试（cell-<cellId> 专属本 cell，无共享风险）。
    //    - agent/run：仅 broker-managed hierarchy（无 AgentDomain）——
    //      任一 Cell 作为最后使用者（registry 中无其它 Cell 使用该
    //      parent）时回收；不要求是创建者（last-user ownership：
    //      creator 先退时并行 Cell 仍在 → 不删；最后 Cell 回收共享
    //      parent，零残留）。AgentDomain parent 永不删。
    let cgroupRemoved = false
    if (cgroup && acquired.cgroupCellPath) {
      try {
        cgroupRemoved = cgroup.removeCell(acquired.cgroupCellPath)
      } catch {
        cgroupRemoved = false
      }
    }
    if (cgroup && acquired.cgroupAgentBrokerManaged && acquired.cgroupAgentPath) {
      const otherCellInAgent = [...cellRuns.values()].some(r =>
        r.acquired.cgroupAgentPath === acquired.cgroupAgentPath
        && r.acquired.cellId !== acquired.cellId
        && !!r.acquired.cgroupCellPath,
      )
      if (!otherCellInAgent) {
        try { cgroup.removeRun(acquired.cgroupAgentPath) } catch { /* best-effort */ }
      }
    }
    if (cgroup && acquired.cgroupRunBrokerManaged && acquired.cgroupRunPath) {
      const otherCellInRun = [...cellRuns.values()].some(r =>
        r.runId === acquired.runId
        && r.acquired.cellId !== acquired.cellId
        && !!r.acquired.cgroupCellPath,
      )
      if (!otherCellInRun) {
        try { cgroup.removeRun(acquired.cgroupRunPath) } catch { /* best-effort */ }
      }
    }

    // 4. locks / workspace lease —— 无条件释放（acquired 内真相）。
    for (const key of acquired.lockKeys) {
      try { locks.release(key, acquired.cellId) } catch { /* best-effort */ }
    }
    try { acquired.leaseRelease?.() } catch { /* best-effort */ }

    // 5. reservation —— 从 acquired 释放，绝不从 registry 找。
    if (acquired.reservationId) {
      try { ledger.release(acquired.reservationId) } catch { /* best-effort */ }
    }

    // 6. materialization dispose（seccomp/sealed-secret/cache 宿主材料）——
    //    先于 receipt 组装（cleanupActions/secretRecords 回填进 Receipt）。
    try { acquired.materialization?.dispose?.() } catch { /* best-effort */ }

    // 7. receipt 组装 + 持久化 —— 成功或失败都不阻止 registry removal
    //    （IC02 §12：persistence failure 不重新造成 resource leak）。
    let receiptPersisted = false
    if (ctx.cellReceipt) {
      // GATE（GS-11）：清理真值 —— 空 cgroup 删除成功 ≠ 原进程已清理。
      // attach 已验证且空 cgroup 移除 → 0 残留；attach 未验证（进程
      // 从未进入 Cell，或 WSL2 EACCES 等）→ processesRemaining=-1 /
      // cleanupVerified=false，绝不谎报 0。
      const cleanupVerified = ctx.attachVerified && cgroupRemoved
      const processesRemaining = cleanupVerified
        ? 0
        : ctx.attachVerified
          ? ctx.cellReceipt.cleanup.processesRemaining
          : -1
      // 最终 Receipt：合并真实清理结果 + attach 失败降级，重算自摘要后持久化。
      // B7：统一清理动作结果 + secret 交付生命周期记录随 Receipt 审计。
      const finalReceipt: SandboxReceipt = {
        ...ctx.cellReceipt,
        degradationReasons: ctx.attachFailure
          ? [...ctx.cellReceipt.degradationReasons, ctx.attachFailure]
          : ctx.cellReceipt.degradationReasons,
        cleanup: {
          ...ctx.cellReceipt.cleanup,
          cgroupRemoved: cgroupRemoved || ctx.cellReceipt.cleanup.cgroupRemoved,
          processesRemaining,
          cleanupVerified,
        },
        cleanupActions: acquired.materialization?.cleanupActions,
        secretRecords: acquired.materialization?.secretRecords,
      }
      const final: SandboxReceipt = {
        ...finalReceipt,
        receiptDigest: computeReceiptDigest(finalReceipt),
      }
      const cellRef = cells.get(acquired.cellId)
      if (cellRef) cellRef.receipt = final
      try {
        stateStore.appendReceipt(acquired.runId, final)
        receiptPersisted = true
      } catch {
        // 持久化失败不阻断释放（Receipt 仍在事件流中）；记录 degradation。
      }
    }

    // 8. registry removal —— 最后阶段。
    cellRuns.delete(acquired.cellId)
    cells.delete(acquired.cellId)

    return { cgroupRemoved, receiptPersisted }
  }

  // PR-7：进程启动时钟 tick（/proc/<pid>/stat 第 22 字段）——PID 复用安全
  // 的 owner 身份（同 boot 崩溃恢复判定依据）。
  function readProcStartTicks(): number {
    try {
      const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8")
      const closeParen = stat.lastIndexOf(")")
      if (closeParen < 0) return 0
      const fields = stat.slice(closeParen + 1).trim().split(/\s+/)
      return Number(fields[19] ?? 0)
    } catch {
      return 0
    }
  }

  const readCellMetrics = (cgroupCellPath: string): SandboxReceipt["metrics"] => {
    // LR2-0（ADR-LR2-003）：未观测必须 unknown —— 空对象不得冒充完整
    // metrics（原实现无委托/读取失败时返回 {}，被当作完整 Receipt）。
    if (!cgroup || !cgroupCellPath) {
      return { status: "unknown", reason: "no cgroup delegation" }
    }
    try {
      const metrics = readMetrics(cgroupCellPath, cgroup.fs)
      return {
        status: "observed",
        value: {
          cpuUsageUsec: metrics.cpuUsageUsec,
          cpuThrottledUsec: metrics.cpuThrottledUsec,
          peakMemoryBytes: metrics.peakMemoryBytes,
          peakPids: metrics.peakPids,
        },
      }
    } catch {
      return { status: "unknown", reason: "cgroup metrics read failed" }
    }
  }

  return {
    probe(opts) {
      return options.testCapabilities ?? probeLinuxCapabilities(opts)
    },
    compileSpec: compileOrThrow,
    compileRequest(request, authority) {
      if (mode === "enabled" && !authority) {
        throw new LinuxExecutionError("EXECUTION_AUTHORITY_MISSING", "enabled execution requires a TrustedExecutionAuthority")
      }
      // LR2-2（P2-D）：Plan Cache 命中跳过完整编译（workspace 限定键）。
      const wsIdentity = authority ? workspaceIdentityOf(authority.workspace.hostRoot) : undefined
      const compiled = authority
        ? (options.planCache
            ? compileCapabilityRequestCached(request, authority, options.planCache, wsIdentity)
            : compileCapabilityRequest(request, authority))
        : compileCapabilityRequest(request, testAuthorityFallback())
      if (!compiled.ok) {
        throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `request invalid: ${compiled.errors.join("; ")}`)
      }
      return compiled.spec
    },
    async *executeRequest(request, executeOptions) {
      yield* this.execute(this.compileRequest(request, executeOptions?.authority), executeOptions)
    },
    selectBackendFor(spec) {
      return selectBackend(spec, caps)
    },
    shadow(spec) {
      const compiled = compileOrThrow(spec)
      let selection: BackendSelection
      try {
        selection = selectBackend(compiled, caps)
      } catch (error) {
        selection = {
          backend: "host-audit",
          degradationReasons: [error instanceof Error ? error.message : String(error)],
        }
      }
      const record: ShadowExecutionRecord = {
        cellId: compiled.identity.cellId,
        runId: compiled.identity.runId,
        nodeRunId: compiled.identity.nodeRunId,
        profile: compiled.profile,
        backend: selection.backend,
        degradationReasons: selection.degradationReasons,
        compiled: true,
        executed: "legacy",
        recordedAt: Date.now(),
      }
      shadowRecords.push(record)
      options.onShadow?.(record)
      return record
    },
    async *execute(spec, executeOptions) {
      if (options.mode === "shadow") {
        this.shadow(spec)
        return
      }
      let compiled = compileOrThrow(spec)
      // PR-7: podman 镜像策略校验先于一切后端选择/可用性 —— 声明了容器镜像
      // 就必须命中已批准列表（digest 锁定 + 审批表；无 podman 机器同样 fail-closed）。
      {
        const image = compiled.environment.variables["ORCANA_IMAGE"] ?? ""
        if (image && !approvedImage(image)) {
          throw new LinuxExecutionError("IMAGE_NOT_APPROVED", `image "${image}" is not in the approved image policy`)
        }
      }
      // LNXF-R2 9.5：full-approved 网络必须经人工批准（ADR-L7 承诺的
      // 运行时门，此前只有注释）；未批准即 fail-closed。
      if (compiled.network.mode === "full-approved" && !executeOptions?.approvedNetwork) {
        throw new LinuxExecutionError("NETWORK_APPROVAL_REQUIRED", "network mode full-approved requires explicit human approval (approvedNetwork)")
      }
      // P0-2：隔离后端不可用时的显式降级通道 —— 只有非严格 Profile
      // （allowDegradation=true）允许经编译器重编译到 minimum=audit；
      // 严格 Profile 在 selectBackend 直接抛 DEGRADATION_NOT_ALLOWED。
      try {
        selectBackend(compiled, caps)
      } catch (error) {
        if (!compiled.isolation.allowDegradation) throw error
        const downgraded = compileCellSpec({
          ...compiled,
          policyDigest: "", // 重编译：digest 由编译器重新计算
          isolation: { ...compiled.isolation, minimum: "audit" },
        })
        if (!downgraded.ok) throw error
        compiled = downgraded.spec
        selectBackend(compiled, caps)
      }
      const selection = selectBackend(compiled, caps)
      const backend = backendOf(selection.backend)
      if (!backend) {
        throw new LinuxExecutionError("PROCESS_START_FAILED", `no backend implementation for "${selection.backend}"`)
      }
      const violations = backend.validateSpec(compiled)
      if (violations.length > 0) {
        throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `backend ${backend.id} rejects spec: ${violations.join("; ")}`)
      }

      const cellId = compiled.identity.cellId
      const runId = compiled.identity.runId
      const agentId = compiled.identity.agentId ?? executeOptions?.domain?.agentId
      // PR-7: podman cidfile 进入停止/恢复逻辑。
      const podmanCidfile = selection.backend === "rootless-podman"
        ? `/tmp/orcana-${runId}-${cellId}.cid`
        : undefined

      // ── IC02: acquisition transaction —— 唯一 acquisition truth ──
      // 资源 acquire 成功 → 立即写入 acquired；cleanupAcquired 只读 acquired。
      // 绝不等待 cellRuns.set 之后才有 cleanup 真相（pre-registration failure
      // window 内抛错同样完整释放）。
      const acquired: BrokerAcquiredResources = {
        runId,
        cellId,
        agentId,
        backendId: selection.backend,
        lockKeys: [],
        cgroupRunBrokerManaged: false,
        cgroupAgentBrokerManaged: false,
        podmanCidfile,
        controller: new AbortController(),
        cleanupStarted: false,
      }
      // PR-3 + IC02：Cell 专属 AbortController 尽早创建并接线 —— cancel 在
      // acquisition 阶段即可达（starting cancellation 的主通道）。
      if (executeOptions?.abortSignal) {
        if (executeOptions.abortSignal.aborted) {
          acquired.controller.abort()
        } else {
          executeOptions.abortSignal.addEventListener("abort", () => acquired.controller.abort(), { once: true })
        }
      }

      // PR-2：捕获后端 Receipt（真实执行证据），cleanup 中持久化并合并清理真值。
      let cellReceipt: SandboxReceipt | undefined
      // PR-5：attach 失败不再吞掉 —— 记入 Receipt degradation（fail-closed 审计）。
      let attachFailure: string | undefined
      // GATE（GS-11）：attach 后必须验证真实 membership —— 仅"attach 调用
      // 未抛错"不算验证成功（WSL2 EACCES 等场景 attach 可能静默空操作）。
      let attachVerified = false

      // ── starting visibility（acquisition 期间 cancelCell/cancelAgent 可达）──
      // 从 registration 起即进入 try/finally —— after-register-starting 等
      // checkpoint 抛错也由 cleanupAcquired 收尾（registry removal 统一）。
      try {
        cellRuns.set(cellId, { runId, agentId, phase: "starting", acquired })
        await checkpoint("after-register-starting")
        const requested = resourceRequestOf(compiled)
        const reservation = ledger.reserve(requested, runId, cellId, agentId)
        if (!reservation.ok) {
          throw new LinuxExecutionError("RESOURCE_RESERVATION_FAILED", `resources unavailable: ${reservation.reason}`, { available: reservation.available })
        }
        acquired.reservationId = reservation.reservation.reservationId

        // R3: 运行期物化（seccomp/secret/cache）——不修改冻结后的 Spec。
        // C5：物化在事务内进行 —— cleanupAcquired 保证宿主文件（sealed
        // secret/seccomp）在成功、异常、取消任何路径后都被清理。
        acquired.materialization = await materializeExecution(compiled, selection.backend)
        await checkpoint("after-materialize")

        // GATE（GS-12）：Isolation Lock 身份 = 真实 workspace（canonical
        // realpath + dev/ino）——同 agent 不同 worktree 必须允许并行；
        // agent 是 owner 不是 lock domain。无 hostRoot → 回退 agent/物理
        // 键（保留既有语义）。
        const hostRoot = executeOptions?.authority?.workspace.hostRoot
        const workspaceIdentity = workspaceIdentityOf(hostRoot)
        const lockTarget = workspaceIdentity
          ? IsolationDomainLock.workspaceKey(workspaceIdentity)
          : (agentId
              ? IsolationDomainLock.worktreeKey(agentId)
              : IsolationDomainLock.mainWorkspaceKey())
        await checkpoint("before-lock")
        if (!locks.acquire(lockTarget, "exclusive", cellId)) {
          throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `isolation lock held: ${lockTarget}`, { lockTarget })
        }
        acquired.lockKeys.push(lockTarget)
        await checkpoint("after-lock")

        // GATE（GS-13）：跨进程 workspace 写互斥（进程内隔离锁之外的 OS 级
        // 互斥）。同一 workspace 跨进程并发 writer → 拒绝（fail-fast）。
        if (workspaceIdentity) {
          const lease = workspaceLease.acquire(workspaceIdentity)
          if (!lease.ok) {
            throw new LinuxExecutionError("WORKSPACE_LEASE_HELD", lease.reason ?? `workspace lease held: ${workspaceIdentity}`, { workspaceIdentity })
          }
          acquired.leaseRelease = lease.release
        }

        // Agent Domain 投影（仅在使用方提供 domain 时校验；cgroup 父层已在
        // AgentDomainManager 创建 —— 此处直接使用其 cgroupPath）。
        const domain = executeOptions?.domain

        // Cell cgroup（有委托时）。intended paths 在调用前记录并写入
        // acquired —— createRun/createAgent/createCell 内部部分创建后
        // 抛错（ensure 已 mkdir、controller 授权失败等）cleanup 仍有
        // 完整路径（IC02 §10：部分创建可恢复；P0-1 复审闭环）。
        if (cgroup) {
          const runPath = hierarchyPaths(cgroup.base, runId, undefined, "x").run
          const agentPath = domain?.cgroupPath ?? hierarchyPaths(cgroup.base, runId, agentId, "x").agent
          const cellPath = hierarchyPaths(cgroup.base, runId, agentId, cellId).cell
          acquired.cgroupRunPath = runPath
          acquired.cgroupAgentPath = agentPath
          // cell 路径专属本 cell —— 调用前记录，createCell 抛错也能清理。
          acquired.cgroupCellPath = cellPath
          if (!domain?.cgroupPath) {
            // PR-5：Run/Agent 层不重复使用单个 Cell 的预算 —— 聚合预算只来自
            // AgentDomain（createAgentDomain 已按 budget 创建）；无 Domain 时
            // 上层不设限（资源约束由 Cell 层承担），避免"单 Cell 预算冒充聚合"。
            // 无 domain → run/agent 层属于 broker-managed hierarchy：无论由本
            // 事务还是并行 Cell 创建，任一最后使用者可清理（last-user
            // ownership —— creator 先退不残留，最后 Cell 回收共享 parent）。
            acquired.cgroupRunBrokerManaged = true
            acquired.cgroupAgentBrokerManaged = true
            // pre-existing 判定仅用于部分创建后的 ownership 记录（createRun/
            // createAgent 内部抛错时 hierarchy 是否已存在由谁负责），
            // 不决定 broker-managed 归属。
            await checkpoint("before-create-run")
            try {
              cgroup.createRun(runId)
            } catch (error) {
              throw error
            }
            await checkpoint("after-create-run")
            if (agentId) {
              try {
                cgroup.createAgent(runId, agentId)
              } catch (error) {
                throw error
              }
            }
            await checkpoint("after-create-agent")
          }
          await checkpoint("before-create-cell")
          try {
            cgroup.createCell(runId, agentId, cellId, {
              memoryMaxBytes: compiled.resources.memoryMaxBytes,
              memoryHighBytes: compiled.resources.memoryHighBytes,
              pidsMax: compiled.resources.pidsMax,
              cpuQuotaMicros: compiled.resources.cpuQuotaMicros,
              cpuPeriodMicros: compiled.resources.cpuPeriodMicros,
              oomGroup: true,
            })
          } catch (error) {
            // cell 部分创建（ensure(cell) 后属性写入抛错）：cgroupCellPath
            // 已在调用前记录 → cleanup 尝试 removeCell。
            throw error
          }
          await checkpoint("after-create-cell")
        }

        const cell: ExecutionCell = { cellId, runId, nodeRunId: compiled.identity.nodeRunId, agentId, spec: compiled, state: "running" }
        cells.set(cellId, cell)
        cellRuns.get(cellId)!.phase = "running"
        stateStore.writeRun(runId, { status: "running", cells: runCellIds(runId), backend: selection.backend, ownerPid: process.pid, ownerProcStartTicks: readProcStartTicks() })

        // PR-2：捕获后端 Receipt（真实执行证据），cleanup 中持久化并合并清理真值。
        await checkpoint("before-backend-run")
        try {
          for await (const event of backend.run(compiled, {
            capabilities: caps,
            abortSignal: acquired.controller.signal,
            cgroupPath: acquired.cgroupCellPath,
            materialization: acquired.materialization,
            attachCell: pid => {
              acquired.spawnedPid = pid
              if (cgroup && acquired.cgroupCellPath) {
                try {
                  cgroup.attach(pid, acquired.cgroupCellPath)
                  // GATE（GS-11）：ATTACH_VERIFIED —— 读 /proc/<pid>/cgroup
                  // 确认真实 membership，不假设 attach 调用成功即生效。
                  attachVerified = verifyCgroupMembership(pid, acquired.cgroupCellPath)
                  if (!attachVerified) {
                    attachFailure = `CGROUP_ATTACH_NOT_VERIFIED: pid ${pid} not found in ${acquired.cgroupCellPath}`
                  }
                } catch (error) {
                  attachFailure = `CGROUP_ATTACH_FAILED: ${error instanceof Error ? error.message : String(error)}`
                  // LNXF-R2 10.5：严格 Profile attach 失败 → 立即取消
                  // （fail-fast：资源限额不被绕过到执行结束）；非严格
                  // 保留 degradation 声明。GATE：验证失败同样处理。
                  if (isStrictProfile(compiled.profile)) {
                    acquired.controller.abort()
                    // LR2-0F：严格 + attach 失败 → 不释放 launcher（目标
                    // 程序不 exec，避免在 cgroup 外开始执行）。
                    return false
                  }
                }
                // LR2-0F：launcher handshake 释放决策 —— attach 调用成功
                // 即释放（cgroup.procs 写入成功即 membership；verify 结果
                // 记入 Receipt degradation，不阻塞执行 —— mock/已退出竞态
                // 场景不得让执行挂起）。非严格 + attach 异常 → 降级执行
                // （Receipt 记 degradation，原语义保留）。
                return true
              }
              // 无 cgroup 委托 —— 无法验证 Cell 边界（进程组 fallback 模式
              // 是既有正常路径，不记 degradation）；Receipt 必须如实声明
              // cleanupVerified=false，不得假装有强保证。
              attachVerified = false
              return true // 无 attach 需求 → 立即释放（不阻塞执行）
            },
            readCellMetrics: () => readCellMetrics(acquired.cgroupCellPath ?? ""),
            cleanupVerify: () => {
              // PR-2：进程残留必须真实测量 —— cgroup 委托时读 pids.current；
              // 否则进程组扫描（countProcessGroup）；无法测量时 -1（未验证）。
              let processesRemaining = -1
              if (cgroup && acquired.cgroupCellPath) {
                processesRemaining = cgroup.pidsCurrent(acquired.cgroupCellPath)
              } else if ((acquired.spawnedPid ?? 0) > 0) {
                processesRemaining = countProcessGroup(acquired.spawnedPid!)
              }
              return {
                processesRemaining,
                cgroupRemoved: false, // 由 broker cleanupAcquired 实际移除后置真值
                mountsReleased: false,
                worktreeRetained: compiled.lifecycle.retainOnFailure,
              }
            },
          })) {
            if (event.type === "cell.receipt") cellReceipt = event.receipt
            yield event
          }
        } catch (error) {
          cell.state = "failed"
          throw error
        }
        cell.state = "succeeded"
      } catch (error) {
        const cellRef = cells.get(cellId)
        if (cellRef) cellRef.state = "failed"
        throw error
      } finally {
        cleanupAcquired(acquired, {
          cellReceipt,
          attachFailure,
          attachVerified,
          compiled,
        })
      }
    },
    createAgentDomain(input) {
      return domainManager.createDomain(input)
    },
    async cancelCell(cellId) {
      const record = cellRuns.get(cellId)
      if (!record) return
      // IC02：starting 阶段的 cell 同样可取消 —— AbortController 是主取消
      // 通道（无 cgroup 时也必须 abort）；cgroup.kill 为树级兜底增强。
      record.acquired.controller.abort()
      if (cgroup && record.acquired.cgroupCellPath) {
        cgroup.kill(record.acquired.cgroupCellPath)
      }
      // PR-7：podman 后端特异清理 —— cidfile + label 停止残留容器。
      if (record.acquired.podmanCidfile) {
        podmanCleanup(record.runId, cellId, record.acquired.podmanCidfile)
      }
    },
    async cancelAgent(agentId) {
      domainManager.cancelAgent(agentId)
      // IC02：CANCEL_WITHOUT_CGROUP_IGNORED = 0 —— 无 cgroup 环境同样 cancel。
      for (const [cellId, record] of cellRuns) {
        if (record.agentId === agentId) {
          await this.cancelCell(cellId)
        }
      }
    },
    async cancelRun(runId) {
      for (const [cellId, record] of cellRuns) {
        if (record.runId === runId) {
          await this.cancelCell(cellId)
        }
      }
      domainManager.closeRun(runId)
      ledger.releaseRun(runId)
      if (cgroup) {
        try {
          cgroup.removeRun(hierarchyPaths(cgroup.base, runId, undefined, "x").run)
        } catch {
          // 清理失败由 cleanupRun 记录
        }
      }
      stateStore.writeRun(runId, { status: "cancelled", cleanedAt: Date.now() })
    },
    async cleanupRun(runId) {
      let removed = 0
      for (const [cellId, record] of cellRuns) {
        if (record.runId === runId) {
          await this.cancelCell(cellId)
          removed += 1
        }
      }
      // PR-7：podman label 级兜底清理（run 级残留容器）。
      podmanCleanup(runId, "", undefined)
      domainManager.closeRun(runId)
      removed += ledger.releaseRun(runId)
      if (cgroup) {
        try {
          const runPath = hierarchyPaths(cgroup.base, runId, undefined, "x").run
          const removedCgroup = cgroup.removeRun(runPath)
          if (removedCgroup) removed += 1
        } catch {
          // best-effort
        }
      }
      // LNXF-GATE-02 (A7/B10)：durable service/port lease 清理 —— 从
      // stateStore 记录恢复（非空 broker 推测）。runId 匹配 + owner 已死
      // 双条件；owner 存活时仅 run-end 策略的 lease 停止（manual 存活不
      // 误杀 —— 可能已被其他进程接管复用）。
      let servicesCleaned = 0
      let portsCleaned = 0
      for (const lease of stateStore.readServiceLeases()) {
        if (lease.runId !== runId) continue
        if (!processDead(lease.pid, lease.ownerProcStartTicks)) {
          if (lease.cleanupPolicy !== "run-end") continue
          if (lease.pid) killProcessGroup(lease.pid)
        }
        stateStore.removeServiceLease(lease.id)
        servicesCleaned += 1
      }
      for (const lease of stateStore.readPortLeases()) {
        if (lease.runId !== runId) continue
        stateStore.removePortLease(lease.port)
        portsCleaned += 1
      }
      stateStore.writeCleanup(runId, { removed, servicesCleaned, portsCleaned, at: Date.now() })
      return { removed, servicesCleaned, portsCleaned }
    },
    activeCells() {
      return [...cells.values()]
    },
    ledger() {
      return ledger
    },
    runtimeContext() {
      return { ledger, locks, domainManager, cacheManager, stateStore }
    },
    cgroupBase() {
      return cgroup?.base
    },
  }
}

export function getLinuxBroker(): LinuxExecutionBroker {
  if (!shared) shared = createLinuxBroker({ mode: "shadow" })
  return shared
}

/**
 * GATE（GS-11）：读 /proc/<pid>/cgroup 验证 pid 真实位于 cell cgroup。
 * attach 调用成功 ≠ 生效（WSL2 EACCES 下 attach 可能静默空操作），
 * 只有 membership 可读且包含 cell 路径才算 ATTACH_VERIFIED。
 */
function verifyCgroupMembership(pid: number, cgroupPath: string): boolean {
  try {
    const content = readFileSync(`/proc/${pid}/cgroup`, "utf8")
    return content.includes(cgroupPath)
  } catch {
    return false
  }
}

/**
 * GATE（GS-12/GS-13）：workspace 身份 = canonicalRealPath + filesystem
 * identity（dev/ino）。同物理目录的别名/符号链接 → 同一身份 → 同锁键；
 * 不同目录（即使同 agent）→ 不同身份 → 允许并行（A10 修复语义）。
 * 目录不可解析时返回 undefined（调用方回退到 agent/main 键）。
 */
export function workspaceIdentityOf(hostRoot: string | undefined): string | undefined {
  if (!hostRoot) return undefined
  try {
    const canonical = realpathSync(hostRoot)
    const st = statSync(canonical)
    return `${st.dev}:${st.ino}`
  } catch {
    return undefined
  }
}

/** R2 PR-9（EA-012）：shadow/单元测试使用的显式 Test Authority。
 *  仅允许 shadow 模式（enabled/enforced 由 compileRequest 前置拒绝）。
 *  生产路径必须由 AgentRunScope 注入真实 authority。 */
export function testAuthorityFallback(workspaceRoot?: string): TrustedExecutionAuthority {
  const root = workspaceRoot ?? join(tmpdir(), "orcana-test-ws")
  return {
    identity: { runId: `run-test-${process.pid}`, nodeRunId: `run-test-${process.pid}:n1`, attempt: 1 },
    workspace: {
      workspaceId: "ws_test",
      physicalWorkspaceKey: `wp_test_${process.pid}`,
      projectId: "test",
      hostRoot: root,
      kind: "system",
      access: "readwrite",
      ownerFiles: [],
    },
  }
}
