/** LR2-6（P6-B）：DifferentialReport —— 基线 vs 候选逐 case 差异矩阵。
 *
 *  分类：通过→失败 = REGRESSION（禁止晋升）；失败→通过 = IMPROVED；
 *  失败→失败 = UNCHANGED_FAIL（按 criteria 判定是否允许）；通过→通过 =
 *  UNCHANGED_PASS；新增失败 = NEW_FAILURE（候选新增，禁止晋升）。
 */

import type { ReplayRun, ReplayCaseResult } from "./replay"

export type DiffClass = "UNCHANGED_PASS" | "REGRESSION" | "IMPROVED" | "UNCHANGED_FAIL" | "NEW_FAILURE" | "MISMATCH"

export interface CaseDiff {
  caseId: string
  baselineOutcome: ReplayCaseResult["outcome"]
  candidateOutcome: ReplayCaseResult["outcome"]
  diffClass: DiffClass
  detail?: string
}

export interface DifferentialReport {
  manifestId: string
  baselineSourceRef: string
  candidateSourceRef: string
  caseDiffs: CaseDiff[]
  /** 统计。 */
  unchangedPass: number
  regressions: number
  improved: number
  unchangedFail: number
  newFailures: number
  mismatches: number
  /** 是否可通过（不含安全/性能评估 —— 只回答重放差异维度）。 */
  replayPassable: boolean
  /** 不可通过的原因列表。 */
  blockers: string[]
}

function classify(baseline: ReplayCaseResult, candidate: ReplayCaseResult): CaseDiff {
  const passed = (o: ReplayCaseResult["outcome"]) => o === "passed"
  const diffClass: DiffClass = passed(baseline.outcome) && passed(candidate.outcome)
    ? "UNCHANGED_PASS"
    : passed(baseline.outcome) && !passed(candidate.outcome)
      ? "REGRESSION"
      : !passed(baseline.outcome) && passed(candidate.outcome)
        ? "IMPROVED"
        : !passed(baseline.outcome) && !passed(candidate.outcome)
          ? "UNCHANGED_FAIL"
          : "MISMATCH"
  return {
    caseId: baseline.caseId,
    baselineOutcome: baseline.outcome,
    candidateOutcome: candidate.outcome,
    diffClass,
    detail: !passed(candidate.outcome) ? candidate.detail : undefined,
  }
}

/** 生成差异报告。requireZeroRegression 由清单 criteria 决定（调用方传）。 */
export function buildDifferentialReport(
  baseline: ReplayRun,
  candidate: ReplayRun,
  criteria: { requireZeroRegression: boolean; requireNoHiddenFailure: boolean },
): DifferentialReport {
  if (baseline.manifestId !== candidate.manifestId) {
    throw new Error("differential report requires same manifest for both sides")
  }
  const byId = new Map(candidate.results.map(r => [r.caseId, r]))
  const caseDiffs: CaseDiff[] = []
  for (const b of baseline.results) {
    const c = byId.get(b.caseId)
    if (!c) {
      caseDiffs.push({ caseId: b.caseId, baselineOutcome: b.outcome, candidateOutcome: "skipped", diffClass: "MISMATCH" })
      continue
    }
    caseDiffs.push(classify(b, c))
  }
  const count = (cls: DiffClass) => caseDiffs.filter(d => d.diffClass === cls).length
  const regressions = count("REGRESSION")
  const newFailures = count("NEW_FAILURE")
  const unchangedFail = count("UNCHANGED_FAIL")

  const blockers: string[] = []
  if (criteria.requireZeroRegression && regressions > 0) blockers.push(`REGRESSION_PROMOTED: ${regressions} case(s) regressed`)
  if (criteria.requireNoHiddenFailure && newFailures > 0) blockers.push(`HIDDEN_FAILURE_PROMOTED: ${newFailures} new failure(s)`)
  if (count("MISMATCH") > 0) blockers.push(`case set mismatch between sides: ${count("MISMATCH")}`)

  return {
    manifestId: baseline.manifestId,
    baselineSourceRef: baseline.sourceRef,
    candidateSourceRef: candidate.sourceRef,
    caseDiffs,
    unchangedPass: count("UNCHANGED_PASS"),
    regressions,
    improved: count("IMPROVED"),
    unchangedFail,
    newFailures,
    mismatches: count("MISMATCH"),
    replayPassable: blockers.length === 0,
    blockers,
  }
}
