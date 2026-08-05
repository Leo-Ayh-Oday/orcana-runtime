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
import { streamSupervised, type SupervisorResult } from "../process/supervisor"

export interface BackendRunContext {
  capabilities: LinuxCapabilities
  /** 共享资源状态（LF-5 接线）。 */
  resourceState?: unknown
  /** 取消信号（透传到进程监督器）。 */
  abortSignal?: AbortSignal
  /** Cell 级 cgroup 路径（Broker 已创建；后端 spawn 后 attach）。 */
  cgroupPath?: string
  /** spawn 后立即 attach（cgroup 绑定真实进程，P0-4 修复）。 */
  attachCell?: (pid: number) => void
  /** 执行结束后读取 cgroup 指标（真实 metrics，P0-6 修复）。 */
  readCellMetrics?: () => SandboxReceipt["metrics"] | undefined
  /** 清理验证：真实执行后报告（默认不假设安全值）。 */
  cleanupVerify?: () => Partial<SandboxReceipt["cleanup"]>
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

/** 流式执行公共逻辑（R1）：stdout/stderr 增量产出，退出后构造 Receipt。 */
export async function* streamBackendRun(
  backend: "host-audit" | "bubblewrap" | "rootless-podman",
  spec: ExecutionCellSpec,
  ctx: BackendRunContext,
  compile: () => CompiledExecution,
  buildReceipt: (result: SupervisorResult) => SandboxReceipt,
): AsyncGenerator<ExecutionCellEvent> {
  const startedAt = Date.now()
  yield { type: "cell.status", cellId: spec.identity.cellId, state: "running", at: startedAt }
  const compiled = compile()
  for await (const event of streamSupervised({
    executable: compiled.argv[0]!,
    args: compiled.argv.slice(1),
    cwd: compiled.cwd,
    env: compiled.env,
    limits: { stdoutMaxBytes: spec.resources.stdoutMaxBytes, stderrMaxBytes: spec.resources.stderrMaxBytes },
    wallTimeMs: spec.resources.wallTimeMs,
    detectDaemon: spec.lifecycle.killOnParentExit,
    abortSignal: ctx.abortSignal,
    onSpawn: pid => ctx.attachCell?.(pid),
  })) {
    if (event.type === "stdout") yield { type: "cell.stdout", cellId: spec.identity.cellId, data: event.data, at: event.at }
    else if (event.type === "stderr") yield { type: "cell.stderr", cellId: spec.identity.cellId, data: event.data, at: event.at }
    else {
      const result = event.result
      yield { type: "cell.exit", cellId: spec.identity.cellId, exitCode: result.exitCode, signal: result.signal, at: event.at }
      yield { type: "cell.receipt", cellId: spec.identity.cellId, receipt: buildReceipt(result), at: event.at }
    }
  }
  void startedAt
}
