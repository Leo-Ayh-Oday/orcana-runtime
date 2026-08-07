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
import { streamBackendRun } from "./backend"
import type { CompiledExecution } from "../contracts"
import { buildExplicitEnvironment } from "../environment"
import { buildReceipt } from "../receipt"
import { validateCellSpec } from "../policy-compiler"
import { snapshotWorkspace, pathGuardDiff, classifyUnexpectedWrites } from "./pathguard"

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
      // PR-4：host-audit 无法施加 noexec/nosuid 挂载语义 —— 无法保证则拒绝。
      for (const rule of [...spec.filesystem.readonlyMounts, ...spec.filesystem.writableMounts]) {
        if (rule.noExec || rule.noSuid || rule.noDev) {
          errors.push(`MOUNT_SEMANTICS_UNSUPPORTED: host-audit cannot enforce noExec/noSuid/noDev on ${rule.source}`)
        }
      }
      return errors
    },

    compile(spec) {
      const env = buildExplicitEnvironment({
        policy: {
          baseProfile: spec.profile === "inspect" || spec.profile === "untrusted" ? "minimal" : "build",
          allowedHostKeys: spec.environment.allowedHostKeys ?? [],
          fixedValues: {},
          requestedValues: spec.environment.variables,
          deniedKeys: [],
        },
        runId: spec.identity.runId,
        nodeRunId: spec.identity.nodeRunId,
        pathEntries: spec.environment.pathEntries,
      })
      return {
        backend: "host-audit",
        argv: [spec.command.executable, ...spec.command.args],
        env: env.env,
        cwd: spec.command.cwd,
      }
    },

    async *run(spec, ctx): AsyncGenerator<ExecutionCellEvent> {
      // R3 PathGuard：执行前快照（仅 worktreeRoot），结束后真实 diff。
      // 快照有界（OTS-004 修复）：超大文件跳过 + 总预算封顶，证据入 receipt.snapshotGuard。
      const worktreeRoot = spec.filesystem.worktreeRoot
      const before = worktreeRoot ? snapshotWorkspace(worktreeRoot) : undefined
      yield* streamBackendRun("host-audit", spec, ctx,
        () => this.compile(spec, ctx.capabilities),
        (result, evidence) => {
          const after = worktreeRoot ? snapshotWorkspace(worktreeRoot) : undefined
          const diff = before && after ? pathGuardDiff(before, after) : undefined
          return this.buildReceipt(spec, ctx.capabilities, {
            startedAt: evidence.startedAt,
            finishedAt: evidence.finishedAt,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            cancelled: result.cancelled,
            oomKilled: false,
            pidLimitHit: false,
            outputLimitHit: result.outputLimitHit,
            tempLimitHit: false,
            observedWrites: diff ? [...diff.created, ...diff.changed] : [],
            observedDeletes: diff ? diff.deleted : [],
            unexpectedWrites: diff ? classifyUnexpectedWrites(diff, spec.filesystem.ownerFiles) : [],
            violations: [],
            degradationReasons: [HOST_AUDIT_DEGRADATION],
            metrics: evidence.metrics,
            snapshotGuard: after
              ? { skippedLargeFiles: after.skippedLargeFiles, budgetExceeded: after.budgetExceeded, bytesHashed: after.bytesHashed }
              : undefined,
            cleanup: evidence.cleanup,
          })
        },
      )
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
        snapshotGuard: outcome.snapshotGuard,
        // PR-2：进程残留来自真实测量（countProcessGroup）；host-audit 无挂载/
        // 无 cgroup —— 不创建即无需移除（事实值），进程组实测为 0 才算干净。
        cleanup: {
          processesRemaining: outcome.cleanup?.processesRemaining ?? -1,
          mountsReleased: true,
          cgroupRemoved: true,
          worktreeRetained: spec.lifecycle.retainOnFailure,
        },
      })
    },
  }
}

/** 工作区快照与 diff 已迁移至 backends/pathguard.ts（bwrap 后端共用）。 */
export { snapshotWorkspace, pathGuardDiff, classifyUnexpectedWrites } from "./pathguard"
