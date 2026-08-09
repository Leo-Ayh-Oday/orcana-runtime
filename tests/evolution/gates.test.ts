/** LR2-6（P6-E）Gate 验收：9 项 LR2-6 Gate，每项一条验收测试。
 *
 *  Gates:
 *  CANDIDATE_CONTROLS_BENCHMARK      = 0
 *  ENVIRONMENT_DRIFT_UNDETECTED      = 0
 *  REGRESSION_PROMOTED               = 0
 *  HIDDEN_FAILURE_PROMOTED           = 0
 *  SECURITY_GATE_REGRESSION          = 0
 *  PERF_REGRESSION_IGNORED           = 0
 *  CANDIDATE_WRITES_BASELINE         = 0
 *  PROMOTION_WITHOUT_HUMAN_APPROVAL  = 0
 *  CANARY_REGRESSION_UNWATCHED       = 0
 */

import { describe, test, expect } from "bun:test"
import { validateManifestInput, manifestIdOf, type EvolutionManifestInput } from "../../src/evolution/manifest"
import { environmentDrift, buildEnvironmentFacts } from "../../src/evolution/digest"
import { runReplay, type ReplayExecutor } from "../../src/evolution/replay"
import { buildDifferentialReport } from "../../src/evolution/report"
import { compareSecurityGates } from "../../src/evolution/security"
import { computePerfBaseline, comparePerfBaselines } from "../../src/evolution/performance"
import { createPromotion, evaluateCandidate, runCanary, retryCanary, humanApprove, promote, watchRegressions } from "../../src/evolution/promotion"

const sha = (s: string) => require("node:crypto").createHash("sha256").update(s).digest("hex")

function facts(overrides = {}) {
  return buildEnvironmentFacts({
    sourceDigest: sha("src"),
    toolchainDigest: sha("bun"),
    evaluatorVersion: "eval-1.0",
    benchmarkManifestDigest: sha("bench"),
    ...overrides,
  })
}

function input(overrides: Partial<EvolutionManifestInput> = {}): EvolutionManifestInput {
  return {
    benchmarkSet: [{ id: "c1", inputDigest: sha("i1") }],
    scorer: { scorerDigest: sha("sc"), correctnessRulesDigest: sha("cr") },
    environment: facts(),
    promotionCriteria: { requireZeroRegression: true, requireSecurityGateNonRegression: true, maxPerfRegressionRatio: 0.1, requireNoHiddenFailure: true, canaryWatchWindowMs: 60_000 },
    baselineRef: "base-commit",
    evaluatorVersion: "eval-1.0",
    ...overrides,
  }
}

const passExecutor: ReplayExecutor = async c => ({ caseId: c.id, inputDigest: c.inputDigest, outcome: "passed", durationMs: 1, environmentDigest: sha("e") })

describe("LR2-6 Gates", () => {
  test("CANDIDATE_CONTROLS_BENCHMARK = 0: swapping benchmark set changes manifest id", () => {
    const orig = manifestIdOf(input())
    const swapped = manifestIdOf(input({ benchmarkSet: [{ id: "evil", inputDigest: sha("evil") }] }))
    expect(swapped).not.toBe(orig)
    // 且候选提供的"新清单"无法与旧 manifestId 关联
    const v = validateManifestInput(input({ benchmarkSet: [{ id: "evil", inputDigest: sha("evil") }] }))
    if (v.ok) expect(v.manifest.manifestId).not.toBe(orig)
  })

  test("ENVIRONMENT_DRIFT_UNDETECTED = 0: toolchain drift detected before replay", async () => {
    const m = validateManifestInput(input())
    if (!m.ok) throw new Error("setup")
    let called = false
    await expect(runReplay({
      manifest: m.manifest,
      baselineSourceRef: "b",
      candidateSourceRef: "c",
      candidateEnvironment: facts({ toolchainDigest: sha("other") }),
      executor: async c => { called = true; return { caseId: c.id, inputDigest: c.inputDigest, outcome: "passed", durationMs: 1, environmentDigest: sha("e") } },
    })).rejects.toThrow(/environment drift/)
    expect(called).toBe(false)
    const drift = environmentDrift(facts(), facts({ toolchainDigest: sha("other") }))
    expect(drift.drift).toBe(true)
    expect(drift.differingFields).toContain("toolchainDigest")
  })

  test("REGRESSION_PROMOTED = 0: pass→fail blocks promotion at evaluation", () => {
    const m = validateManifestInput(input())
    if (!m.ok) throw new Error("setup")
    const diff = buildDifferentialReport(
      { side: "baseline", manifestId: m.manifest.manifestId, sourceRef: "b", results: [{ caseId: "c1", inputDigest: sha("i1"), outcome: "passed", durationMs: 1, environmentDigest: sha("e") }], startedAt: "" },
      { side: "candidate", manifestId: m.manifest.manifestId, sourceRef: "c", results: [{ caseId: "c1", inputDigest: sha("i1"), outcome: "failed", durationMs: 1, environmentDigest: sha("e"), detail: "regressed" }], startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: true },
    )
    let rec = createPromotion(m.manifest, "c")
    rec = evaluateCandidate(rec, m.manifest, {
      differential: diff,
      security: { ok: true, reason: "ok" },
      performance: { ok: true, reason: "ok" },
      actualEvaluatorVersion: "eval-1.0",
    })
    expect(rec.state).toBe("REJECTED_CRITERIA")
  })

  test("HIDDEN_FAILURE_PROMOTED = 0: new failure (case removed) blocks promotion", () => {
    const m = validateManifestInput(input())
    if (!m.ok) throw new Error("setup")
    const diff = buildDifferentialReport(
      { side: "baseline", manifestId: m.manifest.manifestId, sourceRef: "b", results: [{ caseId: "c1", inputDigest: sha("i1"), outcome: "passed", durationMs: 1, environmentDigest: sha("e") }], startedAt: "" },
      { side: "candidate", manifestId: m.manifest.manifestId, sourceRef: "c", results: [], startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: true },
    )
    let rec = createPromotion(m.manifest, "c")
    rec = evaluateCandidate(rec, m.manifest, {
      differential: diff,
      security: { ok: true, reason: "ok" },
      performance: { ok: true, reason: "ok" },
      actualEvaluatorVersion: "eval-1.0",
    })
    expect(rec.state).toBe("REJECTED_CRITERIA")
    expect(rec.transitions.at(-1)?.reason).toContain("mismatch")
  })

  test("SECURITY_GATE_REGRESSION = 0: gate increase blocks promotion", () => {
    const v = compareSecurityGates(
      { gates: { DIRECT_PRODUCT_PROCESS_BYPASS: 0 }, source: "b", evaluatedAt: "" },
      { gates: { DIRECT_PRODUCT_PROCESS_BYPASS: 2 }, source: "c", evaluatedAt: "" },
    )
    expect(v.ok).toBe(false)
  })

  test("PERF_REGRESSION_IGNORED = 0: perf regression blocks promotion", () => {
    const base = computePerfBaseline("warm", [100, 100, 100, 100, 100])
    const v = comparePerfBaselines([base], [
      { benchName: "warm", valueMs: 500 }, { benchName: "warm", valueMs: 500 }, { benchName: "warm", valueMs: 500 },
    ], { maxRegressionRatio: 0.1 })
    expect(v.ok).toBe(false)
  })

  test("CANDIDATE_WRITES_BASELINE = 0: baseline only updated via promote()", async () => {
    const m = validateManifestInput(input())
    if (!m.ok) throw new Error("setup")
    const { baseline, candidate } = await runReplay({ manifest: m.manifest, baselineSourceRef: "b", candidateSourceRef: "c", executor: passExecutor })
    const diff = buildDifferentialReport(baseline, candidate, { requireZeroRegression: true, requireNoHiddenFailure: true })
    let rec = createPromotion(m.manifest, "c")
    rec = evaluateCandidate(rec, m.manifest, { differential: diff, security: { ok: true, reason: "ok" }, performance: { ok: true, reason: "ok" }, actualEvaluatorVersion: "eval-1.0" })
    rec = runCanary(rec, { ok: true, newRegressions: 0 })
    rec = humanApprove(rec, true)
    expect(rec.promotedBaselineRef).toBeUndefined() // promote 前基线未更新
    rec = promote(rec, "new-base")
    expect(rec.promotedBaselineRef).toBe("new-base")
  })

  test("PROMOTION_WITHOUT_HUMAN_APPROVAL = 0: promote from CANARY throws", () => {
    const m = validateManifestInput(input())
    if (!m.ok) throw new Error("setup")
    let rec = createPromotion(m.manifest, "c")
    rec = evaluateCandidate(rec, m.manifest, {
      differential: buildDifferentialReport(
        { side: "baseline", manifestId: m.manifest.manifestId, sourceRef: "b", results: [{ caseId: "c1", inputDigest: sha("i1"), outcome: "passed", durationMs: 1, environmentDigest: sha("e") }], startedAt: "" },
        { side: "candidate", manifestId: m.manifest.manifestId, sourceRef: "c", results: [{ caseId: "c1", inputDigest: sha("i1"), outcome: "passed", durationMs: 1, environmentDigest: sha("e") }], startedAt: "" },
        { requireZeroRegression: true, requireNoHiddenFailure: true },
      ),
      security: { ok: true, reason: "ok" },
      performance: { ok: true, reason: "ok" },
      actualEvaluatorVersion: "eval-1.0",
    })
    rec = runCanary(rec, { ok: true, newRegressions: 0 })
    expect(() => promote(rec, "new-base")).toThrow(/expected APPROVED/)
  })

  test("CANARY_REGRESSION_UNWATCHED = 0: watch catches post-promotion regression; canary failure retryable", () => {
    const m = validateManifestInput(input())
    if (!m.ok) throw new Error("setup")
    let rec = createPromotion(m.manifest, "c")
    rec = evaluateCandidate(rec, m.manifest, {
      differential: buildDifferentialReport(
        { side: "baseline", manifestId: m.manifest.manifestId, sourceRef: "b", results: [{ caseId: "c1", inputDigest: sha("i1"), outcome: "passed", durationMs: 1, environmentDigest: sha("e") }], startedAt: "" },
        { side: "candidate", manifestId: m.manifest.manifestId, sourceRef: "c", results: [{ caseId: "c1", inputDigest: sha("i1"), outcome: "passed", durationMs: 1, environmentDigest: sha("e") }], startedAt: "" },
        { requireZeroRegression: true, requireNoHiddenFailure: true },
      ),
      security: { ok: true, reason: "ok" },
      performance: { ok: true, reason: "ok" },
      actualEvaluatorVersion: "eval-1.0",
    })
    rec = runCanary(rec, { ok: false, newRegressions: 1, detail: "canary regression" })
    expect(rec.state).toBe("CANARY_FAILED")
    rec = retryCanary(rec, { ok: true, newRegressions: 0 })
    expect(rec.state).toBe("CANARY")
    rec = humanApprove(rec, true)
    rec = promote(rec, "new-base")
    expect(watchRegressions(rec, 1, 60_000).regressed).toBe(true)
    expect(watchRegressions(rec, 0, 60_000).regressed).toBe(false)
  })
})
