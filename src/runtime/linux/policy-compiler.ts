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
import type { ExecutionCellSpec, ExecutionProfile, IsolationMinimum, MountRule, NetworkMode, RequestedMount, TrustedExecutionAuthority, UntrustedCapabilityRequest } from "./contracts"
import { LinuxExecutionError } from "./errors"
import { hostKeyDenied } from "./environment"
import { applyProfileDefaults, profileDefaults, PROFILE_DEFAULTS } from "./profiles"
import { WorkspaceAuthorityRegistry } from "./workspace/workspace-authority"

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

/** realpath 是否落在系统只读白名单内。 */
function isSystemPath(real: string): boolean {
  return SYSTEM_READONLY_PATHS.some(p => real === p || real.startsWith(p + sep))
}

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
      if (projectRoot) {
        const projReal = realpathSafe(projectRoot)
        if (!(real === projReal || real.startsWith(projReal + sep)) && !isSystemPath(real)) {
          return { ok: false, error: `mount source escapes project via symlink: ${rule.source}` }
        }
      } else if (!(real === source) && !isSystemPath(real)) {
        // LNXF-R2 9.8：无 worktree 上下文时逃逸检查不得跳过（fail-closed）
        return { ok: false, error: `mount source escapes via symlink (no workspace context): ${rule.source}` }
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

/** 沿路径向根回溯，返回最近存在路径的 realpath（不存在时返回 null）。
 *  LNXF-R2 9.1：cwd 候选目录不存在时，其父级可能是逃逸 symlink ——
 *  必须解析存在的最近前缀而非直接信任 resolve()。 */
function realpathOfNearestExisting(path: string): string | null {
  let p = path
  for (;;) {
    if (existsSync(p)) {
      try {
        return realpathSync(p)
      } catch {
        return null
      }
    }
    const parent = p.slice(0, p.lastIndexOf(sep))
    if (parent === "" || parent === p) return null
    p = parent
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
  // LNXF-R2 10.3（INV-R）：声明但无生产执行权威的字段 → 编译期拒绝，
  // 禁止"字段存在、Compiler 接受、Backend 忽略"。
  if (spec.resources.readBpsMax !== undefined) {
    errors.push("RESOURCE_DECLARED_BUT_NOT_ENFORCED: readBpsMax not yet enforced by any backend")
  }
  if (spec.resources.writeBpsMax !== undefined) {
    errors.push("RESOURCE_DECLARED_BUT_NOT_ENFORCED: writeBpsMax not yet enforced by any backend")
  }
  if (spec.resources.maxOpenFiles !== undefined) {
    errors.push("RESOURCE_DECLARED_BUT_NOT_ENFORCED: maxOpenFiles not yet enforced by any backend")
  }
  if (spec.resources.ioWeight !== undefined && spec.resources.ioWeight !== 0) {
    // io 控制器不在委托验证集（cpu/memory/pids）——cell 层 io.weight 属性
    // 在真实内核下缺失，writeAttr 必失败；拒绝而非假装支持。
    errors.push("RESOURCE_DECLARED_BUT_NOT_ENFORCED: ioWeight requires io controller which is not in the verified delegation set")
  }
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
      // LNXF-R2 10.2：cpuMillis 只收紧（Profile 上限 = 默认 1 核）
      cpuMillis: spec.resources.cpuMillis === undefined
        ? p.cpuMillis
        : Math.min(spec.resources.cpuMillis, p.cpuMillis),
      cpuQuotaMicros: spec.resources.cpuQuotaMicros === undefined
        ? p.cpuQuotaMicros
        : Math.min(spec.resources.cpuQuotaMicros, p.cpuQuotaMicros),
      cpuPeriodMicros: spec.resources.cpuPeriodMicros === undefined
        ? p.cpuPeriodMicros
        : spec.resources.cpuPeriodMicros,
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

/** R2 PR-9：Untrusted Capability Request + Trusted Execution Authority
 *  → 冻结 Spec（INV-A/INV-B）。
 *
 *  身份（runId/nodeRunId/attempt/agentId/assignmentId）只来自 authority；
 *  worktreeRoot/ownerFiles 只来自 authority.workspace；command.cwd 由
 *  authority.workspace + relativeCwd 权威解析。请求不得覆盖任何权威字段。
 */
/** B2（R2）：namespace/container 隔离下沙盒可继承的安全宿主键 ——
 *  registry 凭据键（NPM_CONFIG_* / YARN_* / PNPM_* / BUN_*）被裁剪。 */
const SAFE_SANDBOX_HOST_KEYS = [
  "PATH", "HOME", "TMPDIR", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE",
  "TERM", "CI", "USER", "LOGNAME",
]

export function compileCapabilityRequest(
  request: UntrustedCapabilityRequest,
  authority: TrustedExecutionAuthority,
  registry?: WorkspaceAuthorityRegistry,
): { ok: true; spec: ExecutionCellSpec } | { ok: false; errors: string[] } {
  const attempt = authority.identity.attempt
  const cellId = `cell-${randomUUID().slice(0, 8)}`
  const identity = { cellId, ...authority.identity }
  const workspace = authority.workspace

  let canonicalCwd: string
  try {
    canonicalCwd = registry
      ? registry.resolveCwd(workspace, request.command.relativeCwd)
      : resolveAuthorizedCwd(workspace, request.command.relativeCwd)
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  }

  // B2：按隔离收窄宿主键继承（audit 原样；namespace/container 只保留安全键）。
  const isolation = {
    minimum: PROFILE_DEFAULTS[request.profile].minimum,
    preferredBackend: "auto" as const,
    allowDegradation: PROFILE_DEFAULTS[request.profile].allowDegradation,
  }
  const allowedHostKeys = isolation.minimum === "audit"
    ? (request.allowedHostKeys ?? [])
    : (request.allowedHostKeys ?? []).filter(k => SAFE_SANDBOX_HOST_KEYS.includes(k))

  // LNXF-R2 9.3：请求挂载 → 权威 MountRule（workspace-relative 解析 +
  // reserved target 策略；runtime-grant 未开放前编译期拒绝）。
  const mountErrors: string[] = []
  const readonlyMounts: MountRule[] = []
  for (const m of request.readonlyMounts ?? []) {
    const r = resolveRequestedMount(m, workspace, "ro")
    if (r.ok) readonlyMounts.push(r.rule)
    else mountErrors.push(r.error)
  }
  const writableMounts: MountRule[] = []
  for (const m of request.writableMounts ?? []) {
    const r = resolveRequestedMount(m, workspace, "rw")
    if (r.ok) writableMounts.push(r.rule)
    else mountErrors.push(r.error)
  }
  if (mountErrors.length > 0) return { ok: false, errors: mountErrors }

  const overrides: Partial<ExecutionCellSpec> = {
    isolation,
    filesystem: {
      readonlyMounts,
      writableMounts,
      tmpfsMounts: [],
      hiddenPaths: [],
      emptyHome: PROFILE_DEFAULTS[request.profile].emptyHome,
      worktreeRoot: workspace.hostRoot,
      ownerFiles: [...workspace.ownerFiles],
    },
    network: {
      mode: request.network?.mode ?? PROFILE_DEFAULTS[request.profile].network,
      ...(request.network?.allowedHosts ? { allowedHosts: request.network.allowedHosts } : {}),
      ...(request.network?.allowedPorts ? { allowedPorts: request.network.allowedPorts } : {}),
    },
    environment: {
      variables: request.env ?? {},
      allowedHostKeys,
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
      // LNXF-R2 10.2：cpuMillis 记账 + cgroup 物化配额（Profile 默认 = 1 核）
      cpuMillis: PROFILE_DEFAULTS[request.profile].cpuMillis,
      cpuQuotaMicros: PROFILE_DEFAULTS[request.profile].cpuQuotaMicros,
      cpuPeriodMicros: PROFILE_DEFAULTS[request.profile].cpuPeriodMicros,
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
    cwd: canonicalCwd,
    stdin: request.command.stdin ?? "closed",
  }

  const spec = applyProfileDefaults(identity, command, request.profile, overrides)
  return compileCellSpec(spec)
}

/** LNXF-R2 9.3：reserved mount target 策略 —— 挂载请求只能落在工作区/
 *  缓存/secret 例外前缀；根与系统路径不可被请求覆盖（/workspaceX 等
 *  前缀混淆经精确段匹配排除）。 */
const RESERVED_MOUNT_TARGETS = ["/proc", "/dev", "/sys", "/usr", "/bin", "/lib", "/lib64", "/etc", "/run", "/var", "/tmp"]
const ALLOWED_MOUNT_TARGET_PREFIXES = ["/workspace", "/cache", "/run/secrets"]

function reservedMountTargetViolation(target: string): string | null {
  const t = normalize(target)
  if (!isAbsolute(t)) return `mount target must be absolute: ${target}`
  if (ALLOWED_MOUNT_TARGET_PREFIXES.some(p => t === p || t.startsWith(p + "/"))) return null
  if (t === "/") return `reserved mount target: ${target}`
  for (const r of RESERVED_MOUNT_TARGETS) {
    if (t === r || t.startsWith(r + "/")) return `reserved mount target: ${target}`
  }
  return null
}

/** 请求挂载 → 权威 MountRule（宿主路径由编译器解析；模型不可指定绝对
 *  source）。mode 由声明通道强制（readonlyMounts → ro、writableMounts
 *  → rw），编译器不可放宽。 */
function resolveRequestedMount(
  mount: RequestedMount,
  workspace: import("./contracts").AuthorizedWorkspace,
  modeForced: "ro" | "rw",
): { ok: true; rule: MountRule } | { ok: false; error: string } {
  const targetErr = reservedMountTargetViolation(mount.target)
  if (targetErr) return { ok: false, error: targetErr }
  if (mount.source.type === "runtime-grant") {
    return { ok: false, error: `RUNTIME_GRANT_UNAVAILABLE: runtime-grant mounts not yet supported (grantId=${mount.source.grantId})` }
  }
  const requested = mount.source.path
  if (requested.includes("\0")) return { ok: false, error: "mount path contains NUL byte" }
  if (isAbsolute(requested)) return { ok: false, error: `mount path must be workspace-relative: ${requested}` }
  if (requested.split(sep).includes("..")) return { ok: false, error: `mount path must stay inside workspace: ${requested}` }
  const source = resolve(workspace.hostRoot, normalize(requested))
  if (source !== workspace.hostRoot && !source.startsWith(workspace.hostRoot + sep)) {
    return { ok: false, error: `mount path escapes workspace: ${requested}` }
  }
  return {
    ok: true,
    rule: { source, target: normalize(mount.target), mode: modeForced, required: true, recursive: true },
  }
}

/** 相对逻辑 cwd → canonical host cwd（无 Registry 时的直接解析；同
 *  WorkspaceAuthorityRegistry.resolveCwd 语义）。 */
export function resolveAuthorizedCwd(
  workspace: import("./contracts").AuthorizedWorkspace,
  requestedRelativeCwd?: string,
): string {
  const relative = requestedRelativeCwd ?? "."
  if (relative.includes("\0")) {
    throw new LinuxExecutionError("WORKSPACE_PATH_ESCAPE", "cwd contains NUL byte")
  }
  if (isAbsolute(relative)) {
    throw new LinuxExecutionError("WORKSPACE_PATH_ESCAPE", `cwd must be relative to workspace: ${relative}`)
  }
  if (relative.split(sep).includes("..")) {
    throw new LinuxExecutionError("WORKSPACE_PATH_ESCAPE", `cwd must stay inside workspace: ${relative}`)
  }
  const candidate = resolve(workspace.hostRoot, normalize(relative))
  if (candidate !== workspace.hostRoot && !candidate.startsWith(workspace.hostRoot + sep)) {
    throw new LinuxExecutionError("WORKSPACE_PATH_ESCAPE", `cwd escapes workspace: ${relative}`)
  }
  // LNXF-R2 9.1：candidate 不存在时必须沿父目录链检查最近的已存在前缀 ——
  // worktree/link/child 中 link→/etc 时 child 不存在，旧实现回退到 hostRoot
  // 的 realpath 直接放行（父级 symlink 逃逸）。
  const realProbe = realpathOfNearestExisting(candidate) ?? resolve(workspace.hostRoot)
  if (realProbe !== workspace.hostRoot && !realProbe.startsWith(workspace.hostRoot + sep)) {
    throw new LinuxExecutionError("WORKSPACE_PATH_ESCAPE", `cwd escapes workspace via symlink: ${candidate}`)
  }
  if (!existsSync(candidate)) {
    throw new LinuxExecutionError("WORKSPACE_CWD_MISSING", `cwd missing: ${candidate}`)
  }
  return candidate
}

// ── LR2-2（P2-D）：Plan Cache 接入 —— 编译结果模板缓存 ──

/** 请求策略分量的稳定 digest（缓存键的一部分）。
 *  B1 修复（LR2-2 审核）：**全部**进入 spec 的请求派生字段必须在键内 ——
 *  遗漏 timeoutMs/memoryMaxBytes/pidsMax/stdoutMaxBytes/stderrMaxBytes/
 *  relativeCwd/stdin 会让命中路径重放首个请求的声明值（资源控制旁路 +
 *  超时放大）并跳过当前请求的 cwd 逃逸校验。 */
export function policyRequestDigest(request: UntrustedCapabilityRequest): string {
  return digestOfRequestPolicy({
    executable: request.command.executable,
    args: request.command.args,
    relativeCwd: request.command.relativeCwd,
    stdin: request.command.stdin,
    profile: request.profile,
    network: request.network,
    env: request.env ?? {},
    allowedHostKeys: request.allowedHostKeys ?? [],
    timeoutMs: request.timeoutMs,
    memoryMaxBytes: request.memoryMaxBytes,
    pidsMax: request.pidsMax,
    stdoutMaxBytes: request.stdoutMaxBytes,
    stderrMaxBytes: request.stderrMaxBytes,
    readonlyMounts: request.readonlyMounts ?? [],
    writableMounts: request.writableMounts ?? [],
    cache: request.cache ?? [],
  })
}

function digestOfRequestPolicy(value: unknown): string {
  // 通用 canonical JSON digest（receipt.ts 的 canonicalJson 语义 ——
  // 递归稳定排序；不是 spec 级 computePolicyDigest，后者要求完整 spec 形状）。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { digestOf } = require("./receipt") as typeof import("./receipt")
  return digestOf(value)
}

/**
 * 带 Plan Cache 的编译：同 workspace + 同策略请求命中模板 → 注入新身份
 *  （跳过完整 Policy Compiler）。模板 = 清洗身份后的 spec 序列化（不含
 *  cell- / run- 等注入形状，满足 PlanCache 无秘密检查）。
 */
export function compileCapabilityRequestCached(
  request: UntrustedCapabilityRequest,
  authority: TrustedExecutionAuthority,
  cache?: import("./cache/plan-cache").PlanCache,
  workspaceIdentity?: string,
): { ok: true; spec: ExecutionCellSpec } | { ok: false; errors: string[] } {
  if (cache && workspaceIdentity) {
    const key = planCacheKeyFor(request, workspaceIdentity)
    const hit = cache.get(key)
    if (hit) {
      // B1 修复：命中路径不得跳过当前请求的校验 —— cwd 权威解析
      // （WORKSPACE_PATH_ESCAPE/NUL 检查）必须执行，且解析结果注入 spec。
      let canonicalCwd: string
      try {
        canonicalCwd = resolveAuthorizedCwd(authority.workspace, request.command.relativeCwd)
      } catch (error) {
        return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
      }
      const spec = JSON.parse(hit.mountTemplate) as ExecutionCellSpec
      spec.identity = { cellId: `cell-${randomUUID().slice(0, 8)}`, ...authority.identity }
      spec.command.cwd = canonicalCwd
      spec.filesystem.worktreeRoot = authority.workspace.hostRoot
      spec.filesystem.ownerFiles = [...authority.workspace.ownerFiles]
      // m1：命中产物同样校验 + 冻结（编译产物不可变契约）。
      const validation = validateCellSpec(spec)
      if (!validation.ok) return { ok: false, errors: validation.errors }
      // cellSpecDigest 含身份 —— 使用方每次现算；policyDigest 不含身份，
      // 模板中的值在替换身份后仍然正确（策略未变）。
      return { ok: true, spec: deepFreeze(spec) }
    }
  }
  const result = compileCapabilityRequest(request, authority)
  if (result.ok && cache && workspaceIdentity) {
    const key = planCacheKeyFor(request, workspaceIdentity)
    const template = JSON.parse(JSON.stringify(result.spec)) as ExecutionCellSpec
    // 清洗身份（模板不含注入形状，PlanCache.templateIsClean 才放行）。
    template.identity = { cellId: "", runId: "", nodeRunId: "", attempt: 0 }
    cache.put({
      key,
      mountTemplate: JSON.stringify(template),
      environmentTemplate: {},
      backendArgvTemplate: [],
      validationResult: { ok: true, errors: [] },
      createdAt: Date.now(),
    })
  }
  return result
}

function planCacheKeyFor(request: UntrustedCapabilityRequest, workspaceIdentity: string): import("./cache/plan-cache").PlanCacheKey {
  return {
    profileDigest: request.profile,
    toolContractDigest: policyRequestDigest(request),
    runtimeVersion: process.versions.bun ?? "node",
    platform: `${process.platform}-${process.arch}`,
    backendVersion: "",
    policyDigest: `${workspaceIdentity}`,
  }
}
