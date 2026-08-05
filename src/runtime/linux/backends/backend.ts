/** LNXF-1.0: execution backend interface (LF-2).
 *
 *  Contract per backend-contract.md: availability / validateSpec / compile /
 *  run. Backends live ONLY in `src/runtime/linux/backends/`.
 */

import type {
  BackendAvailability,
  CompiledExecution,
  ExecutionCellEvent,
  ExecutionCellSpec,
  LinuxCapabilities,
} from "../contracts"
import type { SandboxReceipt } from "../contracts"

export interface BackendRunContext {
  capabilities: LinuxCapabilities
  /** 共享资源状态（LF-5 接线）。 */
  resourceState?: unknown
}

export interface ExecutionBackend {
  readonly id: "host-audit" | "bubblewrap" | "rootless-podman"

  availability(caps: LinuxCapabilities): BackendAvailability

  /** [] = 可执行；非空 = 拒绝原因（错误码前缀）。 */
  validateSpec(spec: ExecutionCellSpec): string[]

  /** 编译后端专属启动参数（Policy Compiler 唯一来源）。 */
  compile(spec: ExecutionCellSpec, caps: LinuxCapabilities): CompiledExecution

  run(spec: ExecutionCellSpec, ctx: BackendRunContext): AsyncIterable<ExecutionCellEvent>

  /** 构造 Receipt（后端特异性：退出信息、清理状态）。 */
  buildReceipt(spec: ExecutionCellSpec, caps: LinuxCapabilities, outcome: BackendOutcome): SandboxReceipt
}

export interface BackendOutcome {
  startedAt: number
  finishedAt: number
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  cancelled: boolean
  oomKilled: boolean
  pidLimitHit: boolean
  outputLimitHit: boolean
  tempLimitHit: boolean
  observedWrites: string[]
  observedDeletes: string[]
  unexpectedWrites: string[]
  violations: import("../contracts").SandboxViolation[]
  degradationReasons: string[]
  backendVersion?: string
  metrics?: import("../contracts").SandboxReceipt["metrics"]
}
