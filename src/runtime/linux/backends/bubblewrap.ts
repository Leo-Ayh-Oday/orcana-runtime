/** LNXF-1.0: Bubblewrap fast backend (LF-3, plan §10.2).
 *
 *  Default namespaces: user/mount/pid/ipc/uts/net. Root layout: read-only
 *  system paths, new PID /proc, minimal /dev, independent tmpfs for /tmp
 *  and /run, empty /home/orcana, worktree at /workspace, explicit cache
 *  mounts. --die-with-parent --new-session --clearenv. The argv compiler is
 *  the ONLY producer of bwrap arguments (models/tools can never assemble
 *  them).
 */

import type {
  BackendAvailability,
  CompiledExecution,
  ExecutionCellEvent,
  ExecutionCellSpec,
  LinuxCapabilities,
  MountRule,
  SandboxReceipt,
} from "../contracts"
import type { ExecutionMaterialization } from "../contracts"
import type { BackendOutcome, ExecutionBackend } from "./backend"
import { streamBackendRun } from "./backend"
import { runSupervised, streamSupervised, type SupervisorResult } from "../process/supervisor"
import { buildExplicitEnvironment } from "../environment"
import { buildReceipt } from "../receipt"
import { validateCellSpec } from "../policy-compiler"
import { SYSTEM_READONLY_PATHS } from "../policy-compiler"
import { snapshotWorkspace, pathGuardDiff, classifyUnexpectedWrites } from "./pathguard"
import { existsSync } from "node:fs"
import { LinuxExecutionError } from "../errors"

/** 默认根布局（plan §10.2）—— ro 系统路径。 */
export const DEFAULT_ROOT_LAYOUT: MountRule[] = SYSTEM_READONLY_PATHS.map(source => ({
  source,
  target: source,
  mode: "ro",
  required: true,
  recursive: true,
  noExec: false,
  noDev: true,
  noSuid: true,
}))

export const BWRAP_FORBIDDEN_MOUNTS = [
  "/root", "/home", "/run/user", "/run/docker.sock", "/var/run/docker.sock",
  "/run/podman", "/run/systemd",
]

export interface BwrapCompileOptions {
  /** 挂载到沙盒内的 worktree 根（rw）。 */
  worktreeRoot?: string
  /** 只读挂载附加项。 */
  extraReadonly?: MountRule[]
  /** 可写挂载附加项。 */
  extraWritable?: MountRule[]
  /** tmpfs 挂载（默认 /tmp、/run）。 */
  tmpfs?: Array<{ target: string; sizeBytes: number }>
  /** 显式隐藏路径（在布局之后隐藏，实现为不挂载——编译期校验拒绝）。 */
  hiddenPaths?: string[]
  /** 缓存挂载（target → 宿主源；rw 缓存由 cacheMountsRw 表达）。 */
  cacheMounts?: Array<{ target: string; source: string }>
  /** rw 缓存挂载（rw-locked 缓存独占写）。 */
  cacheMountsRw?: Array<{ target: string; source: string }>
  /** 沙盒内环境（--setenv 逐项注入；P1-1 修复）。 */
  setenv?: Record<string, string>
  /** loopback 模式：netns 内显式拉起 lo（none 模式不注入）。 */
  loopbackOnly?: boolean
  seccompFile?: string
}

const GB = 1024 * 1024 * 1024

export function defaultTmpfs(): Array<{ target: string; sizeBytes: number }> {
  return [
    { target: "/tmp", sizeBytes: 512 * 1024 * 1024 },
    { target: "/run", sizeBytes: 64 * 1024 * 1024 },
  ]
}

/** 编译 bwrap argv（Policy Compiler 唯一来源）。 */
export function compileBwrapArgv(spec: ExecutionCellSpec, caps: LinuxCapabilities, opts: BwrapCompileOptions = {}): string[] {
  const argv: string[] = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--proc", "/proc",
    "--dev", "/dev",
  ]

  // PR-4：tmpfs 大小必须生效 —— bwrap 用 `--size N` 约束下一个挂载点。
  const tmpfs = opts.tmpfs ?? defaultTmpfs()
  for (const t of tmpfs) {
    argv.push("--size", String(t.sizeBytes), "--tmpfs", t.target)
  }

  // 只读系统根。
  for (const mount of [...DEFAULT_ROOT_LAYOUT, ...(opts.extraReadonly ?? [])]) {
    argv.push(mount.mode === "rw" ? "--bind" : "--ro-bind", mount.source, mount.target)
  }

  // 空 Home。
  argv.push("--dir", "/home/orcana")

  // Worktree rw 挂载（PR-4：/workspace 必须存在 —— 编译期已强制 worktreeRoot）。
  const worktree = opts.worktreeRoot ?? spec.filesystem.worktreeRoot
  if (worktree) {
    argv.push("--bind", worktree, "/workspace")
  }

  // 可写挂载。
  for (const mount of opts.extraWritable ?? []) {
    argv.push("--bind", mount.source, mount.target)
  }

  // 缓存挂载（ro 或 rw —— LF-5 缓存管理接线）。
  for (const cache of opts.cacheMounts ?? []) {
    argv.push("--ro-bind", cache.source, cache.target)
  }
  for (const cache of opts.cacheMountsRw ?? []) {
    argv.push("--bind", cache.source, cache.target)
  }

  // 沙盒内环境（P1-1：--clearenv 后 --setenv 注入 compiled.env）。
  for (const [key, value] of Object.entries(opts.setenv ?? {})) {
    argv.push("--setenv", key, value)
  }

  // seccomp（PR-4）：bwrap --seccomp 协议要求已打开的文件描述符数字。
  // FD 3 为 supervisor 与后端约定的 seccomp 专用槽位（文件经 stdio[3] 继承）。
  if (opts.seccompFile) {
    argv.push("--seccomp", "3")
  }

  // 工作目录：沙盒内部 /workspace（宿主 spawn cwd 在 CompiledExecution.cwd）。
  argv.push("--chdir", "/workspace")

  return argv
}

/** loopback 模式命令包装：netns 内先拉起 lo 再执行目标。
 *  PR-4：参数绝不拼接进 shell 字符串 —— 固定脚本 `exec "$@"` 通过位置参数
 *  传递 target/args，模型/仓库参数无法进入 shell 解释层（消除注入面）。 */
export function loopbackWrapper(caps: LinuxCapabilities, target: string, args: string[]): { executable: string; args: string[] } {
  return {
    executable: "/bin/sh",
    args: ["-c", 'ip link set lo up 2>/dev/null; exec "$@"', "sh", target, ...args],
  }
}

export function createBubblewrapBackend(): ExecutionBackend {
  return {
    id: "bubblewrap",

    availability(caps): BackendAvailability {
      return {
        id: "bubblewrap",
        available: caps.bubblewrap.available && caps.bubblewrap.unprivilegedUsable,
        version: caps.bubblewrap.version,
        degradationReasons: caps.bubblewrap.available && !caps.bubblewrap.unprivilegedUsable
          ? ["bubblewrap 存在但无法使用非特权用户命名空间"]
          : ["bubblewrap 不可用"],
      }
    },

    validateSpec(spec) {
      const errors: string[] = []
      const validation = validateCellSpec(spec)
      if (!validation.ok) errors.push(...validation.errors.map(e => `EXECUTION_SPEC_INVALID: ${e}`))
      if (spec.isolation.minimum === "container") {
        errors.push("ISOLATION_REQUIREMENT_UNMET: bubblewrap cannot satisfy minimum=container")
      }
      if (spec.network.mode !== "none" && spec.network.mode !== "loopback") {
        errors.push(`NETWORK_POLICY_UNAVAILABLE: bubblewrap (LF-3) supports none/loopback only, got "${spec.network.mode}"`)
      }
      // PR-4：/workspace 必须存在 —— worktreeRoot 缺失时无法保证 chdir 目标，
      // fail-closed（不允许静默产生启动即失败的坏 argv）。
      if (!spec.filesystem.worktreeRoot) {
        errors.push("WORKSPACE_MISSING: bubblewrap requires filesystem.worktreeRoot (mounted at /workspace)")
      }
      for (const rule of [...spec.filesystem.readonlyMounts, ...spec.filesystem.writableMounts]) {
        if (BWRAP_FORBIDDEN_MOUNTS.some(p => rule.source === p || rule.source.startsWith(p + "/"))) {
          errors.push(`MOUNT_POLICY_INVALID: forbidden mount ${rule.source}`)
        }
        if (rule.source.startsWith("/home/") || rule.source === "/home") {
          errors.push(`MOUNT_POLICY_INVALID: real home mount ${rule.source} forbidden`)
        }
        // PR-4：bwrap 无法施加 noexec/nosuid 挂载语义（无对应参数）→ 显式拒绝。
        if (rule.noExec || rule.noSuid || rule.noDev) {
          errors.push(`MOUNT_SEMANTICS_UNSUPPORTED: bubblewrap cannot enforce noExec/noSuid/noDev on ${rule.source}`)
        }
      }
      return errors
    },

    compile(spec, caps, materialization) {
      // PR-4：宿主 spawn cwd 与沙盒内部 cwd 分离 —— 宿主侧必须是真实存在的目录。
      if (!existsSync(spec.command.cwd)) {
        throw new LinuxExecutionError("PROCESS_START_FAILED", `host cwd does not exist: ${spec.command.cwd}`)
      }
      const env = buildExplicitEnvironment({
        policy: {
          baseProfile: "minimal",
          allowedHostKeys: spec.environment.allowedHostKeys ?? [],
          fixedValues: {},
          requestedValues: spec.environment.variables,
          deniedKeys: [],
        },
        runId: spec.identity.runId,
        nodeRunId: spec.identity.nodeRunId,
        pathEntries: ["/usr/local/bin"],
        secrets: materialization?.secretEnv,
      })
      const tmpfs = [
        ...defaultTmpfs(),
        ...spec.filesystem.tmpfsMounts.map(t => ({ target: t.target, sizeBytes: t.sizeBytes })),
      ]
      // 缓存宿主路径由 Runtime 物化（CacheManager 权威，模型不可指定）。
      const cacheSource = (c: { target: string; kind: string; key: string }) =>
        materialization?.cacheHostPaths?.[c.target] ?? `/cache/${c.kind}/${c.key}`
      // PR-7：sealed-file secrets 真实挂载进沙盒（ro）。
      const secretMounts: MountRule[] = Object.entries(materialization?.secretFiles ?? {})
        .map(([target, source]) => ({ source, target, mode: "ro" as const, required: true, recursive: false }))
      const argv = compileBwrapArgv(spec, caps, {
        worktreeRoot: spec.filesystem.worktreeRoot,
        extraReadonly: [...spec.filesystem.readonlyMounts, ...secretMounts],
        extraWritable: spec.filesystem.writableMounts,
        tmpfs,
        hiddenPaths: spec.filesystem.hiddenPaths,
        loopbackOnly: spec.network.mode === "loopback",
        cacheMounts: spec.cache.filter(c => c.mode === "ro").map(c => ({ target: c.target, source: cacheSource(c) })),
        cacheMountsRw: spec.cache.filter(c => c.mode === "rw-locked").map(c => ({ target: c.target, source: cacheSource(c) })),
        setenv: env.env,
        seccompFile: materialization?.seccompFile,
      })
      // 编译不依赖 binary 存在（执行时由 run 层校验）；PATH 解析兜底。
      const bwrapPath = caps.bubblewrap.path ?? "bwrap"
      const targetExec = spec.command.executable
      const targetArgs = spec.command.args
      const entry = spec.network.mode === "loopback"
        ? loopbackWrapper(caps, targetExec, targetArgs)
        : { executable: targetExec, args: targetArgs }
      return {
        backend: "bubblewrap",
        argv: [bwrapPath, ...argv, entry.executable, ...entry.args],
        env: env.env,
        // PR-4：宿主 spawn cwd（真实存在）；沙盒内部 cwd 由 --chdir /workspace 决定。
        cwd: spec.command.cwd,
        seccompFdPath: materialization?.seccompFile,
      }
    },

    async *run(spec, ctx): AsyncGenerator<ExecutionCellEvent> {
      // PR-4：PathGuard —— worktree 内容快照 diff + ownerFiles 之外 → unexpectedWrites。
      const worktreeRoot = spec.filesystem.worktreeRoot
      const before = worktreeRoot ? snapshotWorkspace(worktreeRoot) : undefined
      yield* streamBackendRun("bubblewrap", spec, ctx,
        () => this.compile(spec, ctx.capabilities, ctx.materialization),
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
            unexpectedWrites: diff ? classifyUnexpectedWrites(diff, spec.filesystem.ownerFiles) : [],
            violations: [],
            degradationReasons: [],
            backendVersion: ctx.capabilities.bubblewrap.version,
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
        backend: "bubblewrap",
        backendVersion: outcome.backendVersion ?? caps.bubblewrap.version,
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
        degradationReasons: outcome.degradationReasons,
        // PR-2：无默认成功值 —— 进程残留/移除来自实测；mountsReleased 是
        // bwrap 进程退出即销毁 mount 命名空间的内核事实。
        cleanup: {
          processesRemaining: outcome.cleanup?.processesRemaining ?? -1,
          mountsReleased: true,
          cgroupRemoved: outcome.cleanup?.cgroupRemoved ?? false,
          worktreeRetained: spec.lifecycle.retainOnFailure,
        },
      })
    },
  }
}
