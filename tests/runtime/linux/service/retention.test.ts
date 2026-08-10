/** LR2-5（P5-D）：Retention 验收 —— 到期不盲杀 / terminate / transfer /
 *  OWNER_LOST 按 policy。 */

import { describe, expect, test } from "bun:test"
import { decideRetention, onOwnerLost, type RetentionDecision } from "../../../../src/runtime/linux/service/retention"

describe("Retention (P5-D)", () => {
  test("LEASE_EXPIRED_BLIND_KILL: lease expiry never blindly kills under retain policy", () => {
    const decision = decideRetention("retain", "lease-expired")
    expect(decision.action).toBe("retain")
    // 不盲杀：retain 动作不会停止服务（applyRetention 不触碰）
  })

  test("terminate policy stops the service on expiry", () => {
    const decision = decideRetention("terminate", "lease-expired")
    expect(decision.action).toBe("terminate")
    expect(decision.reason).toContain("terminate")
  })

  test("pause policy maps to pause (process retained)", () => {
    const decision = decideRetention("pause", "lease-expired")
    expect(decision.action).toBe("pause")
  })

  test("transfer policy with candidate transfers ownership", () => {
    const decision = decideRetention("transfer", "lease-expired", { transferCandidate: "agent-2" })
    expect(decision.action).toBe("transfer")
    expect(decision.transferTo).toBe("agent-2")
  })

  test("transfer without candidate degrades to retain (never blind kill)", () => {
    const decision = decideRetention("transfer", "owner-lost")
    expect(decision.action).toBe("retain")
    expect(decision.reason).toContain("no candidate")
  })

  test("OWNER_LOST follows retentionPolicy (OWNER_LOST_HANDLING)", () => {
    expect(onOwnerLost("terminate").action).toBe("terminate")
    expect(onOwnerLost("retain").action).toBe("retain")
    expect(onOwnerLost("transfer", "agent-9").action).toBe("transfer")
  })

  test("every decision is explainable", () => {
    for (const policy of ["retain", "pause", "terminate", "transfer"] as const) {
      const d: RetentionDecision = decideRetention(policy, "lease-expired", { transferCandidate: "c" })
      expect(d.reason.length).toBeGreaterThan(0)
    }
  })
})
