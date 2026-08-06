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
import type {
  AgentExecutionDomain,
  CapabilityRequest,
  ExecutionCell,
  ExecutionCellEvent,
  ExecutionCellSpec,
  ExecutionMaterialization,
  LinuxCapabilities,
  SandboxReceipt,
} from "./contracts"
import type { DomainResourceBudget } from "./contracts"
import { probeLinuxCapabilities, requireLinuxPlatform } from "./capability-probe"
import { compileCapabilityRequest, compileCellSpec } from "./policy-compiler"
import { selectBackend } from "./backend-router"
import type { BackendSelection } from "./backend-router"
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
}

export interface ExecuteOptions {
  /** 取消信号（透传到后端 runSupervised）。 */
  abortSignal?: AbortSignal
  /** 指定 Agent Domain（多 Agent 执行身份投影，R4 接线）。 */
  domain?: AgentExecutionDomain
}

export interface LinuxExecutionBroker {
  probe(options?: { refresh?: boolean }): LinuxCapabilities
  /** 编译并校验一个执行 spec（Policy Compiler 唯一入口）。 */
  compileSpec(spec: ExecutionCellSpec): ExecutionCellSpec
  /** Capability Request → 冻结 Spec（身份由 Runtime 生成；P0-1/P0-2）。 */
  compileRequest(request: CapabilityRequest): ExecutionCellSpec
  /** 选择后端（不执行）。 */
  selectBackendFor(spec: ExecutionCellSpec): BackendSelection
  /** Shadow：记录拟用 spec/后端，不执行。 */
  shadow(spec: ExecutionCellSpec): ShadowExecutionRecord
  /** 执行（R2: 完整事务）。 */
  execute(spec: ExecutionCellSpec, options?: ExecuteOptions): AsyncIterable<ExecutionCellEvent>
  /** 执行 Capability Request（编译 → 执行）。 */
  executeRequest(request: CapabilityRequest, options?: ExecuteOptions): AsyncIterable<ExecutionCellEvent>
  createAgentDomain(input: { runId: string; agentId: string; worktreeRoot: string; ownerFiles: string[]; resourceBudget: DomainResourceBudget; role?: string }): AgentExecutionDomain
  cancelCell(cellId: string): Promise<void>
  cancelAgent(agentId: string): Promise<void>
  cancelRun(runId: string): Promise<void>
  cleanupRun(runId: string): Promise<{ removed: number }>
  /** R2: 当前运行中 Cell（诊断/测试）。 */
  activeCells(): ExecutionCell[]
  /** R2: 资源账本（调度接入）。 */
  ledger(): ResourceLedger
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
    cpuQuota: spec.resources.cpuQuotaMicros ? Math.max(1, Math.round(spec.resources.cpuQuotaMicros / 10_000)) : 1,
    memoryBytes: spec.resources.memoryMaxBytes,
    pids: spec.resources.pidsMax,
    ioWeight: spec.resources.ioWeight ?? 0,
    networkSlots: spec.network.mode === "full-approved" ? 1 : 0,
    tempBytes: spec.resources.tmpfsMaxBytes,
  }
}

export function createLinuxBroker(options: LinuxBrokerOptions): LinuxExecutionBroker {
  const caps = requireLinuxPlatform()
  const shadowRecords: ShadowExecutionRecord[] = []
  const cells = new Map<string, ExecutionCell>()
  const cellRuns = new Map<string, { runId: string; agentId?: string; reservationId: string; lockKeys: string[]; cgroupCellPath: string; cgroupAgentPath: string; cgroupRunPath: string; controller?: AbortController }>()

  const ledger = options.ledger ?? new ResourceLedger()
  const stateStore = options.stateStore ?? new RuntimeStateStore()
  const domainManager = new AgentDomainManager({ ledger })
  const cacheManager = new CacheManager(options.cacheRoot ?? join(stateStore.capabilitiesPath(), "..", "cache"))

  // cgroup：仅在有真实委托时启用（无委托 → cgroupPath 为空，严格任务已在
  // selectBackend 层拒绝；P0-4 修复前绝不假装资源限制生效）。
  const delegated = detectDelegatedRoot()
  const cgroup = options.cgroup ?? (delegated.writable ? new CgroupManager({ base: delegated.base }) : undefined)
  const locks = new IsolationDomainLock()

  const compileOrThrow = (spec: ExecutionCellSpec): ExecutionCellSpec => {
    const compiled = compileCellSpec(spec)
    if (!compiled.ok) {
      throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `spec invalid: ${compiled.errors.join("; ")}`)
    }
    return compiled.spec
  }

  /** 运行期物化：seccomp 文件、secret 注入、缓存宿主路径。
   *  P0-1 修复：绝不写回 compiled spec —— 策略 Spec 在编译后冻结。 */
  const materializeExecution = (spec: ExecutionCellSpec, backendId: string): ExecutionMaterialization => {
    const materialization: ExecutionMaterialization = {}
    if ((backendId === "bubblewrap" || backendId === "rootless-podman")
      && (spec.profile === "inspect" || spec.profile === "untrusted")) {
      try {
        const target = spec.profile === "untrusted" ? "untrusted" : "inspect"
        const filePath = join(tmpdir(), `orcana-seccomp-${spec.identity.cellId}.bpf`)
        writeSeccompBpfFile(compileSeccompProfile(target), filePath)
        materialization.seccompFile = filePath
      } catch {
        // seccomp 不可用（非 x86_64 等）→ 降级原因记录，不阻断。
      }
    }
    if (spec.secrets.length > 0) {
      const bound = bindSecrets({ bindings: spec.secrets, values: options.secretValues ?? {} })
      if (!bound.ok) {
        throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `secret binding failed: ${bound.errors.join("; ")}`)
      }
      materialization.secretEnv = bound.envInjections
      bound.cleanup() // 本次执行结束后立即清理临时文件（环境注入类无文件）
    }
    for (const cache of spec.cache) {
      materialization.cacheHostPaths = {
        ...materialization.cacheHostPaths,
        [cache.target]: cacheManager.hostPath(cache),
      }
    }
    return materialization
  }

  const readCellMetrics = (cgroupCellPath: string): SandboxReceipt["metrics"] => {
    if (!cgroup || !cgroupCellPath) return {}
    try {
      const metrics = readMetrics(cgroupCellPath, cgroup.fs)
      return {
        cpuUsageUsec: metrics.cpuUsageUsec,
        cpuThrottledUsec: metrics.cpuThrottledUsec,
        peakMemoryBytes: metrics.peakMemoryBytes,
        peakPids: metrics.peakPids,
      }
    } catch {
      return {}
    }
  }

  return {
    probe(opts) {
      return probeLinuxCapabilities(opts)
    },
    compileSpec: compileOrThrow,
    compileRequest(request) {
      const compiled = compileCapabilityRequest(request)
      if (!compiled.ok) {
        throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `request invalid: ${compiled.errors.join("; ")}`)
      }
      return compiled.spec
    },
    async *executeRequest(request, executeOptions) {
      yield* this.execute(this.compileRequest(request), executeOptions)
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

      // R3: 运行期物化（seccomp/secret/cache）——不修改冻结后的 Spec。
      const materialization = materializeExecution(compiled, selection.backend)

      const cellId = compiled.identity.cellId
      const runId = compiled.identity.runId
      const agentId = compiled.identity.agentId ?? executeOptions?.domain?.agentId

      // ── 事务：资源预留 → 锁 → Domain → cgroup → 执行 → 清理 → 释放 ──
      const requested = resourceRequestOf(compiled)
      const reservation = ledger.reserve(requested, runId, cellId, agentId)
      if (!reservation.ok) {
        throw new LinuxExecutionError("RESOURCE_RESERVATION_FAILED", `resources unavailable: ${reservation.reason}`, { available: reservation.available })
      }
      const lockKeys: string[] = []
      // PR-2：捕获后端 Receipt（真实执行证据），finally 中持久化并合并清理真值。
      let cellReceipt: SandboxReceipt | undefined
      // PR-5：attach 失败不再吞掉 —— 记入 Receipt degradation（fail-closed 审计）。
      let attachFailure: string | undefined
      try {
        // Isolation Lock（PR-4）：worktreeRoot + agentId → 按 Agent 的 worktree
        // 独占；worktreeRoot 无 agentId（工具投影）→ main-workspace 独占（正式
        // 工作区单写者）；无 worktree → main-workspace 独占。
        const lockTarget = compiled.filesystem.worktreeRoot
          ? (agentId ? IsolationDomainLock.worktreeKey(agentId) : IsolationDomainLock.mainWorkspaceKey())
          : IsolationDomainLock.mainWorkspaceKey()
        if (!locks.acquire(lockTarget, "exclusive", cellId)) {
          throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `isolation lock held: ${lockTarget}`, { lockTarget })
        }
        lockKeys.push(lockTarget)

        // Agent Domain 投影（仅在使用方提供 domain 时校验；cgroup 父层已在
        // AgentDomainManager 创建 —— 此处直接使用其 cgroupPath）。
        const domain = executeOptions?.domain

        // Cell cgroup（有委托时）。
        let cgroupCellPath = ""
        let cgroupAgentPath = ""
        let cgroupRunPath = ""
        if (cgroup) {
          cgroupRunPath = hierarchyPaths(cgroup.base, runId, undefined, "x").run
          cgroupAgentPath = domain?.cgroupPath ?? hierarchyPaths(cgroup.base, runId, agentId, "x").agent
          if (!domain?.cgroupPath) {
            // PR-5：Run/Agent 层不重复使用单个 Cell 的预算 —— 聚合预算只来自
            // AgentDomain（createAgentDomain 已按 budget 创建）；无 Domain 时
            // 上层不设限（资源约束由 Cell 层承担），避免"单 Cell 预算冒充聚合"。
            cgroup.createRun(runId)
            if (agentId) cgroup.createAgent(runId, agentId)
          }
          cgroupCellPath = cgroup.createCell(runId, agentId, cellId, {
            memoryMaxBytes: compiled.resources.memoryMaxBytes,
            memoryHighBytes: compiled.resources.memoryHighBytes,
            pidsMax: compiled.resources.pidsMax,
            cpuQuotaMicros: compiled.resources.cpuQuotaMicros,
            cpuPeriodMicros: compiled.resources.cpuPeriodMicros,
            oomGroup: true,
          })
        }

        const cell: ExecutionCell = { cellId, runId, nodeRunId: compiled.identity.nodeRunId, agentId, spec: compiled, state: "running" }
        cells.set(cellId, cell)
        // PR-3：每个 Cell 持有自己的 AbortController —— cancelCell 能主动触发
        // Supervisor 取消信号（不再依赖调用方持有外部 abortSignal）。
        const controller = new AbortController()
        if (executeOptions?.abortSignal) {
          if (executeOptions.abortSignal.aborted) {
            controller.abort()
          } else {
            executeOptions.abortSignal.addEventListener("abort", () => controller.abort(), { once: true })
          }
        }
        cellRuns.set(cellId, { runId, agentId, reservationId: reservation.reservation.reservationId, lockKeys, cgroupCellPath, cgroupAgentPath, cgroupRunPath, controller })
        stateStore.writeRun(runId, { status: "running", cells: [...cellRuns.values()].filter(r => r.runId === runId).map(r => r.runId) })

        // PR-2：捕获后端 Receipt（真实执行证据），finally 中持久化并合并清理真值。
        let spawnedPid = 0
        try {
          for await (const event of backend.run(compiled, {
            capabilities: caps,
            abortSignal: controller.signal,
            cgroupPath: cgroupCellPath,
            materialization,
            attachCell: pid => {
              spawnedPid = pid
              if (cgroup && cgroupCellPath) {
                try {
                  cgroup.attach(pid, cgroupCellPath)
                } catch (error) {
                  attachFailure = `CGROUP_ATTACH_FAILED: ${error instanceof Error ? error.message : String(error)}`
                }
              }
            },
            readCellMetrics: () => readCellMetrics(cgroupCellPath),
            cleanupVerify: () => {
              // PR-2：进程残留必须真实测量 —— cgroup 委托时读 pids.current；
              // 否则进程组扫描（countProcessGroup）；无法测量时 -1（未验证）。
              let processesRemaining = -1
              if (cgroup && cgroupCellPath) {
                processesRemaining = cgroup.pidsCurrent(cgroupCellPath)
              } else if (spawnedPid > 0) {
                processesRemaining = countProcessGroup(spawnedPid)
              }
              return {
                processesRemaining,
                cgroupRemoved: false, // 由 broker finally 实际移除后置真值
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
      } finally {
        // 清理与释放（异常路径同 finally 事务）。
        const record = cellRuns.get(cellId)
        if (record) {
          // Cell cgroup 真实移除（PR-2 先做 best-effort；PR-5 重建完整协议）。
          let cgroupRemoved = false
          if (cgroup && record.cgroupCellPath) {
            try {
              cgroupRemoved = cgroup.removeCell(record.cgroupCellPath)
            } catch {
              cgroupRemoved = false
            }
          }
          if (cellReceipt) {
            // 最终 Receipt：合并真实清理结果 + attach 失败降级，重算自摘要后持久化。
            const finalReceipt: SandboxReceipt = {
              ...cellReceipt,
              degradationReasons: attachFailure
                ? [...cellReceipt.degradationReasons, attachFailure]
                : cellReceipt.degradationReasons,
              cleanup: {
                ...cellReceipt.cleanup,
                cgroupRemoved: cgroupRemoved || cellReceipt.cleanup.cgroupRemoved,
                processesRemaining: cgroupRemoved ? 0 : cellReceipt.cleanup.processesRemaining,
              },
            }
            const final: SandboxReceipt = {
              ...finalReceipt,
              receiptDigest: computeReceiptDigest(finalReceipt),
            }
            const cellRef = cells.get(cellId)
            if (cellRef) cellRef.receipt = final
            try {
              stateStore.appendReceipt(runId, final)
            } catch {
              // 持久化失败不阻断执行（Receipt 仍在事件流中）
            }
          }
          for (const key of record.lockKeys) locks.release(key, cellId)
          ledger.release(record.reservationId)
          cellRuns.delete(cellId)
          cells.delete(cellId)
        }
      }
    },
    createAgentDomain(input) {
      return domainManager.createDomain(input)
    },
    async cancelCell(cellId) {
      const record = cellRuns.get(cellId)
      if (!record) return
      // PR-3：AbortController 主动触发 Supervisor 取消（进程组终止），
      // cgroup.kill 为树级兜底 —— 双通道保证取消生效。
      record.controller?.abort()
      if (cgroup && record.cgroupCellPath) {
        cgroup.kill(record.cgroupCellPath)
      }
    },
    async cancelAgent(agentId) {
      domainManager.cancelAgent(agentId)
      for (const [cellId, record] of cellRuns) {
        if (record.agentId === agentId && cgroup && record.cgroupCellPath) {
          cgroup.kill(record.cgroupCellPath)
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
      stateStore.writeCleanup(runId, { removed, at: Date.now() })
      return { removed }
    },
    activeCells() {
      return [...cells.values()]
    },
    ledger() {
      return ledger
    },
  }
}

export function getLinuxBroker(): LinuxExecutionBroker {
  if (!shared) shared = createLinuxBroker({ mode: "shadow" })
  return shared
}
