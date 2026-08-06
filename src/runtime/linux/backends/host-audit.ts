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
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { createHash } from "node:crypto"
import { runSupervised, streamSupervised, type SupervisorResult } from "../process/supervisor"
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
      const worktreeRoot = spec.filesystem.worktreeRoot
      const before = worktreeRoot ? snapshotWorkspace(worktreeRoot) : undefined
      yield* streamBackendRun("host-audit", spec, ctx,
        () => this.compile(spec, ctx.capabilities),
        (result, evidence) => {
          const diff = before && worktreeRoot ? pathGuardDiff(before, snapshotWorkspace(worktreeRoot)) : undefined
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
            unexpectedWrites: [],
            violations: [],
            degradationReasons: [HOST_AUDIT_DEGRADATION],
            metrics: evidence.metrics,
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

/** 工作区快照（统计指纹：size:mtime，避免全量内容哈希开销）。 */
export function snapshotWorkspace(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.name === ".git" || entry.name === "node_modules") continue
      try {
        const st = statSync(full)
        if (entry.isDirectory()) walk(full)
        else {
          // 内容指纹（时间戳在粗粒度 fs 上不可靠）。
          const content = readFileSync(full)
          out[relative(root, full).replace(/\\/g, "/")] = createHash("sha256").update(content).digest("hex").slice(0, 16)
        }
      } catch { /* 不可读跳过 */ }
    }
  }
  walk(root)
  return out
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
