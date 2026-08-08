/** LR2-5（P5-A）：Service 状态机验收 —— 合法/非法迁移表、异常终态、事件流。 */

import { describe, expect, test } from "bun:test"
import { ServiceStateMachine, SERVICE_TERMINAL_STATES } from "../../../../src/runtime/linux/service/state-machine"

describe("ServiceStateMachine (P5-A)", () => {
  test("happy path: DECLARED → … → READY → STOPPED", () => {
    const sm = new ServiceStateMachine("svc-1", () => 1)
    expect(sm.transition("STARTING", "declared")).toBe(true)
    expect(sm.transition("PROCESS_RUNNING", "spawned")).toBe(true)
    expect(sm.transition("READINESS_PENDING", "probe started")).toBe(true)
    expect(sm.transition("READY", "probe passed")).toBe(true)
    expect(sm.transition("STOPPING", "shutdown")).toBe(true)
    expect(sm.transition("STOPPED", "stopped")).toBe(true)
    expect(sm.current).toBe("STOPPED")
    expect(sm.isTerminal).toBe(true)
    // 事件流完整
    const events = sm.events()
    expect(events.map(e => e.to)).toEqual(["STARTING", "PROCESS_RUNNING", "READINESS_PENDING", "READY", "STOPPING", "STOPPED"])
    expect(events[3]!.reason).toBe("probe passed")
  })

  test("illegal transitions are rejected (no state change, no event)", () => {
    const sm = new ServiceStateMachine("svc-2")
    expect(sm.transition("READY", "skip ahead")).toBe(false) // DECLARED→READY 非法
    expect(sm.current).toBe("DECLARED")
    expect(sm.events()).toHaveLength(0)
  })

  test("abnormal terminal states block further migration", () => {
    const sm = new ServiceStateMachine("svc-3")
    sm.force("LEASE_EXPIRED", "lease expired")
    expect(sm.current).toBe("LEASE_EXPIRED")
    expect(sm.isTerminal).toBe(true)
    // 终态不可再迁移（守卫拒绝 + 无事件）
    expect(sm.transition("RESTARTING", "try again")).toBe(false)
    expect(sm.events()).toHaveLength(1)
  })

  test("degraded → ready recovery and restart exhaustion", () => {
    const sm = new ServiceStateMachine("svc-4")
    sm.transition("STARTING", "d")
    sm.transition("PROCESS_RUNNING", "d")
    sm.transition("READINESS_PENDING", "d")
    sm.transition("READY", "probe ok")
    expect(sm.transition("DEGRADED", "health fail")).toBe(true)
    expect(sm.transition("READY", "health recovered")).toBe(true)
    expect(sm.transition("RESTARTING", "crash")).toBe(true)
    expect(sm.transition("RESTART_EXHAUSTED", "max restarts")).toBe(true)
    expect(sm.current).toBe("RESTART_EXHAUSTED")
  })

  test("all six abnormal states are terminal", () => {
    for (const s of ["START_FAILED", "HEALTH_FAILED", "LEASE_EXPIRED", "OWNER_LOST", "PORT_CONFLICT", "RESTART_EXHAUSTED"] as const) {
      expect(SERVICE_TERMINAL_STATES.has(s)).toBe(true)
    }
  })
})
