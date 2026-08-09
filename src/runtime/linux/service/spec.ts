/** LR2-5（P5-B）：ServiceCellSpec —— 独立服务合同（不能在普通 Cell 上
 *  加 serviceMode=true 就结束）。 */

export type RestartPolicy = "none" | "on-failure" | "always"
export type LeasePolicy = { ttlMs: number; renewBy: "owner" | "manager" }
export type RetentionPolicy = "retain" | "pause" | "terminate" | "transfer"

export interface HttpProbe {
  kind: "http"
  url: string
  /** 期望状态码（默认 200）。 */
  expectedStatus?: number
  /** 超时 ms。 */
  timeoutMs?: number
}

export interface TcpProbe {
  kind: "tcp"
  host: string
  port: number
  timeoutMs?: number
}

export type Probe = HttpProbe | TcpProbe

export interface ShutdownContract {
  /** 优雅终止信号等待 ms，超时升级 SIGKILL。 */
  graceMs: number
  /** 是否等探活失败才杀（readiness 已过时允许快速关）。 */
  waitForDrain: boolean
}

export interface ServiceCellSpec {
  serviceId: string
  ownerRunId: string
  ownerAgentId?: string
  command: {
    executable: string
    args: string[]
    cwdRef?: string
  }
  workspace?: string
  dependencies: string[]
  portRequests: Array<{ name: string; port: number; bind: "loopback" | "all" }>
  readinessProbe?: Probe
  healthProbe?: Probe
  healthIntervalMs?: number
  restartPolicy: RestartPolicy
  maxRestarts: number
  leasePolicy: LeasePolicy
  logPolicy: { stdoutMaxBytes: number; stderrMaxBytes: number }
  shutdownContract: ShutdownContract
  retentionPolicy: RetentionPolicy
}

export interface SpecValidation {
  ok: boolean
  errors: string[]
}

/** 校验：字段完整性 / 端口唯一 / probe 形状 / restart 上限。
 *  M7 修复（LR2-5 审核）：必需字段全部强制（leasePolicy/shutdownContract/
 *  logPolicy/dependencies/portRequests）；probe.url 缺失返回错误不抛异常；
 *  timeoutMs 必须正数。 */
export function validateServiceSpec(spec: ServiceCellSpec): SpecValidation {
  const errors: string[] = []
  if (!spec.serviceId) errors.push("serviceId required")
  if (!spec.ownerRunId) errors.push("ownerRunId required")
  if (!spec.command?.executable) errors.push("command.executable required")
  if (!Array.isArray(spec.command?.args)) errors.push("command.args must be an array")
  if (!Array.isArray(spec.dependencies)) errors.push("dependencies must be an array")
  if (!Array.isArray(spec.portRequests)) errors.push("portRequests must be an array")
  if (!spec.leasePolicy) errors.push("leasePolicy required")
  if (!spec.shutdownContract) errors.push("shutdownContract required")
  if (!spec.logPolicy) errors.push("logPolicy required")

  // 端口唯一 + 合法范围
  const seenPorts = new Set<number>()
  for (const p of spec.portRequests ?? []) {
    if (!Number.isInteger(p.port) || p.port <= 0 || p.port > 65535) {
      errors.push(`invalid port: ${p.port}`)
    }
    if (seenPorts.has(p.port)) errors.push(`duplicate port: ${p.port}`)
    seenPorts.add(p.port)
    if (p.bind !== "loopback" && p.bind !== "all") errors.push(`invalid bind: ${p.bind}`)
  }

  // probe 形状（url 缺失返回校验错误而非抛 TypeError）
  for (const [name, probe] of [["readinessProbe", spec.readinessProbe], ["healthProbe", spec.healthProbe]] as const) {
    if (!probe) continue
    if (probe.kind === "http") {
      if (typeof probe.url !== "string" || !probe.url.startsWith("http")) {
        errors.push(`${name}: url must be http(s)`)
      }
    } else if (probe.kind === "tcp") {
      if (!Number.isInteger(probe.port) || probe.port <= 0 || probe.port > 65535) {
        errors.push(`${name}: invalid tcp port`)
      }
    } else {
      errors.push(`${name}: unknown probe kind`)
    }
    // m11：timeoutMs 正数
    if (probe.timeoutMs !== undefined && (!Number.isFinite(probe.timeoutMs) || probe.timeoutMs < 1)) {
      errors.push(`${name}: timeoutMs must be >= 1`)
    }
  }

  // restart 上限
  if (!Number.isInteger(spec.maxRestarts) || spec.maxRestarts < 0 || spec.maxRestarts > 100) {
    errors.push(`invalid maxRestarts: ${spec.maxRestarts}`)
  }
  if (!["none", "on-failure", "always"].includes(spec.restartPolicy)) {
    errors.push(`invalid restartPolicy: ${spec.restartPolicy}`)
  }
  if (!["retain", "pause", "terminate", "transfer"].includes(spec.retentionPolicy)) {
    errors.push(`invalid retentionPolicy: ${spec.retentionPolicy}`)
  }
  if (!spec.leasePolicy || !Number.isFinite(spec.leasePolicy.ttlMs) || spec.leasePolicy.ttlMs <= 0) {
    errors.push("leasePolicy.ttlMs must be positive")
  }
  if (!spec.shutdownContract || !Number.isFinite(spec.shutdownContract.graceMs) || spec.shutdownContract.graceMs <= 0) {
    errors.push("shutdownContract.graceMs must be positive")
  }

  return { ok: errors.length === 0, errors }
}
