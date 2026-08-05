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
import type { ExecutionCellSpec, MountRule } from "./contracts"
import { LinuxExecutionError } from "./errors"
import { hostKeyDenied } from "./environment"

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

/** 全量 spec 校验（LF-1：身份/命令/挂载/网络/环境基本完整性）。 */
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

/** 编译器入口：给定声明需求 → 完整 spec。LF-1 仅校验 + 填充 digest。 */
export function compileCellSpec(
  spec: ExecutionCellSpec,
): { ok: true; spec: ExecutionCellSpec } | { ok: false; errors: string[] } {
  const validation = validateCellSpec(spec)
  if (!validation.ok) return { ok: false, errors: validation.errors }
  const withDigest: ExecutionCellSpec = { ...spec, policyDigest: computePolicyDigestLocal(spec) }
  return { ok: true, spec: withDigest }
}
