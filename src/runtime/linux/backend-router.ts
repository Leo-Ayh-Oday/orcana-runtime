/** LNXF-1.0: backend router (LF-1) — backend selection with degradation
 *  rules (ADR-L4/ADR-L9).
 *
 *  Selection order: preferredBackend → profile default → strictly-no-
 *  degradation refusal. Host Audit is only allowed for non-strict profiles
 *  with `minimum=audit` and explicit `allowDegradation`.
 */

import type { BackendAvailability, ExecutionCellSpec } from "./contracts"
import type { LinuxCapabilities } from "./contracts"
import { profileDefaults } from "./profiles"
import { LinuxExecutionError } from "./errors"

export interface BackendSelection {
  backend: "host-audit" | "bubblewrap" | "rootless-podman"
  degradationReasons: string[]
}

export function backendAvailability(caps: LinuxCapabilities): BackendAvailability[] {
  return [
    {
      id: "host-audit",
      available: true, // 始终可用（低风险降级后端）
      degradationReasons: ["Host Audit 不是安全边界，仅限低风险显式允许场景"],
    },
    {
      id: "bubblewrap",
      available: caps.bubblewrap.available && caps.bubblewrap.unprivilegedUsable,
      version: caps.bubblewrap.version,
      degradationReasons: caps.bubblewrap.available && !caps.bubblewrap.unprivilegedUsable
        ? ["bubblewrap 存在但无法使用非特权用户命名空间"]
        : ["bubblewrap 不可用"],
    },
    {
      id: "rootless-podman",
      available: caps.podman.available && caps.podman.rootlessReady,
      version: caps.podman.version,
      degradationReasons: caps.podman.available && !caps.podman.rootlessReady
        ? ["podman rootless 预检未通过"]
        : ["podman 不可用"],
    },
  ]
}

/** 选择后端；strict profile 在隔离后端不可用时拒绝（DEGRADATION_NOT_ALLOWED）。 */
/** IC06: Hard Authority 模式下 host-audit 必须 FAIL CLOSED
 *  （HOST_AUDIT_RESOURCE_AUTHORITY_ESCAPE=0）—— host-audit 无隔离，
 *  same-uid workload 可直接篡改 authority 周边文件系统状态。
 *  hardAuthority 缺省 false（legacy 语义不变）。 */
export interface SelectBackendOptions {
  hardAuthority?: boolean
}

export function selectBackend(spec: ExecutionCellSpec, caps: LinuxCapabilities, options: SelectBackendOptions = {}): BackendSelection {
  const defaults = profileDefaults(spec.profile)
  const available = backendAvailability(caps)
  const byId = (id: string) => available.find(a => a.id === id)

  const canUse = (id: "host-audit" | "bubblewrap" | "rootless-podman"): boolean => {
    const entry = byId(id)
    if (!entry?.available) return false
    if (id === "host-audit") {
      // IC06: Hard Authority 下拒绝 host-audit（fail closed）。
      if (options.hardAuthority) return false
      // Host Audit 仅限：minimum=audit 且显式允许降级
      if (spec.isolation.minimum !== "audit") return false
      if (!spec.isolation.allowDegradation && defaults.allowDegradation === false) return false
    }
    if (id === "bubblewrap" && spec.isolation.minimum === "container") return false
    return true
  }

  const preferred = spec.isolation.preferredBackend === "auto"
    ? defaults.backend
    : spec.isolation.preferredBackend === "podman" ? "rootless-podman" : spec.isolation.preferredBackend

  if (canUse(preferred)) {
    return { backend: preferred, degradationReasons: [] }
  }

  // 降级链：bubblewrap → host-audit（快速后端不可用时）。
  if (preferred === "bubblewrap" && canUse("host-audit")) {
    return { backend: "host-audit", degradationReasons: ["bubblewrap 不可用，降级到 Host Audit"] }
  }
  if (preferred === "bubblewrap" && canUse("rootless-podman")) {
    return { backend: "rootless-podman", degradationReasons: ["bubblewrap 不可用，升级到严格后端"] }
  }

  // 严格隔离不可用且不允许降级 → 拒绝。
  if (!spec.isolation.allowDegradation) {
    throw new LinuxExecutionError(
      "DEGRADATION_NOT_ALLOWED",
      `profile "${spec.profile}" requires backend "${preferred}" but it is unavailable; degradation is not allowed`,
      { profile: spec.profile, required: preferred },
    )
  }
  throw new LinuxExecutionError(
    "ISOLATION_REQUIREMENT_UNMET",
    `no backend satisfies isolation minimum "${spec.isolation.minimum}"`,
    { minimum: spec.isolation.minimum },
  )
}
