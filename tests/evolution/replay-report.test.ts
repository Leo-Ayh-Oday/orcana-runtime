/** LR2-6（P6-B）验收：Replay + DifferentialReport。 */

import { describe, test, expect } from "bun:test"
import { runReplay, type ReplayExecutor, type ReplayCaseResult } from "../../src/evolution/replay"
import { buildDifferentialReport } from "../../src/evolution/report"
import {
  validateManifestInput,
  type EvolutionManifestInput,
} from "../../src/evolution/manifest"
import { buildEnvironmentFacts } from "../../src/evolution/digest"

const sha = (s: string) => require("node:crypto").createHash("sha256").update(s).digest("hex")

const pass: ReplayExecutor = async c => ({ caseId: c.id, inputDigest: c.inputDigest, outcome: "passed", durationMs: 1, environmentDigest: sha("env") })

function env() {
  return buildEnvironmentFacts({
    sourceDigest: sha("src"),
    toolchainDigest: sha("bun"),
    evaluatorVersion: "eval-1.0",
    benchmarkManifestDigest: sha("bench"),
  })
}

function manifest() {
  const r = validateManifestInput({
    benchmarkSet: [
      { id: "c1", inputDigest: sha("i1") },
      { id: "c2", inputDigest: sha("i2") },
      { id: "c3", inputDigest: sha("i3") },
    ],
    scorer: { scorerDigest: sha("sc"), correctnessRulesDigest: sha("cr") },
    environment: env(),
    promotionCriteria: { requireZeroRegression: true, requireSecurityGateNonRegression: true, maxPerfRegressionRatio: 0.1, requireNoHiddenFailure: true, canaryWatchWindowMs: 60_000 },
    baselineRef: "base-commit",
    evaluatorVersion: "eval-1.0",
  })
  if (!r.ok) throw new Error("manifest setup failed")
  return r.manifest
}

/** 构造一个 executor：按给定 基线→候选 结果映射表 返回。 */
function executorWith(
  map: Record<string, { b: ReplayCaseResult["outcome"]; c: ReplayCaseResult["outcome"] }>,
): ReplayExecutor {
  return async (caseRef, side) => {
    const entry = map[caseRef.id] ?? { b: "passed", c: "passed" }
    const outcome = side === "baseline" ? entry.b : entry.c
    return {
      caseId: caseRef.id,
      inputDigest: caseRef.inputDigest,
      outcome,
      detail: outcome === "failed" ? `fail-${caseRef.id}` : undefined,
      durationMs: 5,
      environmentDigest: sha("env"),
    }
  }
}

describe("P6-B: runReplay", () => {
  test("replays both sides for every case in manifest order", async () => {
    const m = manifest()
    const seen: string[] = []
    const { baseline, candidate } = await runReplay({
      manifest: m,
      baselineSourceRef: "base-commit",
      candidateSourceRef: "cand-commit",
      candidateEnvironment: env(),
      executor: async (c, side) => {
        seen.push(`${side}:${c.id}`)
        return { caseId: c.id, inputDigest: c.inputDigest, outcome: "passed", durationMs: 1, environmentDigest: sha("env") }
      },
    })
    expect(baseline.results).toHaveLength(3)
    expect(candidate.results).toHaveLength(3)
    expect(seen[0]).toBe("baseline:c1")
    expect(seen[1]).toBe("candidate:c1")
    expect(seen[2]).toBe("baseline:c2")
    expect(seen[5]).toBe("candidate:c3")
    expect(baseline.sourceRef).toBe("base-commit")
    expect(candidate.sourceRef).toBe("cand-commit")
  })

  test("candidate environment drift rejected when requireEnvironmentMatch", async () => {
    const m = manifest()
    const driftEnv = env()
    driftEnv.toolchainDigest = sha("other-bun")
    let called = false
    await expect(runReplay({
      manifest: m,
      baselineSourceRef: "b",
      candidateSourceRef: "c",
      candidateEnvironment: driftEnv,
      executor: async c => {
        called = true
        return { caseId: c.id, inputDigest: c.inputDigest, outcome: "passed", durationMs: 1, environmentDigest: sha("env") }
      },
    })).rejects.toThrow(/environment drift/)
    expect(called).toBe(false)
  })

  test("M4: allowCandidateEnvironmentDiff permits source only (candidate's own commit)", async () => {
    const m = manifest()
    const candEnv = env()
    candEnv.sourceDigest = sha("candidate-src") // 候选自身的提交
    let called = false
    const { baseline, candidate } = await runReplay({
      manifest: m,
      baselineSourceRef: "b",
      candidateSourceRef: "c",
      candidateEnvironment: candEnv,
      allowCandidateEnvironmentDiff: ["sourceDigest"],
      executor: async c => {
        called = true
        return { caseId: c.id, inputDigest: c.inputDigest, outcome: "passed", durationMs: 1, environmentDigest: sha("env") }
      },
    })
    expect(called).toBe(true)
    expect(baseline.results).toHaveLength(3)
    expect(candidate.results).toHaveLength(3)
  })

  test("M4: allow field not in manifest environment → rejected", async () => {
    const m = manifest()
    await expect(runReplay({
      manifest: m,
      baselineSourceRef: "b",
      candidateSourceRef: "c",
      candidateEnvironment: env(),
      allowCandidateEnvironmentDiff: ["rootfsDigest"], // 清单环境没有该字段
      executor: pass,
    })).rejects.toThrow(/not in manifest environment/)
  })

  test("M4: candidateEnvironment is required (no silent skip)", async () => {
    const m = manifest()
    // 契约：候选环境必填（类型层面强制）——运行时绕过必须抛错而非静默通过
    const opts = { manifest: m, baselineSourceRef: "b", candidateSourceRef: "c", executor: pass } as unknown as Parameters<typeof runReplay>[0]
    await expect(runReplay(opts)).rejects.toThrow()
  })
})

describe("P6-B: DifferentialReport", () => {
  test("all pass → UNCHANGED_PASS, replayPassable", () => {
    const m = manifest()
    const allPass: Record<string, { b: "passed"; c: "passed" }> = {
      c1: { b: "passed", c: "passed" },
      c2: { b: "passed", c: "passed" },
      c3: { b: "passed", c: "passed" },
    }
    const rep = buildDifferentialReport(
      { side: "baseline", manifestId: m.manifestId, sourceRef: "b", results: [1, 2, 3].map(i => ({ caseId: `c${i}`, inputDigest: sha(`i${i}`), outcome: "passed" as const, durationMs: 1, environmentDigest: sha("e") })), startedAt: "" },
      { side: "candidate", manifestId: m.manifestId, sourceRef: "c", results: [1, 2, 3].map(i => ({ caseId: `c${i}`, inputDigest: sha(`i${i}`), outcome: "passed" as const, durationMs: 1, environmentDigest: sha("e") })), startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: true },
    )
    expect(rep.replayPassable).toBe(true)
    expect(rep.unchangedPass).toBe(3)
    expect(rep.blockers).toHaveLength(0)
  })

  test("pass→fail = REGRESSION → blocked", () => {
    const m = manifest()
    const base = [1, 2, 3].map(i => ({ caseId: `c${i}`, inputDigest: sha(`i${i}`), outcome: "passed" as const, durationMs: 1, environmentDigest: sha("e") }))
    const cand = base.map((r, idx) => idx === 1 ? { ...r, outcome: "failed" as const, detail: "boom" } : r)
    const rep = buildDifferentialReport(
      { side: "baseline", manifestId: m.manifestId, sourceRef: "b", results: base, startedAt: "" },
      { side: "candidate", manifestId: m.manifestId, sourceRef: "c", results: cand, startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: true },
    )
    expect(rep.regressions).toBe(1)
    expect(rep.replayPassable).toBe(false)
    expect(rep.blockers[0]).toContain("REGRESSION")
    expect(rep.caseDiffs[1]?.diffClass).toBe("REGRESSION")
  })

  test("fail→pass = IMPROVED, passable", () => {
    const m = manifest()
    const base = [1, 2, 3].map(i => ({ caseId: `c${i}`, inputDigest: sha(`i${i}`), outcome: i === 2 ? ("failed" as const) : ("passed" as const), durationMs: 1, environmentDigest: sha("e") }))
    const cand = base.map((r, idx) => idx === 1 ? { ...r, outcome: "passed" as const } : r)
    const rep = buildDifferentialReport(
      { side: "baseline", manifestId: m.manifestId, sourceRef: "b", results: base, startedAt: "" },
      { side: "candidate", manifestId: m.manifestId, sourceRef: "c", results: cand, startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: true },
    )
    expect(rep.improved).toBe(1)
    expect(rep.replayPassable).toBe(true)
  })

  test("fail→fail UNCHANGED_FAIL: with requireNoHiddenFailure and improved potential — not a hidden failure unless criteria says", () => {
    const m = manifest()
    const mk = (o: "passed" | "failed") => [1, 2].map(i => ({ caseId: `c${i}`, inputDigest: sha(`i${i}`), outcome: o, durationMs: 1, environmentDigest: sha("e") }))
    const rep = buildDifferentialReport(
      { side: "baseline", manifestId: m.manifestId, sourceRef: "b", results: mk("failed"), startedAt: "" },
      { side: "candidate", manifestId: m.manifestId, sourceRef: "c", results: mk("failed"), startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: false },
    )
    // 失败样本未减少但也没增加 —— 由更高层 criteria 判断；此处不产生新失败 blocker
    expect(rep.unchangedFail).toBe(2)
    expect(rep.replayPassable).toBe(true)
  })

  test("NEW_FAILURE (baseline-only): candidate drops a baseline case → hidden failure blocks", () => {
    const m = manifest()
    const base = [1, 2].map(i => ({ caseId: `c${i}`, inputDigest: sha(`i${i}`), outcome: "passed" as const, durationMs: 1, environmentDigest: sha("e") }))
    // c2 在候选侧不存在 → 隐藏失败（NEW_FAILURE）
    const cand = base.slice(0, 1)
    const rep = buildDifferentialReport(
      { side: "baseline", manifestId: m.manifestId, sourceRef: "b", results: base, startedAt: "" },
      { side: "candidate", manifestId: m.manifestId, sourceRef: "c", results: cand, startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: true },
    )
    expect(rep.newFailures).toBe(1)
    expect(rep.replayPassable).toBe(false)
    expect(rep.blockers.join()).toContain("HIDDEN_FAILURE")
  })

  test("NEW_FAILURE (candidate-only): candidate adds a failing case → blocked", () => {
    const m = manifest()
    const base = [1].map(i => ({ caseId: `c${i}`, inputDigest: sha(`i${i}`), outcome: "passed" as const, durationMs: 1, environmentDigest: sha("e") }))
    const cand = [
      ...base,
      { caseId: "c2", inputDigest: sha("i2"), outcome: "failed" as const, durationMs: 1, environmentDigest: sha("e"), detail: "new failure" },
    ]
    const rep = buildDifferentialReport(
      { side: "baseline", manifestId: m.manifestId, sourceRef: "b", results: base, startedAt: "" },
      { side: "candidate", manifestId: m.manifestId, sourceRef: "c", results: cand, startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: true },
    )
    expect(rep.newFailures).toBe(1)
    expect(rep.replayPassable).toBe(false)
    expect(rep.blockers.join()).toContain("HIDDEN_FAILURE")
  })

  test("candidate-only PASSING case is neutral (not a failure)", () => {
    const m = manifest()
    const base = [1].map(i => ({ caseId: `c${i}`, inputDigest: sha(`i${i}`), outcome: "passed" as const, durationMs: 1, environmentDigest: sha("e") }))
    const cand = [
      ...base,
      { caseId: "c2", inputDigest: sha("i2"), outcome: "passed" as const, durationMs: 1, environmentDigest: sha("e") },
    ]
    const rep = buildDifferentialReport(
      { side: "baseline", manifestId: m.manifestId, sourceRef: "b", results: base, startedAt: "" },
      { side: "candidate", manifestId: m.manifestId, sourceRef: "c", results: cand, startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: true },
    )
    expect(rep.newFailures).toBe(0)
    expect(rep.replayPassable).toBe(true)
  })

  test("requireNoHiddenFailure=false: baseline-only missing case is neutral", () => {
    const m = manifest()
    const base = [1, 2].map(i => ({ caseId: `c${i}`, inputDigest: sha(`i${i}`), outcome: "passed" as const, durationMs: 1, environmentDigest: sha("e") }))
    const cand = base.slice(0, 1)
    const rep = buildDifferentialReport(
      { side: "baseline", manifestId: m.manifestId, sourceRef: "b", results: base, startedAt: "" },
      { side: "candidate", manifestId: m.manifestId, sourceRef: "c", results: cand, startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: false },
    )
    expect(rep.newFailures).toBe(0)
    expect(rep.replayPassable).toBe(true)
  })

  test("different manifests → throw", () => {
    const m = manifest()
    expect(() => buildDifferentialReport(
      { side: "baseline", manifestId: "aaaa", sourceRef: "b", results: [], startedAt: "" },
      { side: "candidate", manifestId: m.manifestId, sourceRef: "c", results: [], startedAt: "" },
      { requireZeroRegression: true, requireNoHiddenFailure: true },
    )).toThrow(/same manifest/)
  })

  test("integration: runReplay + buildDifferentialReport end-to-end", async () => {
    const m = manifest()
    const { baseline, candidate } = await runReplay({
      manifest: m,
      baselineSourceRef: "base-commit",
      candidateSourceRef: "cand-commit",
      candidateEnvironment: env(),
      executor: executorWith({
        c1: { b: "passed", c: "passed" },
        c2: { b: "passed", c: "failed" },
        c3: { b: "failed", c: "passed" },
      }),
    })
    const rep = buildDifferentialReport(baseline, candidate, { requireZeroRegression: true, requireNoHiddenFailure: true })
    expect(rep.regressions).toBe(1)
    expect(rep.improved).toBe(1)
    expect(rep.replayPassable).toBe(false)
  })
})
