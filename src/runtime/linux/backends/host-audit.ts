/** LNXF-1.0: Host Audit backend (LF-2) — 降级后端.
 *
 *  只保留：显式环境、超时、进程组、PathGuard（事后）、Receipt。
 *  不是安全边界（ADR-L4）：仅 profile=inspect/低风险 build + minimum=audit
 *  + 显式允许降级时使用。
 */

import type {
  BackendAvailability,
  ExecutionCellEvent,
  ExecutionCellSpec,
  LinuxCapabilities,
  SandboxReceipt,
} from "../contracts"
import type { BackendOutcome, ExecutionBackend } from "./backend"
import { runSupervised } from "../process/supervisor"
import { buildExplicitEnvironment } from "../environment"
import { buildReceipt } from "../receipt"
import { validateCellSpec } from "../policy-compiler"

const HOST_AUDIT_DEGRADATION = "Host Audit 不是安全边界（无网络/文件系统拦截），仅限低风险显式允许场景"

export function createHostAuditBackend(): ExecutionBackend {
  return {
    id: "host-audit",

    availability(): BackendAvailability {
      return { id: "host-audit", available: true, degradationReasons: [HOST_AUDIT_DEGRADATION] }
    },

    validateSpec(spec) {
      const errors: string[] = []
      const validation = validateCellSpec(spec)
      if (!validation.ok) errors.push(...validation.errors.map(e => `EXECUTION_SPEC_INVALID: ${e}`))
      if (spec.isolation.minimum !== "audit") {
        errors.push("ISOLATION_REQUIREMENT_UNMET: host-audit backend requires minimum=audit")
      }
      if (!spec.isolation.allowDegradation && spec.profile !== "inspect" && spec.profile !== "build") {
        errors.push(`DEGRADATION_NOT_ALLOWED: profile "${spec.profile}" cannot use host-audit`)
      }
      return errors
    },

    compile(spec) {
      const env = buildExplicitEnvironment({
        policy: { baseProfile: "minimal", allowedHostKeys: [], fixedValues: {}, requestedValues: {}, deniedKeys: [] },
        runId: spec.identity.runId,
        nodeRunId: spec.identity.nodeRunId,
      })
      return {
        backend: "host-audit",
        argv: [spec.command.executable, ...spec.command.args],
        env: { ...env.env, ...spec.environment.variables },
        cwd: spec.command.cwd,
      }
    },

    async *run(spec, ctx): AsyncGenerator<ExecutionCellEvent> {
      const startedAt = Date.now()
      yield { type: "cell.status", cellId: spec.identity.cellId, state: "running", at: startedAt }
      const compiled = this.compile(spec, ctx.capabilities)
      const result = await runSupervised({
        executable: spec.command.executable,
        args: spec.command.args,
        cwd: spec.command.cwd,
        env: compiled.env,
        limits: { stdoutMaxBytes: spec.resources.stdoutMaxBytes, stderrMaxBytes: spec.resources.stderrMaxBytes },
        wallTimeMs: spec.resources.wallTimeMs,
        detectDaemon: spec.lifecycle.killOnParentExit,
      })
      const finishedAt = Date.now()
      if (result.stdout) yield { type: "cell.stdout", cellId: spec.identity.cellId, data: result.stdout, at: finishedAt }
      if (result.stderr) yield { type: "cell.stderr", cellId: spec.identity.cellId, data: result.stderr, at: finishedAt }
      yield { type: "cell.exit", cellId: spec.identity.cellId, exitCode: result.exitCode, signal: result.signal, at: finishedAt }
      const receipt = this.buildReceipt(spec, ctx.capabilities, {
        startedAt,
        finishedAt,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        oomKilled: false,
        pidLimitHit: false,
        outputLimitHit: result.outputLimitHit,
        tempLimitHit: false,
        observedWrites: [],
        observedDeletes: [],
        unexpectedWrites: [],
        violations: [],
        degradationReasons: [HOST_AUDIT_DEGRADATION],
        metrics: {},
      })
      yield { type: "cell.receipt", cellId: spec.identity.cellId, receipt, at: finishedAt }
    },

    buildReceipt(spec, caps, outcome): SandboxReceipt {
      return buildReceipt({
        spec,
        capabilities: caps,
        backend: "host-audit",
        backendVersion: outcome.backendVersion,
        startedAt: outcome.startedAt,
        finishedAt: outcome.finishedAt,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        cancelled: outcome.cancelled,
        oomKilled: outcome.oomKilled,
        pidLimitHit: outcome.pidLimitHit,
        outputLimitHit: outcome.outputLimitHit,
        tempLimitHit: outcome.tempLimitHit,
        metrics: outcome.metrics,
        observedWrites: outcome.observedWrites,
        observedDeletes: outcome.observedDeletes,
        unexpectedWrites: outcome.unexpectedWrites,
        violations: outcome.violations,
        degradationReasons: [HOST_AUDIT_DEGRADATION, ...outcome.degradationReasons],
        cleanup: { processesRemaining: 0, mountsReleased: true, cgroupRemoved: true, worktreeRetained: spec.lifecycle.retainOnFailure },
      })
    },
  }
}

/** PathGuard 迁移（事后审计）：记录执行前后项目工作区的文件变化。 */
export function pathGuardDiff(before: Record<string, string>, after: Record<string, string>): {
  changed: string[]
  created: string[]
  deleted: string[]
} {
  const changed: string[] = []
  const created: string[] = []
  const deleted: string[] = []
  for (const [path, hash] of Object.entries(after)) {
    if (!(path in before)) created.push(path)
    else if (before[path] !== hash) changed.push(path)
  }
  for (const path of Object.keys(before)) {
    if (!(path in after)) deleted.push(path)
  }
  return { changed, created, deleted }
}
