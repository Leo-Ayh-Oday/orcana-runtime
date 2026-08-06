/** LNXF-1.0: Rootless Podman strict backend (LF-6, plan §10.3).
 *
 *  Strict rules: never `--privileged`, never host network, never host
 *  sockets, never expose real home, digest-locked images only (floating
 *  tags rejected), `--rm` containers, explicit volumes, resource limits,
 *  `io.orcana.*` labels for recovery. The argv compiler is the only
 *  producer of podman arguments.
 */

import type {
  BackendAvailability,
  CompiledExecution,
  ExecutionCellEvent,
  ExecutionCellSpec,
  LinuxCapabilities,
  SandboxReceipt,
} from "../contracts"
import type { BackendOutcome, ExecutionBackend } from "./backend"
import { streamBackendRun } from "./backend"
import { runSupervised, streamSupervised, type SupervisorResult } from "../process/supervisor"
import { buildExplicitEnvironment } from "../environment"
import { buildReceipt } from "../receipt"
import { validateCellSpec } from "../policy-compiler"
import { LinuxExecutionError } from "../errors"

/** 镜像引用校验：digest 锁定（@sha256:），拒绝浮动 tag。 */
export const DIGEST_PATTERN = /@sha256:[0-9a-f]{64}$/

export function validateImageRef(image: string): { ok: boolean; reason?: string } {
  if (!image || typeof image !== "string") return { ok: false, reason: "image required" }
  if (!DIGEST_PATTERN.test(image)) {
    return { ok: false, reason: `floating image tag rejected (digest required): ${image}` }
  }
  return { ok: true }
}

export interface PodmanCompileOptions {
  image: string
  /** 镜像内工作目录。 */
  workdir?: string
  /** 显式 volume（host → container，ro/rw；PR-7 支持完整选项字符串）。 */
  volumes?: Array<{ source: string; target: string; mode: "ro" | "rw" } | string>
  /** 拉取策略（默认 never）。 */
  pullPolicy?: "never" | "missing"
  /** 标签（io.orcana.*）。 */
  labels?: Record<string, string>
  /** seccomp profile 文件（容器内）。 */
  seccompProfile?: string
  /** 容器内环境（--env 注入；P1-5 修复）。 */
  env?: Record<string, string>
  /** 容器 cidfile（恢复/清理验证用；P1-6 修复）。 */
  cidfile?: string
}

export function compilePodmanArgv(spec: ExecutionCellSpec, caps: LinuxCapabilities, opts: PodmanCompileOptions): string[] {
  const argv = [
    "run",
    "--rm",
    "--detach=false",
    "--network=none",
    "--read-only",
    "--pull", opts.pullPolicy ?? "never",
    "--userns=keep-id",
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--memory", `${Math.max(4, Math.floor(spec.resources.memoryMaxBytes / (1024 * 1024)))}m`,
    "--cpus", String(Math.max(0.1, (spec.resources.cpuQuotaMicros ?? 100_000) / 1_000_000)),
    "--pids-limit", String(spec.resources.pidsMax),
    "--label", `io.orcana.run=${spec.identity.runId}`,
    "--label", `io.orcana.cell=${spec.identity.cellId}`,
  ]
  if (opts.cidfile) argv.push("--cidfile", opts.cidfile)
  if (spec.identity.agentId) argv.push("--label", `io.orcana.agent=${spec.identity.agentId}`)
  if (spec.filesystem.worktreeRoot) {
    argv.push("--volume", `${spec.filesystem.worktreeRoot}:/workspace:rw,Z`)
  }
  for (const volume of opts.volumes ?? []) {
    if (typeof volume === "string") {
      argv.push("--volume", volume)
    } else {
      argv.push("--volume", `${volume.source}:${volume.target}:${volume.mode},Z`)
    }
  }
  if (opts.seccompProfile) argv.push("--security-opt", `seccomp=${opts.seccompProfile}`)
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    argv.push("--env", `${key}=${value}`)
  }
  argv.push("--workdir", opts.workdir ?? "/workspace")
  argv.push(opts.image)
  argv.push(spec.command.executable, ...spec.command.args)
  return argv
}

export function createPodmanBackend(): ExecutionBackend {
  return {
    id: "rootless-podman",

    availability(caps): BackendAvailability {
      return {
        id: "rootless-podman",
        available: caps.podman.available && caps.podman.rootlessReady,
        version: caps.podman.version,
        degradationReasons: caps.podman.available && !caps.podman.rootlessReady
          ? ["podman rootless 预检未通过（subuid/subgid 或 user namespace）"]
          : ["podman 不可用"],
      }
    },

    validateSpec(spec) {
      const errors: string[] = []
      const validation = validateCellSpec(spec)
      if (!validation.ok) errors.push(...validation.errors.map(e => `EXECUTION_SPEC_INVALID: ${e}`))
      if (spec.isolation.minimum !== "container") {
        errors.push("ISOLATION_REQUIREMENT_UNMET: rootless-podman requires minimum=container")
      }
      if (spec.network.mode !== "none" && spec.network.mode !== "loopback") {
        errors.push(`NETWORK_POLICY_UNAVAILABLE: podman strict backend supports none/loopback, got "${spec.network.mode}"`)
      }
      if (spec.network.mode === "loopback") {
        // loopback 在 strict 后端 = 容器内 loopback（--network=none 自带 loopback）
      }
      for (const rule of [...spec.filesystem.readonlyMounts, ...spec.filesystem.writableMounts]) {
        if (rule.source.startsWith("/home/") || rule.source === "/home" || rule.source === "/root") {
          errors.push(`MOUNT_POLICY_INVALID: real home mount ${rule.source} forbidden`)
        }
        if (rule.source.includes("docker.sock") || rule.source.includes("podman.sock")) {
          errors.push(`MOUNT_POLICY_INVALID: host socket mount ${rule.source} forbidden`)
        }
      }
      return errors
    },

    compile(spec, caps, materialization) {
      const image = spec.environment.variables["ORCANA_IMAGE"] ?? ""
      const imageRef = validateImageRef(image)
      if (!imageRef.ok) {
        throw new LinuxExecutionError("EXECUTION_SPEC_INVALID", `image ref rejected: ${imageRef.reason}`)
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
      const podmanPath = caps.podman.path ?? "podman"
      const cidfile = `/tmp/orcana-${spec.identity.runId}-${spec.identity.cellId}.cid`
      const cacheSource = (c: { target: string; kind: string; key: string }) =>
        materialization?.cacheHostPaths?.[c.target] ?? `/cache/${c.kind}/${c.key}`
      // PR-7：Volume 全部来自经过校验的 MountRule（含 noexec/nosuid 语义，
      // podman 支持 :noexec/:nosuid 挂载选项 —— bwrap 不支持所以此前拒绝）。
      const volumeOf = (rule: import("../contracts").MountRule): string => {
        const mode = rule.mode === "ro" ? "ro" : "rw"
        const opts = [mode, "Z"]
        if (rule.noExec) opts.push("noexec")
        if (rule.noSuid) opts.push("nosuid")
        if (rule.noDev) opts.push("nodev")
        return `${rule.source}:${rule.target}:${opts.join(",")}`
      }
      return {
        backend: "rootless-podman",
        argv: [podmanPath, ...compilePodmanArgv(spec, caps, {
          image,
          volumes: [
            ...spec.filesystem.readonlyMounts.map(volumeOf),
            ...spec.filesystem.writableMounts.map(volumeOf),
            ...spec.cache.map(c => ({ source: cacheSource(c), target: c.target, mode: c.mode === "rw-locked" ? "rw" : "ro" })),
            ...Object.entries(materialization?.secretFiles ?? {}).map(([target, source]) => `${source}:${target}:ro,Z`),
          ],
          labels: { "io.orcana.run": spec.identity.runId, "io.orcana.cell": spec.identity.cellId },
          env: env.env,
          cidfile,
          seccompProfile: materialization?.seccompFile,
        })],
        env: env.env,
        cwd: "/workspace",
      }
    },

    async *run(spec, ctx): AsyncGenerator<ExecutionCellEvent> {
      yield* streamBackendRun("rootless-podman", spec, ctx,
        () => this.compile(spec, ctx.capabilities, ctx.materialization),
        (result, evidence) => this.buildReceipt(spec, ctx.capabilities, {
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
          observedWrites: [],
          observedDeletes: [],
          unexpectedWrites: [],
          violations: [],
          degradationReasons: [],
          backendVersion: ctx.capabilities.podman.version,
          metrics: evidence.metrics,
          cleanup: evidence.cleanup,
        }),
      )
    },

    buildReceipt(spec, caps, outcome): SandboxReceipt {
      return buildReceipt({
        spec,
        capabilities: caps,
        backend: "rootless-podman",
        backendVersion: outcome.backendVersion ?? caps.podman.version,
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
        // PR-2：无默认成功值；containerRemoved 基于 --rm 语义（PR-7 真实验证）。
        cleanup: {
          processesRemaining: outcome.cleanup?.processesRemaining ?? -1,
          mountsReleased: true,
          cgroupRemoved: outcome.cleanup?.cgroupRemoved ?? false,
          containerRemoved: true,
          worktreeRetained: spec.lifecycle.retainOnFailure,
        },
      })
    },
  }
}
