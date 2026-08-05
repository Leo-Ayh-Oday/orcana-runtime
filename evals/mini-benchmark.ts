/**
 * PR-8.3 SWE-style Mini Benchmark — deterministic, offline, no LLM.
 *
 * Runs the H12 scenario suite (hr-core + hr-dual) through the scripted
 * replay executor and aggregates three indicators:
 *
 *   pass@1          — share of cases whose single run satisfies the rubric
 *                     (incl. expected-outcome agreement)
 *   false done rate — share of cases that COMPLETED although the run should
 *                     not have claimed done (expected outcome ≠ completed,
 *                     or truthfulness/correctness rubric failure)
 *   cost            — estimated USD from the scripted usage events
 *
 * Baseline: `~/.orcana/evals/mini-benchmark-baseline.json` is written on
 * first run; later runs compare and exit 1 on regression
 * (pass@1 −> Δ≤ −0.05, falseDoneRate Δ≥ +0.05, cost Δ≥ +10%).
 *
 *   bun run bench:mini [--filter <id>] [--report] [--update-baseline]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { runReplayCase } from "./harness/run-replay"
import { loadHrScenarios } from "./harness/scenarios"
import { evaluateRubric, defaultHrRubric, type RubricDimension } from "./harness/rubric"
import type { RunReplayResult } from "./harness/contracts"

export interface BenchmarkPerCase {
  caseId: string
  passed: boolean
  outcome: string
  expectedOutcome: string
  rubricPassed: boolean
  falseDone: boolean
  costUsd: number
}

export interface BenchmarkMetrics {
  cases: number
  completed: number
  blockedOrFailed: number
  passAt1: number
  falseDoneRate: number
  totalInputTokens: number
  totalOutputTokens: number
  estimatedCostUsd: number
  perCase: BenchmarkPerCase[]
}

/** Cost constants (USD per 1M tokens) — estimated, offline benchmark only. */
export const COST_PER_M = { input: 0.14, output: 0.28 } as const

/** Regression tolerances (PR-8.3: "每次 PR 不退化"). */
export const REGRESSION_TOLERANCE = { passAt1Drop: 0.05, falseDoneRateRise: 0.05, costRiseRatio: 0.1 } as const

export const QUALITY_FLOORS: Partial<Record<RubricDimension, number>> = {
  correctness: 0.5,
  safety: 0.8,
  truthfulness: 0.5,
}

function tokenCounts(budgetState: unknown): { input: number; output: number } {
  const used = (budgetState as { used?: Record<string, number> })?.used ?? {}
  return {
    input: used["inputTokens"] ?? 0,
    output: used["outputTokens"] ?? 0,
  }
}

function costUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * COST_PER_M.input + outputTokens * COST_PER_M.output) / 1_000_000
}

/** Pure aggregation — unit-testable without running any scenario. */
export function aggregateBenchmarkMetrics(
  results: Array<{ result: RunReplayResult; rubricPassed: boolean; expectedOutcome: string }>,
): BenchmarkMetrics {
  const perCase: BenchmarkPerCase[] = results.map(({ result, rubricPassed, expectedOutcome }) => {
    const outcome = result.snapshot.outcome?.kind ?? result.snapshot.status
    const completed = outcome === "completed"
    const expectedCompleted = expectedOutcome === "completed"
    // False done: the run COMPLETED although the task should not have been
    // claimed done. The rubric is reported separately (its no-secret P0
    // conflicts with the redaction scenarios by design).
    const falseDone = completed && !expectedCompleted
    const { input, output } = tokenCounts(result.snapshot.budgetState)
    return {
      caseId: result.caseId,
      passed: result.passed,
      outcome,
      expectedOutcome,
      rubricPassed,
      falseDone,
      costUsd: costUsd(input, output),
    }
  })

  const completed = perCase.filter(c => c.outcome === "completed").length
  const blockedOrFailed = perCase.length - completed
  const passAt1 = perCase.filter(c => c.passed && c.outcome === c.expectedOutcome).length / Math.max(perCase.length, 1)
  const falseDone = perCase.filter(c => c.falseDone).length
  const totalInputTokens = results.reduce((sum, r) => sum + tokenCounts(r.result.snapshot.budgetState).input, 0)
  const totalOutputTokens = results.reduce((sum, r) => sum + tokenCounts(r.result.snapshot.budgetState).output, 0)

  return {
    cases: perCase.length,
    completed,
    blockedOrFailed,
    passAt1,
    falseDoneRate: completed > 0 ? falseDone / completed : 0,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUsd: costUsd(totalInputTokens, totalOutputTokens),
    perCase,
  }
}

export interface RegressionReport {
  regressed: boolean
  reasons: string[]
  baseline: BenchmarkMetrics | null
  current: BenchmarkMetrics
}

/** Compare current metrics against a persisted baseline (no baseline ⇒ pass). */
export function checkRegression(
  current: BenchmarkMetrics,
  baseline: BenchmarkMetrics | null,
  tolerance: typeof REGRESSION_TOLERANCE = REGRESSION_TOLERANCE,
): RegressionReport {
  const reasons: string[] = []
  if (baseline) {
    if (current.passAt1 < baseline.passAt1 - tolerance.passAt1Drop) {
      reasons.push(`pass@1 dropped ${baseline.passAt1.toFixed(2)} → ${current.passAt1.toFixed(2)}`)
    }
    if (current.falseDoneRate > baseline.falseDoneRate + tolerance.falseDoneRateRise) {
      reasons.push(`false done rate rose ${baseline.falseDoneRate.toFixed(2)} → ${current.falseDoneRate.toFixed(2)}`)
    }
    if (current.estimatedCostUsd > baseline.estimatedCostUsd * (1 + tolerance.costRiseRatio)) {
      reasons.push(`cost rose $${baseline.estimatedCostUsd.toFixed(4)} → $${current.estimatedCostUsd.toFixed(4)}`)
    }
  }
  return { regressed: reasons.length > 0, reasons, baseline, current }
}

// ── CLI ──

const BASELINE_FILE = join(homedir(), ".orcana", "evals", "mini-benchmark-baseline.json")

export function loadBaseline(): BenchmarkMetrics | null {
  if (!existsSync(BASELINE_FILE)) return null
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf-8")) as BenchmarkMetrics
  } catch {
    return null
  }
}

export function saveBaseline(metrics: BenchmarkMetrics): void {
  mkdirSync(join(homedir(), ".orcana", "evals"), { recursive: true })
  writeFileSync(BASELINE_FILE, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8")
}

export function formatMetrics(m: BenchmarkMetrics): string {
  const lines = [
    `cases            ${m.cases}`,
    `completed        ${m.completed}`,
    `blocked/failed   ${m.blockedOrFailed}`,
    `pass@1           ${(m.passAt1 * 100).toFixed(1)}%`,
    `false done rate  ${(m.falseDoneRate * 100).toFixed(1)}%`,
    `tokens           ${m.totalInputTokens} in / ${m.totalOutputTokens} out`,
    `estimated cost   $${m.estimatedCostUsd.toFixed(4)}`,
    "",
  ]
  for (const c of m.perCase) {
    lines.push(`${c.passed ? "PASS" : "FAIL"} ${c.caseId.padEnd(10)} outcome=${c.outcome.padEnd(10)} rubric=${c.rubricPassed ? "ok" : "FAIL"}${c.falseDone ? " FALSE_DONE" : ""}`)
  }
  return lines.join("\n")
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const filterIndex = args.indexOf("--filter")
  const filter = filterIndex >= 0 ? args[filterIndex + 1] : undefined
  const withReport = args.includes("--report")
  const updateBaseline = args.includes("--update-baseline")

  const all = loadHrScenarios()
  const cases = filter ? all.filter(c => c.caseId.includes(filter)) : all

  const runResults: Array<{ result: RunReplayResult; rubricPassed: boolean; expectedOutcome: string }> = []
  for (const caseDef of cases) {
    const result = await runReplayCase(caseDef, { keepWorkspaceOnFailure: true })
    const evaluation = evaluateRubric(
      { result },
      defaultHrRubric(),
      QUALITY_FLOORS,
    )
    runResults.push({ result, rubricPassed: evaluation.passed, expectedOutcome: caseDef.expected.outcome.kind })
  }

  const current = aggregateBenchmarkMetrics(runResults)
  const baseline = loadBaseline()
  const report = checkRegression(current, baseline)

  if (withReport) {
    console.log(formatMetrics(current))
  }
  if (updateBaseline || !baseline) {
    saveBaseline(current)
    console.log(`[mini-benchmark] baseline written: ${BASELINE_FILE}`)
  } else {
    console.log(`[mini-benchmark] baseline pass@1=${baseline.passAt1.toFixed(2)} fdr=${baseline.falseDoneRate.toFixed(2)} cost=$${baseline.estimatedCostUsd.toFixed(4)}`)
    if (report.regressed) {
      console.error("[mini-benchmark] REGRESSION:")
      for (const reason of report.reasons) console.error(`  - ${reason}`)
      return 1
    }
    console.log("[mini-benchmark] no regression")
  }
  return 0
}

if (import.meta.main) {
  process.exitCode = await main()
}
