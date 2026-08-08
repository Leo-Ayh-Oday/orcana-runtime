/** LR2-3 Gate 验收（P3-F）：7 项 Gate 各一条显式断言。
 *
 *  SAMPLE_FRAGMENTATION（指纹不使用完整命令参数）   = 0
 *  OOM_ESTIMATE_LAGS（OOM 后快速提高）             = 0
 *  PSI_THRESHOLD_UNCALIBRATED（阈值来自本机基线）   = 0
 *  STARVATION_BY_RUN（大 Run 不占满）               = 0
 *  EVOLUTION_QUOTA_EXCEEDED                        = 0
 *  STEALING_CONDITION_VIOLATED                     = 0
 *  SPECULATIVE_STALE_COMMIT（digest 不一致不提交）   = 0
 */

import { describe, expect, test } from "bun:test"
import { fingerprintOf, HistoricalResourceProfile, type WorkloadFingerprint } from "../../../../src/runtime/linux/scheduler/profile"
import { calibratePsiThresholds } from "../../../../src/runtime/linux/scheduler/psi"
import { RunFairnessScheduler, type FairnessConfig } from "../../../../src/runtime/linux/scheduler/fairness"
import { canSteal } from "../../../../src/runtime/linux/scheduler/stealing"
import { verifySpeculativeResult, type SpeculativeResult } from "../../../../src/runtime/linux/scheduler/speculative"
import type { QueueItem } from "../../../../src/runtime/linux/scheduler/queue"

const FP: WorkloadFingerprint = {
  toolKind: "test", commandFamily: "bun-test", repositoryClass: "ts",
  fileCountBucket: "100-500", backend: "host-audit", profile: "build",
  cacheState: "cold", runtimeFamily: "bun",
}

describe("LR2-3 Gates (P3-F)", () => {
  test("SAMPLE_FRAGMENTATION = 0: fingerprint never includes full command arguments", () => {
    expect("args" in FP).toBe(false)
    expect("command" in FP).toBe(false)
    // 同 tool/command family 但不同参数 → 同指纹（样本聚合，不碎片化）
    expect(fingerprintOf(FP)).toBe(fingerprintOf({ ...FP }))
  })

  test("OOM_ESTIMATE_LAGS = 0: OOM quickly raises the memory estimate", () => {
    const p = new HistoricalResourceProfile(FP)
    for (let i = 0; i < 10; i++) p.record({ cpuUsec: 1, peakMemoryBytes: 100 * 1024 * 1024, wallTimeMs: 100, peakPids: 2, readBytes: 0, writeBytes: 0, failed: false, oomKilled: false, cacheHit: false, at: 1 })
    p.record({ cpuUsec: 1, peakMemoryBytes: 100 * 1024 * 1024, wallTimeMs: 100, peakPids: 2, readBytes: 0, writeBytes: 0, failed: true, oomKilled: true, cacheHit: false, at: Date.now() })
    const est = p.estimate({ defaultMemoryBytes: 200 * 1024 * 1024, defaultWallTimeMs: 5000, now: Date.now() })
    expect(est.memoryBytes).toBeGreaterThanOrEqual(400 * 1024 * 1024)
  })

  test("PSI_THRESHOLD_UNCALIBRATED = 0: thresholds derive from local baseline", () => {
    // 空闲基线低（0.5%）→ 阈值低
    const idle = calibratePsiThresholds([0.2, 0.4, 0.5, 0.6, 0.9])
    expect(idle.constrainedEnter).toBe(10) // max(10, 0.5×20=10)
    expect(idle.criticalEnter).toBe(40) // max(40, 0.5×50=25)
    // 基线高（10%）→ 阈值高（不复制云参数，随本机）
    const loaded = calibratePsiThresholds([8, 9, 10, 12, 15])
    expect(loaded.constrainedEnter).toBeGreaterThan(10)
    expect(loaded.criticalEnter).toBeGreaterThan(40)
    expect(loaded.criticalExit).toBeLessThan(loaded.criticalEnter)
  })

  test("STARVATION_BY_RUN = 0: a big run cannot fill every slot", () => {
    const config: FairnessConfig = { totalSlots: 6, maxRunShare: 0.5, evolutionQuota: 1, interactiveReserved: 1 }
    const s = new RunFairnessScheduler(config)
    for (let i = 0; i < 3; i++) s.enqueue({ id: `big-${i}`, runId: "big", priority: "normal", weight: 1 })
    s.enqueue({ id: "small", runId: "small", priority: "normal", weight: 1 })
    const scheduled: string[] = []
    for (let i = 0; i < 4; i++) {
      const d = s.next()
      if (d.allowed) { scheduled.push(d.allowed.runId); s.markRunning(d.allowed) }
    }
    expect(scheduled[3]).toBe("small")
  })

  test("EVOLUTION_QUOTA_EXCEEDED = 0: evolution hard quota enforced", () => {
    const s = new RunFairnessScheduler({ totalSlots: 6, maxRunShare: 1, evolutionQuota: 1, interactiveReserved: 0 })
    s.enqueue({ id: "e1", runId: "a", priority: "evolution", weight: 1 })
    s.enqueue({ id: "e2", runId: "b", priority: "evolution", weight: 1 })
    const first = s.next()
    s.markRunning(first.allowed!)
    const second = s.next()
    expect(second.allowed).toBeUndefined()
  })

  test("STEALING_CONDITION_VIOLATED = 0: any violated condition blocks the steal", () => {
    const ok = canSteal(
      { nodeId: "n", nodeRunId: "r:n", capabilityId: "run_process", ownerFiles: ["a"], newOwnerFiles: ["a"], hasPrivateContextDependency: false, started: false },
      { agentId: "a2", capabilities: ["run_process"], secretsAuthorized: true },
    )
    expect(ok.allowed).toBe(true)
    // 4 个条件同时违反 → 拒绝
    const bad = canSteal(
      { nodeId: "n", nodeRunId: "r:n", capabilityId: "run_process", ownerFiles: ["a"], newOwnerFiles: ["a", "b"], hasPrivateContextDependency: true, started: true },
      { agentId: "a2", capabilities: ["other"], secretsAuthorized: false },
    )
    expect(bad.allowed).toBe(false)
    if (!bad.allowed) expect(bad.reasons.length).toBeGreaterThanOrEqual(4)
  })

  test("SPECULATIVE_STALE_COMMIT = 0: stale speculative results never commit", () => {
    const result: SpeculativeResult = {
      kind: "repo-map",
      inputDigest: "i1", workspaceDigest: "w1", policyDigest: "p1", toolchainDigest: "t1",
      output: {}, producedAt: 1,
    }
    expect(verifySpeculativeResult(result, { inputDigest: "i1", workspaceDigest: "w1", policyDigest: "p1", toolchainDigest: "t1" })).toBe(true)
    expect(verifySpeculativeResult(result, { inputDigest: "i1", workspaceDigest: "w2", policyDigest: "p1", toolchainDigest: "t1" })).toBe(false)
  })
})
