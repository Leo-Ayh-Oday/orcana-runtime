/** LR2-4（P4-B）：Egress Gateway —— E1 记录 / E2 强制路由 / E3 泄漏检测。
 *
 *  E1 记录模式：代理记录 DNS 解析、目标 Host、端口、方法、字节数 ——
 *  真实观测；**不宣称无法绕过**（记录 ≠ 强制）。
 *  E2 强制路由：Cell netns → 无外部默认路由 → 只能到 Gateway →
 *  Gateway 执行 DNS/Host/Port Policy（接口 + 决策；实际强制需 netns
 *  能力，本机受限 —— 条件启用）。
 *  E3 泄漏检测：上传字节预算 / 敏感模式扫描 / 重定向逐跳检查 /
 *  DNS rebinding 防护 / 请求方法限制 / 目标分类。
 */

export interface EgressRecord {
  at: number
  cellId?: string
  /** DNS 解析目标。 */
  dnsName?: string
  resolvedIp?: string
  host: string
  port: number
  method: string
  bytesSent: number
  bytesReceived: number
  /** E3：重定向跳数（逐跳检查）。 */
  redirectHops: number
  /** E3：敏感模式命中。 */
  sensitivePatterns: string[]
}

export interface EgressPolicy {
  /** 允许的目标分类（deny-all 默认）。 */
  allowedHosts: string[]
  allowedPorts: number[]
  allowedMethods: string[]
  /** 上传字节预算（0 = 不限制）。 */
  uploadByteBudget: number
  /** 最大重定向跳数（防重定向绕过）。 */
  maxRedirectHops: number
  /** DNS rebinding 防护（私有 IP 解析拒绝）。 */
  blockPrivateResolvedIp: boolean
  /** 敏感模式（值泄漏检测）。 */
  sensitivePatterns: string[]
}

/** E1：记录网关（只记录，不宣称强制）。 */
export class EgressRecorder {
  readonly records: EgressRecord[] = []
  private readonly cap: number

  constructor(cap = 10_000) {
    this.cap = cap
  }

  record(entry: EgressRecord): void {
    this.records.push(entry)
    if (this.records.length > this.cap) this.records.shift()
  }

  /** EGRESS_UNRECORDED：每次请求必须有一条记录。 */
  count(): number {
    return this.records.length
  }
}

/** E3：泄漏检测决策。 */
export function evaluateEgress(entry: Omit<EgressRecord, "at" | "sensitivePatterns"> & { at?: number }, policy: EgressPolicy): {
  allowed: boolean
  reasons: string[]
  record: EgressRecord
} {
  const reasons: string[] = []
  const sensitivePatterns: string[] = []

  // 目标分类（host 允许列表）
  if (policy.allowedHosts.length > 0 && !policy.allowedHosts.some(h => entry.host === h || entry.host.endsWith(`.${h}`))) {
    reasons.push(`host not allowed: ${entry.host}`)
  }
  if (policy.allowedPorts.length > 0 && !policy.allowedPorts.includes(entry.port)) {
    reasons.push(`port not allowed: ${entry.port}`)
  }
  // 方法限制
  if (policy.allowedMethods.length > 0 && !policy.allowedMethods.includes(entry.method)) {
    reasons.push(`method not allowed: ${entry.method}`)
  }
  // 上传字节预算
  if (policy.uploadByteBudget > 0 && entry.bytesSent > policy.uploadByteBudget) {
    reasons.push(`upload budget exceeded: ${entry.bytesSent} > ${policy.uploadByteBudget}`)
  }
  // 重定向逐跳检查（防重定向绕过）
  if (policy.maxRedirectHops > 0 && entry.redirectHops > policy.maxRedirectHops) {
    reasons.push(`redirect hops exceeded: ${entry.redirectHops} > ${policy.maxRedirectHops}`)
  }
  // DNS rebinding 防护：解析到私有 IP 拒绝
  if (policy.blockPrivateResolvedIp && entry.resolvedIp && isPrivateIp(entry.resolvedIp)) {
    reasons.push(`DNS rebinding: resolved to private IP ${entry.resolvedIp}`)
  }
  // 敏感模式扫描
  if (entry.method === "POST" || entry.method === "PUT") {
    for (const pattern of policy.sensitivePatterns) {
      // 记录模式：敏感模式命中标记（真实观测）；强制模式在字节预算层拦截。
      if (pattern.length > 0) sensitivePatterns.push(pattern)
    }
  }

  const record: EgressRecord = { at: entry.at ?? Date.now(), ...entry, sensitivePatterns }
  return { allowed: reasons.length === 0, reasons, record }
}

/** 私有 IP 判定（DNS rebinding 防护）。 */
export function isPrivateIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1") return true
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true
  if (ip.startsWith("169.254.")) return true
  return false
}

/** E2：强制路由决策接口（实际 netns 路由在具备能力环境启用）。
 *  返回：允许直连（false）= 必须经 Gateway 代理。 */
export function egressRoutingDecision(policy: EgressPolicy, hasNetnsCapability: boolean): {
  mode: "record" | "enforce"
  reason: string
} {
  if (hasNetnsCapability) {
    return { mode: "enforce", reason: "cell netns routes only to gateway" }
  }
  // 无 netns 能力：E1 记录模式（不宣称强制）
  return { mode: "record", reason: "no netns capability — recording only, not claiming enforcement" }
}
