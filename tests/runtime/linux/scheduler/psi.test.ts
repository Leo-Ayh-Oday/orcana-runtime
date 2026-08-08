/** LR2-3（P3-B）：PSI 背压验收 —— 解析 / 状态机迁移（滞后防振荡）/
 *  调度决策 / 真实文件读取。 */

import { describe, expect, test } from "bun:test"
import { PsiBackpressure, parsePsiLine, readSystemPsi, type PsiReading, type PsiResource } from "../../../../src/runtime/linux/scheduler/psi"

function fakePsi(value: number): (resource: PsiResource) => PsiReading | undefined {
  return (resource) => ({
    resource,
    some: { avg10: value, avg60: value, avg300: value, total: 0 },
    full: { avg10: value, avg60: value, avg300: value, total: 0 },
  })
}

describe("PSI parsing (P3-B)", () => {
  test("parses /proc/pressure format lines", () => {
    const parsed = parsePsiLine("some avg10=1.25 avg60=0.50 avg300=0.10 total=12345")
    expect(parsed.avg10).toBeCloseTo(1.25)
    expect(parsed.avg60).toBeCloseTo(0.5)
    expect(parsed.total).toBe(12345)
  })

  test("reads real system pressure on linux", () => {
    if (process.platform !== "linux") return
    const reading = readSystemPsi("cpu")
    expect(reading).toBeDefined()
    expect(reading!.some.avg10).toBeGreaterThanOrEqual(0)
  })
})

describe("PsiBackpressure state machine (P3-B)", () => {
  const thresholds = { constrainedEnter: 10, criticalEnter: 40, criticalExit: 15 }

  test("normal → constrained → critical → recovery → normal (hysteresis)", () => {
    const bp = new PsiBackpressure(thresholds, fakePsi(0))
    expect(bp.tick().state).toBe("NORMAL")

    // 12% → CONSTRAINED
    const bp2 = new PsiBackpressure(thresholds, fakePsi(12))
    expect(bp2.tick().state).toBe("CONSTRAINED")
    expect(bp2.tick().state).toBe("CONSTRAINED")

    // 45% → CRITICAL
    const bp3 = new PsiBackpressure(thresholds, fakePsi(45))
    expect(bp3.tick().state).toBe("CRITICAL")
    // 压力降到 20（仍 > criticalExit 15）→ 保持 CRITICAL（滞后）
    const bp4 = new PsiBackpressure(thresholds, fakePsi(20))
    bp4["state"] = "CRITICAL" as never
    expect(bp4.tick().state).toBe("CRITICAL")
    // 降到 10 → RECOVERY
    const bp5 = new PsiBackpressure(thresholds, fakePsi(8))
    bp5["state"] = "CRITICAL" as never
    expect(bp5.tick().state).toBe("RECOVERY")
    // RECOVERY 后压力继续低 → NORMAL
    expect(bp5.tick().state).toBe("NORMAL")
  })

  test("critical pauseNewBuilds, recovery caps concurrency", () => {
    const bp = new PsiBackpressure(thresholds, fakePsi(60))
    const critical = bp.tick()
    expect(critical.state).toBe("CRITICAL")
    expect(critical.pauseNewBuilds).toBe(true)
    expect(critical.stopLowPriorityPrefetch).toBe(true)

    // RECOVERY 状态 + 中间压力（10-40 之间不触发转换）→ gradualRecovery
    const bp2 = new PsiBackpressure(thresholds, fakePsi(20))
    bp2["state"] = "RECOVERY" as never
    const recovery = bp2.tick()
    expect(recovery.state).toBe("RECOVERY")
    expect(recovery.gradualRecovery).toBe(true)
    expect(recovery.concurrencyCap).toBe(2)
  })

  test("constrained stops low-priority prefetch only", () => {
    const bp = new PsiBackpressure(thresholds, fakePsi(12))
    const decision = bp.tick()
    expect(decision.stopLowPriorityPrefetch).toBe(true)
    expect(decision.pauseNewBuilds).toBe(false)
  })
})
