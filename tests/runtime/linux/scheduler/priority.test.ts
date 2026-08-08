/** LR2-3（P3-C）：优先级模型验收 —— 显式字段 / 公式可测 / 决策日志 /
 *  压力成本压过新任务。 */

import { describe, expect, test } from "bun:test"
import { evaluatePriority, type PriorityInput } from "../../../../src/runtime/linux/scheduler/priority"

function base(overrides: Partial<PriorityInput> = {}): PriorityInput {
  return {
    criticalPathLength: 1,
    downstreamBlockedCount: 0,
    userVisibility: 0.5,
    verificationImportance: 0.5,
    estimatedDurationMs: 1000,
    estimatedResourceCost: 1,
    cacheHitProbability: 0.5,
    retryRisk: 0.1,
    resourcePressureCost: 0,
    ...overrides,
  }
}

describe("Priority model (P3-C)", () => {
  test("fields are explicit and the formula is monotonic in each positive term", () => {
    const low = evaluatePriority(base())
    const high = evaluatePriority(base({
      criticalPathLength: 5, downstreamBlockedCount: 3, userVisibility: 1, verificationImportance: 1, cacheHitProbability: 0.9,
    }))
    expect(high.score).toBeGreaterThan(low.score)
  })

  test("penalties reduce score: duration / resource / retry / pressure", () => {
    const baseScore = evaluatePriority(base()).score
    expect(evaluatePriority(base({ estimatedDurationMs: 60_000 })).score).toBeLessThan(baseScore)
    expect(evaluatePriority(base({ estimatedResourceCost: 5 })).score).toBeLessThan(baseScore)
    expect(evaluatePriority(base({ retryRisk: 0.9 })).score).toBeLessThan(baseScore)
    expect(evaluatePriority(base({ resourcePressureCost: 1 })).score).toBeLessThan(baseScore)
  })

  test("PSI CRITICAL pressure heavily penalizes new tasks (gate at PSI layer)", () => {
    const idle = evaluatePriority(base({ resourcePressureCost: 0 }))
    const pressured = evaluatePriority(base({ resourcePressureCost: 1 }))
    // 同关键路径下压力显著降低评分
    expect(pressured.score).toBeLessThan(idle.score)
    const samePath = evaluatePriority(base({ criticalPathLength: 5 }))
    const samePathPressured = evaluatePriority(base({ criticalPathLength: 5, resourcePressureCost: 1 }))
    expect(samePathPressured.score).toBeLessThan(samePath.score)
    // 暂停新任务的闸门在 PSI 层（pauseNewBuilds）—— 排序公式不承担
    // "压过一切"的职责（极端关键路径 + 压力仍可能正分）。
  })

  test("decision log records every field contribution (explainable)", () => {
    const decision = evaluatePriority(base())
    for (const key of ["criticality", "downstreamUnlock", "userVisibility", "verification", "cacheOpportunity", "durationPenalty", "resourceCostPenalty", "retryRiskPenalty", "pressurePenalty"]) {
      expect(decision.log).toHaveProperty(key)
      expect(typeof decision.log[key]).toBe("number")
    }
    // 日志数值 = 字段 × 权重（可复核）
    expect(decision.log["userVisibility"]).toBeCloseTo(0.5 * 4)
  })
})
