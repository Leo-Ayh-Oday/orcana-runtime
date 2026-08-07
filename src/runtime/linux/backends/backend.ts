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
import type { ExecutionMaterialization } from "../contracts"
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
  /** 运行期物化材料（seccomp/secret/cache 宿主路径）——不属于 Policy Spec。 */
  materialization?: ExecutionMaterialization
}

export interface ExecutionBackend {
  readonly id: "host-audit" | "bubblewrap" | "rootless-podman"

  availability(caps: LinuxCapabilities): BackendAvailability

  /** [] = 可执行；非空 = 拒绝原因（错误码前缀）。 */
  validateSpec(spec: ExecutionCellSpec): string[]

  /** 编译后端专属启动参数（Policy Compiler 唯一来源 + 运行期物化材料）。 */
  compile(spec: ExecutionCellSpec, caps: LinuxCapabilities, materialization?: ExecutionMaterialization): CompiledExecution

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
  /** PathGuard 快照有界性证据（host-audit/bubblewrap 在 run() 注入）。 */
  snapshotGuard?: import("../contracts").SandboxReceipt["snapshotGuard"]
  /** 清理实测结果（由 streamBackendRun 注入；后端只覆写自身事实）。 */
  cleanup?: Partial<import("../contracts").SandboxReceipt["cleanup"]>
}

/** streamBackendRun 注入的真实执行证据（PR-2：时间/指标/清理均实测）。 */
export interface BackendRunEvidence {
  startedAt: number
  finishedAt: number
  metrics?: SandboxReceipt["metrics"]
  cleanup?: Partial<SandboxReceipt["cleanup"]>
}

/** 流式执行公共逻辑（R1）：stdout/stderr 增量产出，退出后构造 Receipt。
 *  PR-2：startedAt/finishedAt 由真实执行推导（supervisor durationMs），
 *  metrics 与 cleanup 来自 ctx.readCellMetrics/cleanupVerify 实测 ——
 *  后端不再用 Date.now() 双调用伪造时长、不再硬编码清理成功值。 */
export async function* streamBackendRun(
  backend: "host-audit" | "bubblewrap" | "rootless-podman",
  spec: ExecutionCellSpec,
  ctx: BackendRunContext,
  compile: () => CompiledExecution,
  buildReceipt: (result: SupervisorResult, evidence: BackendRunEvidence) => SandboxReceipt,
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
    seccompFdPath: compiled.seccompFdPath,
    onSpawn: pid => ctx.attachCell?.(pid),
  })) {
    if (event.type === "stdout") yield { type: "cell.stdout", cellId: spec.identity.cellId, data: event.data, at: event.at }
    else if (event.type === "stderr") yield { type: "cell.stderr", cellId: spec.identity.cellId, data: event.data, at: event.at }
    else {
      const result = event.result
      const finishedAt = startedAt + result.durationMs
      const metrics = ctx.readCellMetrics?.() ?? {}
      const cleanup = ctx.cleanupVerify?.() ?? { processesRemaining: -1 }
      yield { type: "cell.exit", cellId: spec.identity.cellId, exitCode: result.exitCode, signal: result.signal, at: event.at }
      yield { type: "cell.receipt", cellId: spec.identity.cellId, receipt: buildReceipt(result, { startedAt, finishedAt, metrics, cleanup }), at: event.at }
    }
  }
}
