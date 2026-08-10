/** LR2-4（P4-B）：Egress Gateway 验收 —— E1 记录完整 / E2 决策 /
 *  E3 检测（预算/重定向/DNS rebinding/方法/目标分类）。 */

import { describe, expect, test } from "bun:test"
import { EgressRecorder, evaluateEgress, egressRoutingDecision, isPrivateIp, type EgressPolicy } from "../../../../src/runtime/linux/egress/gateway"

const POLICY: EgressPolicy = {
  allowedHosts: ["example.com", "api.example.com"],
  allowedPorts: [443],
  allowedMethods: ["GET", "HEAD"],
  uploadByteBudget: 1024,
  maxRedirectHops: 2,
  blockPrivateResolvedIp: true,
  sensitivePatterns: [],
}

describe("Egress Gateway (P4-B)", () => {
  test("E1: every request is recorded (EGRESS_UNRECORDED)", () => {
    const recorder = new EgressRecorder()
    recorder.record({ at: 1, host: "example.com", port: 443, method: "GET", bytesSent: 10, bytesReceived: 100, redirectHops: 0, sensitivePatterns: [] })
    recorder.record({ at: 2, host: "example.com", port: 443, method: "GET", bytesSent: 20, bytesReceived: 200, redirectHops: 1, sensitivePatterns: [] })
    expect(recorder.count()).toBe(2)
    expect(recorder.records[0]!.method).toBe("GET")
  })

  test("E3: host/port/method classification rejects disallowed targets", () => {
    const badHost = evaluateEgress({ host: "evil.com", port: 443, method: "GET", bytesSent: 10, bytesReceived: 0, redirectHops: 0 }, POLICY)
    expect(badHost.allowed).toBe(false)
    expect(badHost.reasons.some(r => r.includes("host"))).toBe(true)
    const badPort = evaluateEgress({ host: "example.com", port: 80, method: "GET", bytesSent: 10, bytesReceived: 0, redirectHops: 0 }, POLICY)
    expect(badPort.allowed).toBe(false)
    const badMethod = evaluateEgress({ host: "example.com", port: 443, method: "POST", bytesSent: 10, bytesReceived: 0, redirectHops: 0 }, POLICY)
    expect(badMethod.allowed).toBe(false)
  })

  test("E3: upload byte budget enforced", () => {
    const over = evaluateEgress({ host: "example.com", port: 443, method: "GET", bytesSent: 4096, bytesReceived: 0, redirectHops: 0 }, POLICY)
    expect(over.allowed).toBe(false)
    expect(over.reasons.some(r => r.includes("budget"))).toBe(true)
  })

  test("E3: redirect hop limit blocks redirect-bypass", () => {
    const hops = evaluateEgress({ host: "example.com", port: 443, method: "GET", bytesSent: 10, bytesReceived: 0, redirectHops: 5 }, POLICY)
    expect(hops.allowed).toBe(false)
    expect(hops.reasons.some(r => r.includes("redirect"))).toBe(true)
  })

  test("E3: DNS rebinding — private resolved IP rejected", () => {
    const rebind = evaluateEgress({ host: "example.com", port: 443, method: "GET", bytesSent: 10, bytesReceived: 0, redirectHops: 0, resolvedIp: "10.0.0.5" }, POLICY)
    expect(rebind.allowed).toBe(false)
    expect(rebind.reasons.some(r => r.includes("rebinding"))).toBe(true)
    expect(isPrivateIp("127.0.0.1")).toBe(true)
    expect(isPrivateIp("192.168.1.1")).toBe(true)
    expect(isPrivateIp("172.16.0.1")).toBe(true)
    expect(isPrivateIp("8.8.8.8")).toBe(false)
  })

  test("E2: routing decision never claims enforcement without netns capability", () => {
    const record = egressRoutingDecision(POLICY, false)
    expect(record.mode).toBe("record")
    expect(record.reason).toContain("not claiming enforcement")
    const enforce = egressRoutingDecision(POLICY, true)
    expect(enforce.mode).toBe("enforce")
  })

  test("allowed request passes cleanly", () => {
    const ok = evaluateEgress({ host: "example.com", port: 443, method: "GET", bytesSent: 100, bytesReceived: 50, redirectHops: 1 }, POLICY)
    expect(ok.allowed).toBe(true)
    expect(ok.reasons).toHaveLength(0)
  })
})

// ── LR2-4 审核修复验收（M1 IPv6）──

describe("Egress audit fixes (M1)", () => {
  test("M1: IPv6 private ranges are detected (rebinding on v6 blocked)", () => {
    expect(isPrivateIp("fd00::1")).toBe(true)
    expect(isPrivateIp("fe80::1")).toBe(true)
    expect(isPrivateIp("::1")).toBe(true)
    // v4-mapped 解包
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true)
    expect(isPrivateIp("::ffff:192.168.1.1")).toBe(true)
    expect(isPrivateIp("::ffff:172.16.0.1")).toBe(true)
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true)
    // 公网 v6 放行
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false)
    expect(isPrivateIp("8.8.8.8")).toBe(false)
  })
})
