/**
 * H12 run replay CLI (PR-level CI command).
 *
 *   bun run evals/harness/run-replay-cli.ts [--list] [--filter <id>] [--report]
 *
 * Runs the HR scenario suite through the scripted replay executor, evaluates
 * the R1 multidimensional rubric (§18.4/18.5) over every result, writes
 * per-case results to ~/.orcana/evals/replay-history/<caseId>.json and exits
 * 1 when any case fails.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { runReplaySuite } from "./run-replay"
import { loadHrScenarios } from "./scenarios"
import { evaluateRubric, defaultHrRubric, type RubricDimension } from "./rubric"

const HISTORY_DIR = join(homedir(), ".orcana", "evals", "replay-history")

/** §18.5 quality floors per dimension (weights come from defaultHrRubric). */
const QUALITY_FLOORS: Partial<Record<RubricDimension, number>> = {
  correctness: 0.5,
  safety: 0.8,
  truthfulness: 0.5,
}

const DIMENSION_ORDER: RubricDimension[] = [
  "correctness", "completeness", "safety", "truthfulness",
  "efficiency", "recovery", "scope_control", "isolation",
]

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const listOnly = args.includes("--list")
  const filterIndex = args.indexOf("--filter")
  const filter = filterIndex >= 0 ? args[filterIndex + 1] : undefined
  const withReport = args.includes("--report")

  const all = loadHrScenarios()
  const cases = filter ? all.filter((c) => c.caseId.includes(filter)) : all

  if (listOnly) {
    for (const c of cases) {
      console.log(`${c.caseId}\t${c.title ?? ""}`)
    }
    return 0
  }

  const { results, passed, failed } = await runReplaySuite(cases, { keepWorkspaceOnFailure: true })
  mkdirSync(HISTORY_DIR, { recursive: true })

  const dimensionTotals: Record<string, { score: number; max: number }> = {}
  for (const dim of DIMENSION_ORDER) dimensionTotals[dim] = { score: 0, max: 0 }
  // Per-dimension weight sums (the score is per-result; max = weight × results).
  const weightByDim: Record<string, number> = {}
  for (const check of defaultHrRubric()) {
    weightByDim[check.dimension] = (weightByDim[check.dimension] ?? 0) + check.weight
  }

  for (const result of results) {
    // R1: the rubric runs over EVERY replay result (was: scenario
    // expectations only — the multidimensional score was never reported).
    const rubric = evaluateRubric({ result }, defaultHrRubric(), QUALITY_FLOORS)
    const dims = DIMENSION_ORDER.map((d) => `${d}=${rubric.dimensionScores[d] ?? 0}`).join(" ")
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.caseId} (${result.durationMs}ms) rubric=${rubric.passed ? "ok" : "FAIL"} ${dims}`)
    if (!result.passed) {
      for (const failure of result.failures) console.log(`  ✗ ${failure}`)
    }
    for (const warning of rubric.warnings) console.log(`  ⚠ ${warning}`)
    if (rubric.p0Violations.length > 0) {
      for (const violation of rubric.p0Violations) console.log(`  ✗ ${violation}`)
    }

    // Weighted dimension aggregation for the report.
    for (const dim of DIMENSION_ORDER) {
      dimensionTotals[dim]!.score += rubric.dimensionScores[dim] ?? 0
      dimensionTotals[dim]!.max += weightByDim[dim] ?? 0
    }

    writeFileSync(
      join(HISTORY_DIR, `${result.caseId}.json`),
      JSON.stringify({ ...result, rubric }, null, 2),
    )
  }

  if (withReport) {
    const floorRows = DIMENSION_ORDER.map((dim) => {
      const t = dimensionTotals[dim]!
      const floor = QUALITY_FLOORS[dim]
      const met = t.max > 0 && floor !== undefined ? t.score / t.max >= floor : null
      return { dimension: dim, score: t.score, max: t.max, floor: floor ?? null, met }
    })
    const summary = {
      date: new Date().toISOString(),
      cases: results.length,
      passed,
      failed,
      rubric: {
        dimensions: dimensionTotals,
        floors: QUALITY_FLOORS,
      },
    }
    writeFileSync(join(HISTORY_DIR, "summary.json"), JSON.stringify(summary, null, 2))
    console.log(`\n${passed}/${results.length} passed`)
    for (const row of floorRows) {
      const mark = row.met === true ? "ok" : row.met === false ? "BELOW" : "n/a"
      console.log(`  ${mark.padEnd(5)} ${row.dimension.padEnd(14)} ${row.score}/${row.max} (floor ${row.floor ?? "-"})`)
    }
  }

  return failed === 0 ? 0 : 1
}

main().then((code) => process.exit(code))
