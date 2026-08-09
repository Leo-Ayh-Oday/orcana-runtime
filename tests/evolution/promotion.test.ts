/** LR2-6（P6-D）验收：晋升管线。 */

import { describe, test, expect } from "bun:test"
import {
  createPromotion,
  evaluateCandidate,
  runCanary,
  retryCanary,
  humanApprove,
  promote,
  watchRegressions,
} from "../../src/evolution/promotion"
import { validateManifestInput } from "../../src/evolution/manifest"
import { buildDifferentialReport } from "../../src/evolution/report"
import { snapshotOf } from "../../src/evolution/security"
import { computePerfBaseline } from "../../src/evolution/performance"

const sha = (s: string) => require("node:crypto").createHash("sha256").update(s).digest("hex")

function manifest() {
  const r = validateManifestInput({
    benchmarkSet: [{ id: "c1", inputDigest: sha("i1") }],
    scorer: { scorerDigest: sha("sc"), correctnessRulesDigest: sha("cr") },
    environment: {
      sourceDigest: sha("src"),
      toolchainDigest: sha("bun"),
      evaluatorVersion: "eval-1.0",
      benchmarkManifestDigest: sha("bench"),
    },
    promotionCriteria: { requireZeroRegression: true, requireSecurityGateNonRegression: true, maxPerfRegressionRatio: 0.1, requireNoHiddenFailure: true, canaryWatchWindowMs: 60_000 },
    baselineRef: "base-commit",
    evaluatorVersion: "eval-1.0",
  })
  if (!r.ok) throw new Error("manifest setup failed")
  return r.manifest
}

/** 全绿的评估证据。 */
function greenEvidence(overrides: Partial<Parameters<typeof evaluateCandidate>[2]> = {}) {
  const m = manifest()
  const diff = buildDifferentialReport(
    { side: "baseline", manifestId: m.manifestId, sourceRef: "b", results: [{ caseId: "c1", inputDigest: sha("i1"), outcome: "passed", durationMs: 1, environmentDigest: sha("e") }], startedAt: "" },
    { side: "candidate", manifestId: m.manifestId, sourceRef: "c", results: [{ caseId: "c1", inputDigest: sha("i1"), outcome: "passed", durationMs: 1, environmentDigest: sha("e") }], startedAt: "" },
    { requireZeroRegression: true, requireNoHiddenFailure: true },
  )
  const base: Parameters<typeof evaluateCandidate>[2] = {
    differential: diff,
    security: { ok: true, reason: "gates ok" },
    performance: { ok: true, reason: "perf ok" },
    actualEvaluatorVersion: m.evaluatorVersion,
  }
  return { ...base, ...overrides }
}

describe("P6-D: Promotion pipeline", () => {
  test("full happy path reaches PROMOTED and updates baseline", () => {
    const m = manifest()
    let rec = createPromotion(m, "cand-commit")
    expect(rec.state).toBe("PROPOSED")
    rec = evaluateCandidate(rec, m, greenEvidence())
    expect(rec.state).toBe("EVALUATED")
    rec = runCanary(rec, { ok: true, newRegressions: 0, detail: "canary green" })
    expect(rec.state).toBe("CANARY")
    rec = humanApprove(rec, true)
    expect(rec.state).toBe("APPROVED")
    rec = promote(rec, "new-baseline-commit")
    expect(rec.state).toBe("PROMOTED")
    expect(rec.promotedBaselineRef).toBe("new-baseline-commit")
    // 晋升后回归监视
    expect(watchRegressions(rec, 0, 60_000).regressed).toBe(false)
    expect(watchRegressions(rec, 2, 60_000).regressed).toBe(true)
  })

  test("PROMOTION_WITHOUT_HUMAN_APPROVAL: promote without approve → throws", () => {
    const m = manifest()
    let rec = createPromotion(m, "cand")
    rec = evaluateCandidate(rec, m, greenEvidence())
    rec = runCanary(rec, { ok: true, newRegressions: 0 })
    expect(() => promote(rec, "new-base")).toThrow(/expected APPROVED/)
  })

  test("REJECTED_CRITERIA: replay regression blocks", () => {
    const m = manifest()
    const diff = buildDifferentialReport(
      { side: "baseline", manifestId: m.manifestId, sourceRef: "b", results: [{ caseId: "c1", inputDigest: sha("i1"), outcome: "passed", durationMs: 1, environmentDigest: sha("e") }], startedAt: "" },
      { side: "candidate", manifestId: m.manifestId, sourceRef: "c", results: [{ caseId: "c1", inputDigest: sha("i1"), outcome: "failed", durationMs: 1, environmentDigest: sha("e"), detail: "x" }], startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: true },
    )
    let rec = createPromotion(m, "cand")
    rec = evaluateCandidate(rec, m, greenEvidence({ differential: diff }))
    expect(rec.state).toBe("REJECTED_CRITERIA")
    expect(rec.transitions.at(-1)?.reason).toContain("REGRESSION")
  })

  test("SECURITY_REGRESSION: gate increase blocks", () => {
    const m = manifest()
    const security = { ok: false as const, reason: "gate regression", regressedGates: [{ gate: "X", baseline: 0, candidate: 1 }] }
    let rec = createPromotion(m, "cand")
    rec = evaluateCandidate(rec, m, greenEvidence({ security }))
    expect(rec.state).toBe("SECURITY_REGRESSION")
  })

  test("PERF_REGRESSION: perf beyond threshold blocks", () => {
    const m = manifest()
    const performance = { ok: false as const, reason: "perf regression", regressed: [{ benchName: "w", baselineP95Ms: 100, candidateP95Ms: 300, ratio: 3 }] }
    let rec = createPromotion(m, "cand")
    rec = evaluateCandidate(rec, m, greenEvidence({ performance }))
    expect(rec.state).toBe("PERF_REGRESSION")
  })

  test("EVALUATOR_CHANGED: actual != manifest.evaluatorVersion blocks", () => {
    const m = manifest()
    let rec = createPromotion(m, "cand")
    rec = evaluateCandidate(rec, m, greenEvidence({ actualEvaluatorVersion: "eval-2.0" }))
    expect(rec.state).toBe("EVALUATOR_CHANGED")
  })

  test("CANARY_FAILED: canary regression blocks promotion", () => {
    const m = manifest()
    let rec = createPromotion(m, "cand")
    rec = evaluateCandidate(rec, m, greenEvidence())
    rec = runCanary(rec, { ok: false, newRegressions: 1, detail: "new failure in prod path" })
    expect(rec.state).toBe("CANARY_FAILED")
    expect(() => humanApprove(rec, true)).toThrow()
  })

  test("HUMAN_DECLINED: human can decline", () => {
    const m = manifest()
    let rec = createPromotion(m, "cand")
    rec = evaluateCandidate(rec, m, greenEvidence())
    rec = runCanary(rec, { ok: true, newRegressions: 0 })
    rec = humanApprove(rec, false, "not ready")
    expect(rec.state).toBe("HUMAN_DECLINED")
    // 驳回后可重新 canary（显式重试入口）
    rec = retryCanary(rec, { ok: true, newRegressions: 0 })
    expect(rec.state).toBe("CANARY")
  })

  test("CANDIDATE_WRITES_BASELINE: baseline only updated via promote", () => {
    const m = manifest()
    let rec = createPromotion(m, "cand")
    rec = evaluateCandidate(rec, m, greenEvidence())
    rec = runCanary(rec, { ok: true, newRegressions: 0 })
    rec = humanApprove(rec, true)
    // 在 promote 前 promotedBaselineRef 未设置（候选未写入基线）
    expect(rec.promotedBaselineRef).toBeUndefined()
    rec = promote(rec, "new-base")
    expect(rec.promotedBaselineRef).toBe("new-base")
  })

  test("watch before promotion is a no-op (no false alarm)", () => {
    const m = manifest()
    const rec = createPromotion(m, "cand")
    const w = watchRegressions(rec, 5, 60_000)
    expect(w.regressed).toBe(false)
    expect(w.reason).toContain("not promoted")
  })

  test("evaluate from wrong state throws", () => {
    const m = manifest()
    const rec = createPromotion(m, "cand")
    const evaluated = evaluateCandidate(rec, m, greenEvidence())
    expect(() => evaluateCandidate(evaluated, m, greenEvidence())).toThrow(/state mismatch/)
  })

  test("snapshot helpers reusable with security/perf modules", () => {
    const sec = snapshotOf({ GATE_A: 0 })
    expect(sec.gates.GATE_A).toBe(0)
    const perf = computePerfBaseline("replay", [10, 20, 30])
    expect(perf.p50Ms).toBe(20)
  })

  test("MINOR: requireSecurityGateNonRegression=false consumes criteria (records but does not block)", () => {
    const m = manifest()
    const relaxed = { ...m, promotionCriteria: { ...m.promotionCriteria, requireSecurityGateNonRegression: false } }
    let rec = createPromotion(relaxed, "cand")
    rec = evaluateCandidate(rec, relaxed, {
      ...greenEvidence(),
      security: { ok: false, reason: "gate regression", regressedGates: [{ gate: "X", baseline: 0, candidate: 1 }] },
    })
    expect(rec.state).toBe("EVALUATED") // 显式放宽：安全不阻断
  })

  test("MINOR: watchRegressions records into PromotionRecord.watch", () => {
    const m = manifest()
    let rec = createPromotion(m, "cand")
    rec = evaluateCandidate(rec, m, greenEvidence())
    rec = runCanary(rec, { ok: true, newRegressions: 0 })
    rec = humanApprove(rec, true)
    rec = promote(rec, "nb")
    const w = watchRegressions(rec, 2, 30_000)
    expect(w.regressed).toBe(true)
    expect(rec.watch?.regressed).toBe(true)
    expect(rec.watch?.newRegressions).toBe(2)
    expect(rec.watch?.windowMs).toBe(30_000)
  })
})
