/** LR2-5（P5-B）：ServiceCellSpec 校验验收。 */

import { describe, expect, test } from "bun:test"
import { validateServiceSpec, type ServiceCellSpec } from "../../../../src/runtime/linux/service/spec"

function base(overrides: Partial<ServiceCellSpec> = {}): ServiceCellSpec {
  return {
    serviceId: "svc-1",
    ownerRunId: "run-1",
    command: { executable: "/bin/sh", args: ["-c", "sleep 100"] },
    dependencies: [],
    portRequests: [{ name: "http", port: 8080, bind: "loopback" }],
    restartPolicy: "on-failure",
    maxRestarts: 3,
    leasePolicy: { ttlMs: 60_000, renewBy: "manager" },
    logPolicy: { stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
    shutdownContract: { graceMs: 2000, waitForDrain: true },
    retentionPolicy: "retain",
    ...overrides,
  }
}

describe("ServiceCellSpec validation (P5-B)", () => {
  test("valid spec passes", () => {
    const result = validateServiceSpec(base())
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test("missing required fields rejected", () => {
    expect(validateServiceSpec(base({ serviceId: "" })).ok).toBe(false)
    expect(validateServiceSpec(base({ ownerRunId: "" })).ok).toBe(false)
    expect(validateServiceSpec(base({ command: { executable: "", args: [] } })).ok).toBe(false)
  })

  test("duplicate / invalid ports rejected (PORT_CONFLICT_UNCHECKED)", () => {
    const dup = validateServiceSpec(base({
      portRequests: [{ name: "a", port: 8080, bind: "loopback" }, { name: "b", port: 8080, bind: "loopback" }],
    }))
    expect(dup.ok).toBe(false)
    expect(dup.errors.some(e => e.includes("duplicate port"))).toBe(true)
    const badPort = validateServiceSpec(base({ portRequests: [{ name: "x", port: 0, bind: "loopback" }] }))
    expect(badPort.ok).toBe(false)
    const badBind = validateServiceSpec(base({ portRequests: [{ name: "x", port: 8080, bind: "everywhere" as never }] }))
    expect(badBind.ok).toBe(false)
  })

  test("probe shape validated", () => {
    const badHttp = validateServiceSpec(base({ readinessProbe: { kind: "http", url: "ftp://x" } }))
    expect(badHttp.ok).toBe(false)
    const goodHttp = validateServiceSpec(base({ readinessProbe: { kind: "http", url: "http://127.0.0.1:8080/health" } }))
    expect(goodHttp.ok).toBe(true)
  })

  test("restart policy and maxRestarts bounded", () => {
    expect(validateServiceSpec(base({ maxRestarts: -1 })).ok).toBe(false)
    expect(validateServiceSpec(base({ maxRestarts: 500 })).ok).toBe(false)
    expect(validateServiceSpec(base({ restartPolicy: "sometimes" as never })).ok).toBe(false)
    expect(validateServiceSpec(base({ retentionPolicy: "destroy" as never })).ok).toBe(false)
  })
})
