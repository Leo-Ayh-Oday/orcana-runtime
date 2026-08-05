/** LNXF-1.0: Linux execution broker (LF-1 骨架) — 单一执行入口（ADR-L1）。
 *
 *  LF-1 提供接口、能力缓存、shadow 记录器与 spec 编译门。真实后端执行
 *  从 LF-2（HostAudit）与 LF-3（Bubblewrap）开始接线。
 */

import { randomUUID } from "node:crypto"
import type {
  AgentExecutionDomain,
  ExecutionCell,
  ExecutionCellEvent,
  ExecutionCellSpec,
  LinuxCapabilities,
} from "./contracts"
import type { DomainResourceBudget } from "./contracts"
import { probeLinuxCapabilities, requireLinuxPlatform } from "./capability-probe"
import { compileCellSpec } from "./policy-compiler"
import { selectBackend } from "./backend-router"
import type { BackendSelection } from "./backend-router"
import { LinuxExecutionError } from "./errors"
import { createHostAuditBackend } from "./backends/host-audit"
import { createBubblewrapBackend } from "./backends/bubblewrap"
import { createPodmanBackend } from "./backends/podman"
import type { ExecutionBackend } from "./backends/backend"

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
}

export interface LinuxExecutionBroker {
  probe(options?: { refresh?: boolean }): LinuxCapabilities
  /** 编译并校验一个执行 spec（Policy Compiler 唯一入口）。 */
  compileSpec(spec: ExecutionCellSpec): ExecutionCellSpec
  /** 选择后端（不执行）。 */
  selectBackendFor(spec: ExecutionCellSpec): BackendSelection
  /** Shadow：记录拟用 spec/后端，不执行。 */
  shadow(spec: ExecutionCellSpec): ShadowExecutionRecord
  /** 执行（LF-2+ 接线后可用）。 */
  execute(spec: ExecutionCellSpec): AsyncIterable<ExecutionCellEvent>
  createAgentDomain(input: { runId: string; agentId: string; worktreeRoot: string; ownerFiles: string[]; resourceBudget: DomainResourceBudget; role?: string }): AgentExecutionDomain
  cancelCell(cellId: string): Promise<void>
  cancelAgent(agentId: string): Promise<void>
  cancelRun(runId: string): Promise<void>
  cleanupRun(runId: string): Promise<{ removed: number }>
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

export function createLinuxBroker(options: LinuxBrokerOptions): LinuxExecutionBroker {
  const caps = requireLinuxPlatform()
  const shadowRecords: ShadowExecutionRecord[] = []

  const domainIds = new Map<string, AgentExecutionDomain>()
  const cells = new Map<string, ExecutionCell>()

  const compileOrThrow = (spec: ExecutionCellSpec): ExecutionCellSpec => {
    const compiled = compileCellSpec(spec)
    if (!compiled.ok) {
      throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `spec invalid: ${compiled.errors.join("; ")}`)
    }
    return compiled.spec
  }

  return {
    probe(opts) {
      return probeLinuxCapabilities(opts)
    },
    compileSpec: compileOrThrow,
    selectBackendFor(spec) {
      return selectBackend(spec, caps)
    },
    shadow(spec) {
      const compiled = compileOrThrow(spec)
      // Shadow 只记录拟用后端，不执行；后端选择失败也如实记录（fail-closed 语义）。
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
    async *execute(spec) {
      if (options.mode === "shadow") {
        // LF-1/2: shadow 不执行 —— 记录后由旧路径执行。
        this.shadow(spec)
        return
      }
      const compiled = compileOrThrow(spec)
      const selection = selectBackend(compiled, caps)
      const backend = backendOf(selection.backend)
      if (!backend) {
        throw new LinuxExecutionError("PROCESS_START_FAILED", `no backend implementation for "${selection.backend}"`)
      }
      const violations = backend.validateSpec(compiled)
      if (violations.length > 0) {
        throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `backend ${backend.id} rejects spec: ${violations.join("; ")}`)
      }
      yield* backend.run(compiled, { capabilities: caps })
    },
    createAgentDomain(input) {
      const domain: AgentExecutionDomain = {
        domainId: `domain_${randomUUID().slice(0, 8)}`,
        runId: input.runId,
        agentId: input.agentId,
        role: input.role,
        worktreeRoot: input.worktreeRoot,
        ownerFiles: input.ownerFiles,
        cgroupPath: "",
        tempRoot: "",
        cacheNamespace: `run-${input.runId}/agent-${input.agentId}`,
        resourceBudget: input.resourceBudget,
        createdAt: Date.now(),
        status: "active",
      }
      domainIds.set(domain.domainId, domain)
      return domain
    },
    async cancelCell() {},
    async cancelAgent() {},
    async cancelRun() {},
    async cleanupRun(runId) {
      return { removed: 0 }
    },
  }
}

export function getLinuxBroker(): LinuxExecutionBroker {
  if (!shared) shared = createLinuxBroker({ mode: "shadow" })
  return shared
}
