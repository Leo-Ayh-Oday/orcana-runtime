/** LNXF-1.0: sandbox policy compiler (LF-1 骨架，LF-3 深化).
 *
 *  The ONLY formal entry point for building ExecutionCellSpecs that reach a
 *  backend (stop condition 8: 沙盒策略出现多套权威 → 拒绝). Model/tools can
 *  never assemble a spec — they declare needs; the compiler produces the
 *  spec.
 *
 *  LF-1 scope: spec validation + mount-rule validation (path normalization,
 *  escape checks, duplicate/parent-child target conflicts, system path
 *  policy). LF-3 adds the backend argv compiler.
 */

import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { existsSync, realpathSync } from "node:fs"
import { randomUUID } from "node:crypto"
import type { CapabilityRequest, ExecutionCellSpec, ExecutionProfile, IsolationMinimum, MountRule, NetworkMode } from "./contracts"
import { LinuxExecutionError } from "./errors"
import { hostKeyDenied } from "./environment"
import { applyProfileDefaults, profileDefaults, PROFILE_DEFAULTS } from "./profiles"

/** 隔离等级序：audit < namespace < container（数字越大越严格）。 */
const ISOLATION_LEVEL: Record<IsolationMinimum, number> = { audit: 0, namespace: 1, container: 2 }

/** 网络等级序：none < loopback < proxy-allowlist < full-approved（数字越大越开放）。 */
const NETWORK_LEVEL: Record<NetworkMode, number> = { none: 0, loopback: 1, "proxy-allowlist": 2, "full-approved": 3 }

/** 递归深度冻结（P0-1：编译产物不可变；Backend/Broker 禁止修改 Spec）。 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

/** 系统根目录集合 —— 默认只读白名单（plan §10.2）。 */
export const SYSTEM_READONLY_PATHS = [
  "/usr", "/bin", "/lib", "/lib64", "/etc/ssl/certs", "/etc/alternatives",
]

/** 永远禁止挂载的路径（plan §10.2 禁止清单）。 */
export const FORBIDDEN_MOUNT_PATHS = [
  "/root", "/home", "/run/user",
]

export const FORBIDDEN_MOUNT_SUFFIXES = [
  "/.ssh", "/.gnupg", "/.aws", "/.config/gcloud", "/.kube",
]

export const FORBIDDEN_SOCKET_PATHS = [
  "/run/docker.sock", "/var/run/docker.sock",
  "/run/user", "/run/podman", "/run/systemd",
]

export interface MountValidationResult {
  ok: boolean
  errors: string[]
  mounts: MountRule[]
}

/** 规范化 + 校验一条挂载规则。 */
export function validateMountRule(
  rule: MountRule,
  projectRoot?: string,
): { ok: boolean; error?: string; normalized?: MountRule } {
  if (!rule.source || !rule.target) return { ok: false, error: "mount requires source and target" }
  if (!isAbsolute(rule.source)) return { ok: false, error: `mount source must be absolute: ${rule.source}` }
  if (!isAbsolute(rule.target)) return { ok: false, error: `mount target must be absolute: ${rule.target}` }

  const source = normalize(rule.source)
  const target = normalize(rule.target)

  // 符号链接逃逸：真实路径检查（存在时）。
  if (existsSync(source)) {
    try {
      const real = realpathSync(source)
      const projReal = projectRoot ? realpathSafe(projectRoot) : null
      if (projReal && !(real === projReal || real.startsWith(projReal + sep))) {
        // 允许系统路径；禁止指向项目外的其他路径
        if (!SYSTEM_READONLY_PATHS.some(p => real === p || real.startsWith(p + sep))) {
          return { ok: false, error: `mount source escapes project via symlink: ${rule.source}` }
        }
      }
    } catch {
      // source 不存在 —— required 时在编译期拒绝
      if (rule.required) return { ok: false, error: `required mount source missing: ${rule.source}` }
    }
  } else if (rule.required) {
    return { ok: false, error: `required mount source missing: ${rule.source}` }
  }

  // 禁止清单。
  for (const forbidden of FORBIDDEN_MOUNT_PATHS) {
    if (source === forbidden || source.startsWith(forbidden + sep)) {
      return { ok: false, error: `mount of forbidden path: ${rule.source}` }
    }
  }
  for (const suffix of FORBIDDEN_MOUNT_SUFFIXES) {
    if (source.endsWith(suffix)) return { ok: false, error: `mount of credential path: ${rule.source}` }
  }
  for (const socket of FORBIDDEN_SOCKET_PATHS) {
    if (source === socket || source.startsWith(socket + sep)) {
      return { ok: false, error: `mount of host socket: ${rule.source}` }
    }
  }

  return { ok: true, normalized: { ...rule, source, target } }
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** 校验整组挂载：重复目标 + 父子挂载冲突。 */
export function validateMountSet(rules: MountRule[], projectRoot?: string): MountValidationResult {
  const errors: string[] = []
  const normalized: MountRule[] = []
  const targets = new Map<string, MountRule>()

  for (const rule of rules) {
    const checked = validateMountRule(rule, projectRoot)
    if (!checked.ok || !checked.normalized) {
      errors.push(checked.error ?? "invalid mount")
      continue
    }
    const existing = targets.get(checked.normalized.target)
    if (existing) {
      errors.push(`duplicate mount target: ${checked.normalized.target}`)
      continue
    }
    for (const [otherTarget, other] of targets) {
      if (otherTarget.startsWith(checked.normalized.target + sep) || checked.normalized.target.startsWith(otherTarget + sep)) {
        errors.push(`parent/child mount conflict: ${checked.normalized.target} vs ${otherTarget}`)
        break
      }
    }
    targets.set(checked.normalized.target, checked.normalized)
    normalized.push(checked.normalized)
  }
  return { ok: errors.length === 0, errors, mounts: normalized }
}

export interface ValidateSpecResult {
  ok: boolean
  errors: string[]
}

/** 全量 spec 校验（LF-1：身份/命令/挂载/网络/环境基本完整性）。
 *  P0-2 修复：Profile 是最终权威 —— 调用者只能收紧，不能放宽：
 *  - isolation.minimum 不得低于 Profile 最低隔离；
 *  - allowDegradation 不得把严格 Profile 放宽为 true；
 *  - network 不得比 Profile 默认更开放；
 *  - 命令 cwd 必须是绝对路径且存在性由后端编译期校验。
 */
export function validateCellSpec(spec: ExecutionCellSpec): ValidateSpecResult {
  const errors: string[] = []
  if (spec.schemaVersion !== "1.0") errors.push("schemaVersion must be 1.0")
  if (!spec.identity.cellId || !spec.identity.runId || !spec.identity.nodeRunId) errors.push("identity requires cellId/runId/nodeRunId")
  if (!spec.command.executable) errors.push("command.executable is required")
  if (!isAbsolute(spec.command.executable) && spec.command.executable.split("/").length > 1 && !spec.command.executable.startsWith("./")) {
    errors.push(`command.executable must be absolute or bare name: ${spec.command.executable}`)
  }
  if (!spec.command.cwd || !isAbsolute(spec.command.cwd)) errors.push("command.cwd must be absolute")
  if (spec.environment.inheritHost !== false) errors.push("environment.inheritHost must be false (no host env inheritance)")
  // P1-7 关闭：spec 声明的环境键不得落入默认拒绝集（密钥/凭证/代理）。
  const deniedDeclared = Object.keys(spec.environment.variables).filter(k => hostKeyDenied(k))
  const deniedAllowed = (spec.environment.allowedHostKeys ?? []).filter(k => hostKeyDenied(k))
  if (deniedDeclared.length > 0) errors.push(`environment.variables contains denied keys: ${deniedDeclared.join(", ")}`)
  if (deniedAllowed.length > 0) errors.push(`environment.allowedHostKeys contains denied keys: ${deniedAllowed.join(", ")}`)
  if (spec.resources.memoryMaxBytes <= 0) errors.push("resources.memoryMaxBytes must be positive")
  if (spec.resources.pidsMax <= 0) errors.push("resources.pidsMax must be positive")
  if (spec.resources.wallTimeMs <= 0) errors.push("resources.wallTimeMs must be positive")
  if (spec.network.mode === "proxy-allowlist" && !spec.network.allowedHosts?.length) {
    errors.push("network proxy-allowlist requires allowedHosts")
  }
  // P0-2：Profile 强制映射（编译器权威，调用者只能收紧）。
  // - 严格 Profile：minimum 不得低于 Profile 最低隔离；降级必须保持 false；
  //   network 不得比 Profile 默认更开放（不可达 host-audit）。
  // - 非严格 Profile（inspect/build）：minimum=audit 仅在 allowDegradation=true
  //   时允许（显式降级通道）；network 同样只允许收紧。
  const pdefaults = profileDefaults(spec.profile)
  if (spec.isolation.minimum === "audit") {
    if (!pdefaults.allowDegradation) {
      errors.push(`ISOLATION_AUDIT_NOT_ALLOWED_BY_PROFILE: profile "${spec.profile}" requires minimum "${pdefaults.minimum}" or above`)
    } else if (!spec.isolation.allowDegradation) {
      errors.push("ISOLATION_AUDIT_REQUIRES_DEGRADATION: minimum=audit requires allowDegradation=true")
    }
  } else if (ISOLATION_LEVEL[spec.isolation.minimum] < ISOLATION_LEVEL[pdefaults.minimum]) {
    errors.push(`ISOLATION_MINIMUM_BELOW_PROFILE: profile "${spec.profile}" requires isolation minimum "${pdefaults.minimum}", got "${spec.isolation.minimum}"`)
  }
  if (spec.isolation.allowDegradation && !pdefaults.allowDegradation) {
    errors.push(`DEGRADATION_NOT_ALLOWED_BY_PROFILE: profile "${spec.profile}" forbids degradation`)
  }
  if (NETWORK_LEVEL[spec.network.mode] > NETWORK_LEVEL[pdefaults.network]) {
    errors.push(`NETWORK_BROADER_THAN_PROFILE: profile "${spec.profile}" allows network "${pdefaults.network}", got "${spec.network.mode}"`)
  }
  if (spec.network.mode === "full-approved" && !spec.isolation.allowDegradation && spec.profile !== "service") {
    // full-approved 只允许显式批准（编译期不做，运行时 Broker 校验）
  }
  const mounts = validateMountSet([...spec.filesystem.readonlyMounts, ...spec.filesystem.writableMounts], spec.filesystem.worktreeRoot)
  if (!mounts.ok) errors.push(...mounts.errors.map(e => `mount: ${e}`))
  if (spec.policyDigest && spec.policyDigest !== computePolicyDigestLocal(spec)) {
    errors.push("policyDigest does not match spec content")
  }
  return { ok: errors.length === 0, errors }
}

import { computePolicyDigest as computePolicyDigestLocal } from "./receipt"

/** 资源只收紧：请求值超过 Profile 上限 → 钳制到上限（绝不放宽）。 */
export function clampResources(spec: ExecutionCellSpec): ExecutionCellSpec {
  const p = PROFILE_DEFAULTS[spec.profile]
  return {
    ...spec,
    resources: {
      ...spec.resources,
      memoryMaxBytes: Math.min(spec.resources.memoryMaxBytes, p.memoryMaxBytes),
      memoryHighBytes: spec.resources.memoryHighBytes === undefined
        ? undefined
        : Math.min(spec.resources.memoryHighBytes, p.memoryHighBytes),
      pidsMax: Math.min(spec.resources.pidsMax, p.pidsMax),
    },
  }
}

/** 编译器入口：给定声明需求 → 完整 spec。LF-1 仅校验 + 填充 digest。
 *  P0-1/P0-2 修复：资源钳制、Profile 最低隔离强制、policyDigest 由编译器
 *  权威计算、产物深度冻结（Backend/Broker 不得再修改）。
 */
export function compileCellSpec(
  spec: ExecutionCellSpec,
): { ok: true; spec: ExecutionCellSpec } | { ok: false; errors: string[] } {
  const clamped = clampResources(spec)
  const validation = validateCellSpec(clamped)
  if (!validation.ok) return { ok: false, errors: validation.errors }
  const withDigest: ExecutionCellSpec = { ...clamped, policyDigest: computePolicyDigestLocal(clamped) }
  return { ok: true, spec: deepFreeze(withDigest) }
}

export interface CompileRequestContext {
  runId?: string
  nodeRunId?: string
  agentId?: string
  assignmentId?: string
  attempt?: number
}

/** Capability Request → 冻结 Spec（P0-1/P0-2：身份由 Runtime 生成、Profile
 *  是隔离权威、override 只能收紧）。工具/模型绝不直接提交 ExecutionCellSpec。 */
export function compileCapabilityRequest(
  request: CapabilityRequest,
  ctx: CompileRequestContext = {},
): { ok: true; spec: ExecutionCellSpec } | { ok: false; errors: string[] } {
  const attempt = request.attempt ?? ctx.attempt ?? 1
  const runId = request.runId ?? ctx.runId ?? `run-${randomUUID().slice(0, 8)}`
  const nodeRunId = request.nodeRunId ?? ctx.nodeRunId ?? `${runId}:n${attempt}`
  const cellId = `cell-${randomUUID().slice(0, 8)}`
  const identity = { cellId, runId, nodeRunId, attempt, agentId: request.agentId ?? ctx.agentId, assignmentId: request.assignmentId ?? ctx.assignmentId }

  const overrides: Partial<ExecutionCellSpec> = {
    isolation: {
      minimum: PROFILE_DEFAULTS[request.profile].minimum,
      preferredBackend: "auto",
      allowDegradation: PROFILE_DEFAULTS[request.profile].allowDegradation,
    },
    filesystem: {
      readonlyMounts: request.readonlyMounts ?? [],
      writableMounts: request.writableMounts ?? [],
      tmpfsMounts: [],
      hiddenPaths: [],
      emptyHome: PROFILE_DEFAULTS[request.profile].emptyHome,
      worktreeRoot: request.worktreeRoot,
      ownerFiles: request.ownerFiles,
    },
    network: {
      mode: request.network?.mode ?? PROFILE_DEFAULTS[request.profile].network,
      ...(request.network?.allowedHosts ? { allowedHosts: request.network.allowedHosts } : {}),
      ...(request.network?.allowedPorts ? { allowedPorts: request.network.allowedPorts } : {}),
    },
    environment: {
      variables: request.env ?? {},
      allowedHostKeys: request.allowedHostKeys ?? [],
      inheritHost: false,
      locale: "C.UTF-8",
      pathEntries: ["/usr/local/bin"],
    },
    secrets: [],
    cache: request.cache ?? [],
    resources: {
      memoryMaxBytes: request.memoryMaxBytes ?? PROFILE_DEFAULTS[request.profile].memoryMaxBytes,
      memoryHighBytes: PROFILE_DEFAULTS[request.profile].memoryHighBytes,
      pidsMax: request.pidsMax ?? PROFILE_DEFAULTS[request.profile].pidsMax,
      wallTimeMs: request.timeoutMs ?? 120_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 4 * 1024 * 1024,
      stderrMaxBytes: request.stderrMaxBytes ?? 4 * 1024 * 1024,
      tmpfsMaxBytes: 1024 * 1024 * 1024,
    },
    lifecycle: { killOnParentExit: true, cleanupOnExit: true, retainOnFailure: false, serviceMode: request.profile === "service" },
    policyDigest: "",
  }

  const command = {
    executable: request.command.executable,
    args: request.command.args,
    cwd: request.command.cwd ?? "/workspace",
    stdin: request.command.stdin ?? "closed",
  }

  const spec = applyProfileDefaults(identity, command, request.profile, overrides)
  return compileCellSpec(spec)
}
