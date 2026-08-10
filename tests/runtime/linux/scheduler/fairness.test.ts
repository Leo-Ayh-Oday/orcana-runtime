/** LR2-3（P3-D）：公平性验收 —— 大 Run 不占满（STARVATION_BY_RUN）/
 *  Evolution 硬配额 / 交互保留槽位 / 决策日志。 */

import { describe, expect, test } from "bun:test"
import { RunFairnessScheduler, type FairnessConfig } from "../../../../src/runtime/linux/scheduler/fairness"
import type { QueueItem } from "../../../../src/runtime/linux/scheduler/queue"

function item(id: string, runId: string, priority: QueueItem["priority"] = "normal"): Omit<QueueItem, "enqueuedAt"> {
  return { id, runId, priority, weight: 1 }
}

const CONFIG: FairnessConfig = { totalSlots: 6, maxRunShare: 0.5, evolutionQuota: 1, interactiveReserved: 1 }

describe("RunFairnessScheduler (P3-D)", () => {
  test("a big run cannot occupy all slots (STARVATION_BY_RUN)", () => {
    const s = new RunFairnessScheduler(CONFIG)
    // B1 修复（LR2-3 审核）：大 Run 入队 cap+1 项（超出份额）——
    // 队首被拒时必须越过它调度后续可调度的项（旧实现队首阻塞假绿）。
    for (let i = 0; i < 8; i++) s.enqueue(item(`big-${i}`, "big-run"))
    // 小 Run 也排队（排在队尾）
    s.enqueue(item("small-1", "small-run"))
    // 调度 4 个：前 3 个都是大 Run（份额内），第 4 个越过队首 → 小 Run
    const scheduled: string[] = []
    for (let i = 0; i < 4; i++) {
      const d = s.next()
      if (d.allowed) {
        scheduled.push(d.allowed.runId)
        s.markRunning(d.allowed)
      }
    }
    expect(scheduled.slice(0, 3).every(r => r === "big-run")).toBe(true)
    expect(scheduled[3]).toBe("small-run")
  })

  test("evolution hard quota (EVOLUTION_QUOTA_EXCEEDED)", () => {
    const s = new RunFairnessScheduler(CONFIG)
    s.enqueue(item("e1", "run-a", "evolution"))
    s.enqueue(item("e2", "run-b", "evolution"))
    const first = s.next()
    s.markRunning(first.allowed!)
    const second = s.next()
    expect(second.allowed).toBeUndefined()
    expect(second.denied?.id).toBe("e2")
    expect(second.reason).toContain("evolution quota")
  })

  test("interactive reserved slots always available", () => {
    const s = new RunFairnessScheduler({ ...CONFIG, totalSlots: 3, maxRunShare: 1, interactiveReserved: 1 })
    // 占满 2 个普通槽位（剩 1 = reserved）
    for (let i = 0; i < 2; i++) {
      const d = s.next()
      s.enqueue(item(`n${i}`, "r1"))
      s.markRunning(s.next().allowed!)
    }
    // 普通任务：只剩 1 个 reserved 槽位 → 拒绝
    s.enqueue(item("n3", "r2"))
    const denied = s.next()
    expect(denied.allowed).toBeUndefined()
    expect(denied.reason).toContain("interactive reserved")
    // 交互任务：保留槽位可用 → 放行
    s.enqueue(item("i1", "r3", "interactive"))
    const interactive = s.next()
    expect(interactive.allowed?.id).toBe("i1")
  })

  test("decision log: snapshot reports run distribution", () => {
    const s = new RunFairnessScheduler(CONFIG)
    s.enqueue(item("a1", "run-a"))
    s.enqueue(item("a2", "run-a"))
    const d1 = s.next()
    s.markRunning(d1.allowed!)
    const snap = s.snapshot()
    expect(snap.total).toBe(1)
    expect(snap.running[0]).toMatchObject({ runId: "run-a", count: 1 })
  })
})
