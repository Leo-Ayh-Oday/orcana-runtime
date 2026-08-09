/** LR2-6（P6-C）验收：Security Gate + 性能回归评估。 */

import { describe, test, expect } from "bun:test"
import { compareSecurityGates, snapshotOf } from "../../src/evolution/security"
import { computePerfBaseline, comparePerfBaselines } from "../../src/evolution/performance"

describe("P6-C: Security Gate", () => {
  test("equal gates → non-regressing", () => {
    const b = snapshotOf({ DIRECT_PRODUCT_PROCESS_BYPASS: 0, HOST_ENVIRONMENT_IMPLICIT_INHERIT: 0 })
    const c = snapshotOf({ DIRECT_PRODUCT_PROCESS_BYPASS: 0, HOST_ENVIRONMENT_IMPLICIT_INHERIT: 0 })
    const v = compareSecurityGates(b, c)
    expect(v.ok).toBe(true)
  })

  test("candidate better (lower) → ok", () => {
    const b = snapshotOf({ RECEIPT_UNOBSERVED_SUCCESS_FIELD: 2 })
    const c = snapshotOf({ RECEIPT_UNOBSERVED_SUCCESS_FIELD: 0 })
    expect(compareSecurityGates(b, c).ok).toBe(true)
  })

  test("any gate increase → SECURITY_GATE_REGRESSION with details", () => {
    const b = snapshotOf({ DIRECT_PRODUCT_PROCESS_BYPASS: 0, PROCESS_OUTSIDE_CELL_CGROUP: 0 })
    const c = snapshotOf({ DIRECT_PRODUCT_PROCESS_BYPASS: 3, PROCESS_OUTSIDE_CELL_CGROUP: 0 })
    const v = compareSecurityGates(b, c)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.regressedGates).toHaveLength(1)
      expect(v.regressedGates[0]?.gate).toBe("DIRECT_PRODUCT_PROCESS_BYPASS")
      expect(v.regressedGates[0]?.baseline).toBe(0)
      expect(v.regressedGates[0]?.candidate).toBe(3)
      expect(v.reason).toContain("DIRECT_PRODUCT_PROCESS_BYPASS")
    }
  })

  test("candidate-new gate absent in baseline → baseline treated as 0", () => {
    const b = snapshotOf({})
    const c = snapshotOf({ CLEANUP_RESOURCE_LEAK: 1 })
    expect(compareSecurityGates(b, c).ok).toBe(false)
  })
})

describe("P6-C: Performance", () => {
  test("baseline computed from samples (p50/p95)", () => {
    const base = computePerfBaseline("warm-start", [100, 110, 120, 130, 200])
    expect(base.p50Ms).toBe(120)
    expect(base.p95Ms).toBe(200)
    expect(base.sampleCount).toBe(5)
  })

  test("empty samples rejected", () => {
    expect(() => computePerfBaseline("x", [])).toThrow(/samples/)
  })

  test("candidate within threshold → ok", () => {
    const base = computePerfBaseline("warm-start", [100, 100, 100])
    const v = comparePerfBaselines([base], [
      { benchName: "warm-start", valueMs: 104 },
      { benchName: "warm-start", valueMs: 100 },
      { benchName: "warm-start", valueMs: 105 },
    ], { maxRegressionRatio: 0.1 })
    expect(v.ok).toBe(true)
  })

  test("candidate beyond threshold → PERF_REGRESSION with ratio", () => {
    const base = computePerfBaseline("replay", [100, 100, 100, 100, 100])
    const v = comparePerfBaselines([base], [
      { benchName: "replay", valueMs: 300 },
      { benchName: "replay", valueMs: 290 },
      { benchName: "replay", valueMs: 310 },
    ], { maxRegressionRatio: 0.1 })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.regressed[0]?.benchName).toBe("replay")
      expect(v.regressed[0]?.candidateP95Ms).toBe(310)
      expect(v.reason).toContain("replay")
    }
  })

  test("threshold from baseline, not hardcoded: 0 threshold rejects small delta", () => {
    const base = computePerfBaseline("x", [100, 100, 100])
    const v = comparePerfBaselines([base], [
      { benchName: "x", valueMs: 101 },
      { benchName: "x", valueMs: 100 },
      { benchName: "x", valueMs: 100 },
    ], { maxRegressionRatio: 0 })
    expect(v.ok).toBe(false)
  })

  test("candidate-only bench ignored (no baseline to compare)", () => {
    const base = computePerfBaseline("existing", [10, 10])
    const v = comparePerfBaselines([base], [{ benchName: "new-bench", valueMs: 9999 }], { maxRegressionRatio: 0.1 })
    expect(v.ok).toBe(true)
  })

  test("invalid maxRegressionRatio rejected", () => {
    const base = computePerfBaseline("x", [1])
    expect(() => comparePerfBaselines([base], [{ benchName: "x", valueMs: 1 }], { maxRegressionRatio: 2 })).toThrow()
  })
})
