/** PR-8.3 mini benchmark — metric aggregation and regression gate (pure). */

import { describe, expect, test } from "bun:test"
import {
  aggregateBenchmarkMetrics,
  checkRegression,
  COST_PER_M,
  REGRESSION_TOLERANCE,
  type BenchmarkMetrics,
} from "../evals/mini-benchmark"
import type { RunReplayResult } from "../evals/harness/contracts"

function fakeResult(caseId: string, outcomeKind: string, inputTokens = 1000, outputTokens = 100): RunReplayResult {
  return {
    caseId,
    passed: true,
    failures: [],
    events: [],
    snapshot: {
      status: "terminal",
      outcome: { kind: outcomeKind },
      budgetState: { used: { inputTokens, outputTokens } },
      artifactRefs: [],
    },
    durationMs: 1,
    workspaceDir: "/tmp/x",
  }
}

describe("mini benchmark aggregation", () => {
  test("pass@1 counts scenario pass with matching outcome", () => {
    const metrics = aggregateBenchmarkMetrics([
      { result: fakeResult("A", "completed"), rubricPassed: true, expectedOutcome: "completed" },
      { result: fakeResult("B", "completed"), rubricPassed: false, expectedOutcome: "completed" },
      { result: fakeResult("C", "blocked"), rubricPassed: false, expectedOutcome: "blocked" },
      { result: fakeResult("D", "failed"), rubricPassed: false, expectedOutcome: "failed" },
    ])
    expect(metrics.passAt1).toBe(1)
    expect(metrics.completed).toBe(2)
    expect(metrics.blockedOrFailed).toBe(2)
  })

  test("false done: completed against a non-completed expectation", () => {
    const metrics = aggregateBenchmarkMetrics([
      { result: fakeResult("FD", "completed"), rubricPassed: false, expectedOutcome: "blocked" },
      { result: fakeResult("OK", "blocked"), rubricPassed: false, expectedOutcome: "blocked" },
    ])
    expect(metrics.falseDoneRate).toBe(1)
    expect(metrics.perCase[0]!.falseDone).toBe(true)
    expect(metrics.perCase[1]!.falseDone).toBe(false)
  })

  test("pass@1 drops when a scenario assertion fails", () => {
    const broken: RunReplayResult = { ...fakeResult("X", "completed"), passed: false }
    const metrics = aggregateBenchmarkMetrics([
      { result: fakeResult("A", "completed"), rubricPassed: true, expectedOutcome: "completed" },
      { result: broken, rubricPassed: true, expectedOutcome: "completed" },
    ])
    expect(metrics.passAt1).toBe(0.5)
  })

  test("cost is estimated from token counts", () => {
    const metrics = aggregateBenchmarkMetrics([
      { result: fakeResult("A", "completed", 1_000_000, 0), rubricPassed: true, expectedOutcome: "completed" },
    ])
    expect(metrics.estimatedCostUsd).toBeCloseTo(COST_PER_M.input, 6)
    expect(metrics.totalInputTokens).toBe(1_000_000)
  })

  test("regression gate: pass@1 drop, FDR rise and cost rise each trip", () => {
    const base: BenchmarkMetrics = {
      cases: 1, completed: 1, blockedOrFailed: 0, passAt1: 1, falseDoneRate: 0,
      totalInputTokens: 1000, totalOutputTokens: 0, estimatedCostUsd: 0.001, perCase: [],
    }
    const worse = { ...base, passAt1: base.passAt1 - REGRESSION_TOLERANCE.passAt1Drop - 0.01 }
    expect(checkRegression(worse, base).regressed).toBe(true)

    const fd = { ...base, falseDoneRate: base.falseDoneRate + REGRESSION_TOLERANCE.falseDoneRateRise + 0.01 }
    expect(checkRegression(fd, base).regressed).toBe(true)

    const costly = { ...base, estimatedCostUsd: base.estimatedCostUsd * (1 + REGRESSION_TOLERANCE.costRiseRatio + 0.01) }
    expect(checkRegression(costly, base).regressed).toBe(true)

    const same = { ...base }
    expect(checkRegression(same, base).regressed).toBe(false)
  })

  test("no baseline ⇒ no regression", () => {
    const current = aggregateBenchmarkMetrics([
      { result: fakeResult("A", "completed"), rubricPassed: true, expectedOutcome: "completed" },
    ])
    expect(checkRegression(current, null).regressed).toBe(false)
  })
})
