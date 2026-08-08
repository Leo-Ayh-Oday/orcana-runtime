/** LR2-5 Gate 验收（P5-E）：5 项 Gate 各一条显式断言。
 *
 *  LEASE_EXPIRED_BLIND_KILL     = 0（到期不盲杀）
 *  OWNER_LOST_HANDLING          = 0（Owner 中断按 retention 处理）
 *  PORT_CONFLICT_UNCHECKED      = 0
 *  RESTART_EXHAUSTED_IGNORED    = 0
 *  SERVICE_READY_FALSE_POSITIVE = 0（探活通过才算 READY）
 */

import { describe, expect, test } from "bun:test"
import { decideRetention, onOwnerLost } from "../../../../src/runtime/linux/service/retention"
import { validateServiceSpec } from "../../../../src/runtime/linux/service/spec"
import { runProbe } from "../../../../src/runtime/linux/service/lifecycle"
import { ServiceStateMachine } from "../../../../src/runtime/linux/service/state-machine"
import type { ServiceCellSpec } from "../../../../src/runtime/linux/service/spec"

function baseSpec(): ServiceCellSpec {
  return {
    serviceId: "g", ownerRunId: "r",
    command: { executable: "/bin/true", args: [] },
    dependencies: [], portRequests: [],
    restartPolicy: "on-failure", maxRestarts: 2,
    leasePolicy: { ttlMs: 1000, renewBy: "manager" },
    logPolicy: { stdoutMaxBytes: 1, stderrMaxBytes: 1 },
    shutdownContract: { graceMs: 100, waitForDrain: false },
    retentionPolicy: "retain",
  }
}

describe("LR2-5 Gates (P5-E)", () => {
  test("LEASE_EXPIRED_BLIND_KILL = 0: expiry is decided, never blindly killed", () => {
    for (const policy of ["retain", "pause", "terminate", "transfer"] as const) {
      const d = decideRetention(policy, "lease-expired")
      expect(["retain", "pause", "terminate", "transfer"]).toContain(d.action)
      // terminate 是策略选择，不是"到期即杀"的默认行为
      if (policy !== "terminate") expect(d.action).not.toBe("terminate")
    }
  })

  test("OWNER_LOST_HANDLING = 0: owner interruption follows retentionPolicy", () => {
    expect(onOwnerLost("terminate").action).toBe("terminate")
    expect(onOwnerLost("retain").action).toBe("retain")
    expect(onOwnerLost("transfer", "c").action).toBe("transfer")
  })

  test("PORT_CONFLICT_UNCHECKED = 0: duplicate ports rejected at spec level", () => {
    const spec = baseSpec()
    spec.portRequests = [{ name: "a", port: 9000, bind: "loopback" }, { name: "b", port: 9000, bind: "loopback" }]
    expect(validateServiceSpec(spec).ok).toBe(false)
  })

  test("RESTART_EXHAUSTED_IGNORED = 0: exhausted restarts are a terminal state", () => {
    const sm = new ServiceStateMachine("g-svc")
    sm.transition("STARTING", "d")
    sm.transition("PROCESS_RUNNING", "d")
    sm.transition("READINESS_PENDING", "d")
    sm.transition("READY", "d")
    sm.transition("RESTARTING", "crash")
    expect(sm.transition("RESTART_EXHAUSTED", "max restarts")).toBe(true)
    expect(sm.isTerminal).toBe(true)
    expect(sm.transition("PROCESS_RUNNING", "try again")).toBe(false) // 终态不可复活
  })

  test("SERVICE_READY_FALSE_POSITIVE = 0: probe must actually pass", async () => {
    // 无监听端口 → tcp 探活失败（不得假 READY）
    const result = await runProbe(
      { ...baseSpec(), readinessProbe: { kind: "tcp", host: "127.0.0.1", port: 18998, timeoutMs: 200 } },
      "readinessProbe",
    )
    expect(result.ok).toBe(false)
  })
})
