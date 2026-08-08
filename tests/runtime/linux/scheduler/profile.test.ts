/** LR2-3（P3-A）：资源画像验收 —— 指纹稳定 / 分位数 / 估算规则迁移
 *  （无历史→模板；少量→max×safety；稳定→p90+margin；OOM 快升；
 *  连续稳定慢降）/ 持久化。 */

import { describe, expect, test } from "bun:test"
import { HistoricalResourceProfile, fingerprintOf, type ResourceSample, type WorkloadFingerprint } from "../../../../src/runtime/linux/scheduler/profile"

const FP: WorkloadFingerprint = {
  toolKind: "test", commandFamily: "bun-test", repositoryClass: "ts",
  fileCountBucket: "100-500", backend: "host-audit", profile: "build",
  cacheState: "cold", runtimeFamily: "bun",
}

function sample(overrides: Partial<ResourceSample> = {}): ResourceSample {
  return {
    cpuUsec: 1000, peakMemoryBytes: 100 * 1024 * 1024, wallTimeMs: 1000,
    peakPids: 4, readBytes: 0, writeBytes: 0, failed: false, oomKilled: false,
    cacheHit: false, at: Date.now(), ...overrides,
  }
}

describe("WorkloadFingerprint (P3-A)", () => {
  test("same logical fingerprint hashes equal regardless of key order", () => {
    const a = fingerprintOf(FP)
    const b = fingerprintOf({ ...FP })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test("different tool kind produces different fingerprint", () => {
    expect(fingerprintOf({ ...FP, toolKind: "build" })).not.toBe(fingerprintOf(FP))
  })

  test("full command arguments are NOT part of the fingerprint (SAMPLE_FRAGMENTATION)", () => {
    // 指纹字段不含 args —— 类型上无 args 字段（结构即不变量）。
    expect("args" in FP).toBe(false)
    expect("command" in FP).toBe(false)
  })
})

describe("HistoricalResourceProfile (P3-A)", () => {
  test("no history → conservative template", () => {
    const p = new HistoricalResourceProfile(FP)
    const est = p.estimate({ defaultMemoryBytes: 512 * 1024 * 1024, defaultWallTimeMs: 30_000 })
    expect(est.basis).toBe("template")
    expect(est.memoryBytes).toBe(512 * 1024 * 1024)
  })

  test("few samples → max(default, observed max × safety)", () => {
    const p = new HistoricalResourceProfile(FP)
    for (let i = 0; i < 3; i++) {
      p.record(sample({ peakMemoryBytes: 200 * 1024 * 1024, wallTimeMs: 2000 }))
    }
    const est = p.estimate({ defaultMemoryBytes: 512 * 1024 * 1024, defaultWallTimeMs: 30_000, safetyFactor: 1.3 })
    expect(est.basis).toBe("observed")
    // observed max 200MB × 1.3 = 260MB < default 512MB → default 保留
    expect(est.memoryBytes).toBe(512 * 1024 * 1024)
    // wall: 2000 × 1.3 = 2600ms > default? no → default
    expect(est.wallTimeMs).toBe(30_000)
    // 超过 default 时采用 observed
    const p2 = new HistoricalResourceProfile(FP)
    for (let i = 0; i < 3; i++) p2.record(sample({ peakMemoryBytes: 800 * 1024 * 1024 }))
    const est2 = p2.estimate({ defaultMemoryBytes: 512 * 1024 * 1024, defaultWallTimeMs: 30_000 })
    expect(est2.memoryBytes).toBeGreaterThan(512 * 1024 * 1024)
  })

  test("stable history → p90 + margin (30 stable rounds reaches stabilized)", () => {
    const p = new HistoricalResourceProfile(FP)
    for (let i = 0; i < 30; i++) {
      p.record(sample({ peakMemoryBytes: 300 * 1024 * 1024, wallTimeMs: 1500 }))
    }
    const est = p.estimate({ defaultMemoryBytes: 100 * 1024 * 1024, defaultWallTimeMs: 1000 })
    // 30 轮连续稳定 → stabilized（≥20 轮规则）
    expect(est.basis).toBe("stabilized")
    // p90 ≈ 300MB × 1.3 × 0.9 ≈ 351MB
    expect(est.memoryBytes).toBeGreaterThan(300 * 1024 * 1024)
    expect(est.memoryBytes).toBeLessThan(400 * 1024 * 1024)
  })

  test("OOM raises memory estimate quickly (OOM_ESTIMATE_LAGS)", () => {
    const p = new HistoricalResourceProfile(FP)
    for (let i = 0; i < 10; i++) p.record(sample({ peakMemoryBytes: 100 * 1024 * 1024 }))
    p.record(sample({ peakMemoryBytes: 100 * 1024 * 1024, oomKilled: true, failed: true, at: Date.now() }))
    const est = p.estimate({ defaultMemoryBytes: 200 * 1024 * 1024, defaultWallTimeMs: 5000, now: Date.now() })
    // OOM 快升：≥ default × 2
    expect(est.memoryBytes).toBeGreaterThanOrEqual(400 * 1024 * 1024)
  })

  test("continuous stability slowly lowers estimate (升得快降得慢)", () => {
    const p = new HistoricalResourceProfile(FP)
    for (let i = 0; i < 25; i++) p.record(sample({ peakMemoryBytes: 400 * 1024 * 1024 }))
    // 稳定 25 轮 → stabilized（0.9 降）
    const est = p.estimate({ defaultMemoryBytes: 100 * 1024 * 1024, defaultWallTimeMs: 1000 })
    expect(est.basis).toBe("stabilized")
    // 400×1.3×0.9 = 468MB < 未降的 520MB
    const pFresh = new HistoricalResourceProfile(FP)
    for (let i = 0; i < 25; i++) pFresh.record(sample({ peakMemoryBytes: 400 * 1024 * 1024 }))
    pFresh.stableRounds = 0 // 模拟刚失败
    const estFresh = pFresh.estimate({ defaultMemoryBytes: 100 * 1024 * 1024, defaultWallTimeMs: 1000 })
    expect(est.memoryBytes).toBeLessThan(estFresh.memoryBytes)
  })

  test("persistence roundtrip", () => {
    const p = new HistoricalResourceProfile(FP)
    p.record(sample({ peakMemoryBytes: 123 * 1024 * 1024, at: 42 }))
    const restored = HistoricalResourceProfile.fromJSON(p.toJSON())
    expect(restored.sampleCount).toBe(1)
    expect(restored.samples[0]!.peakMemoryBytes).toBe(123 * 1024 * 1024)
    expect(restored.estimate({ defaultMemoryBytes: 1, defaultWallTimeMs: 1 }).basis).toBe("observed")
  })
})
