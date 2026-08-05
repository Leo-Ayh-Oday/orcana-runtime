/** LNXF-1.0: network policy (LF-7, plan §16).
 *
 *  First version: none / loopback / full-approved. proxy-allowlist is the
 *  egress-proxy design: cells have no direct egress; the Orcana Egress
 *  Proxy performs host/port allowlisting with hop-by-hop DNS + redirect
 *  re-checks. DNS pre-resolution alone is never a control (IPs change,
 *  redirects move targets, non-HTTP protocols escape, DNS rebinding).
 */

import type { NetworkMode } from "./contracts"

export interface EgressPolicy {
  mode: "proxy-allowlist"
  allowedHosts: string[]
  allowedPorts: number[]
  /** 逐跳复查：最终连接目标必须仍然命中 allowlist。 */
  requireHopByHopCheck: true
}

export interface EgressDecision {
  allowed: boolean
  reason?: string
  /** 复查后的最终目标（重定向后）。 */
  finalTarget?: { host: string; port: number }
}

export function buildEgressPolicy(hosts: string[], ports: number[] = [80, 443]): EgressPolicy {
  return { mode: "proxy-allowlist", allowedHosts: hosts, allowedPorts: ports, requireHopByHopCheck: true }
}

function hostAllowed(policy: EgressPolicy, host: string): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, "")
  return policy.allowedHosts.some(allowed => {
    const a = allowed.toLowerCase().replace(/\.$/, "")
    if (a.startsWith("*.")) return normalized.endsWith(a.slice(1))
    return normalized === a
  })
}

/** 逐跳复查（连接前 + 每次重定向后）。 */
export function checkEgressHop(policy: EgressPolicy, target: { host: string; port: number }): EgressDecision {
  if (!hostAllowed(policy, target.host)) {
    return { allowed: false, reason: `host not in allowlist: ${target.host}` }
  }
  if (!policy.allowedPorts.includes(target.port)) {
    return { allowed: false, reason: `port not in allowlist: ${target.port}` }
  }
  return { allowed: true, finalTarget: target }
}

/** 重定向复查：新目标必须再次通过检查（REDIRECT_POLICY_BYPASS: 0）。 */
export function checkEgressRedirect(policy: EgressPolicy, original: { host: string; port: number }, redirect: { host: string; port: number }): EgressDecision {
  const hop = checkEgressHop(policy, redirect)
  if (!hop.allowed) {
    return { allowed: false, reason: `redirect target rejected: ${redirect.host}:${redirect.port} (from ${original.host}:${original.port})` }
  }
  return hop
}

/** DNS rebinding 复查：解析出的每个 IP 都要做反向确认（简化：要求代理
 *  持有权威解析，禁止 Cell 自行解析）。 */
export function dnsRebindingGuard(policy: EgressPolicy, requestedHost: string, resolvedIp: string): EgressDecision {
  if (!hostAllowed(policy, requestedHost)) {
    return { allowed: false, reason: `host not in allowlist: ${requestedHost}` }
  }
  // 仅允许解析到保留/回环地址之外的目标（禁止把白名单域名解析到内网地址）。
  if (resolvedIp.startsWith("127.") || resolvedIp.startsWith("10.") || resolvedIp.startsWith("192.168.") || resolvedIp.startsWith("169.254.") || resolvedIp === "::1") {
    return { allowed: false, reason: `rebinding guard: ${requestedHost} resolved to private address ${resolvedIp}` }
  }
  return { allowed: true }
}

export function validateNetworkMode(mode: NetworkMode): { ok: boolean; reason?: string } {
  switch (mode) {
    case "none":
    case "loopback":
      return { ok: true }
    case "full-approved":
      return { ok: true, reason: "full-approved requires explicit human approval recorded in the receipt" }
    case "proxy-allowlist":
      return { ok: true }
  }
}
