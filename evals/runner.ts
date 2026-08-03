/** Eval runner — batch execution + metric aggregation + regression detection. */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { execSync } from "node:child_process"
import type {
  EvalScenario, EvalMetrics, EvalRun, EvalCheck,
} from "./scenarios"
import { classifyFailure, estimateCost } from "./scenarios"

// ── Storage paths ──

const EVAL_DIR = join(homedir(), ".orcana", "evals")
const BASELINE_FILE = join(EVAL_DIR, "baseline.json")
const HISTORY_DIR = join(EVAL_DIR, "history")

function ensureDirs() {
  mkdirSync(EVAL_DIR, { recursive: true })
  mkdirSync(HISTORY_DIR, { recursive: true })
}

// ── Check execution ──

function runCheck(check: EvalCheck, cwd: string): { passed: boolean; detail: string } {
  const absTarget = typeof check.target === "string" ? resolve(cwd, check.target) : check.target

  try {
    switch (check.kind) {
      case "file_exists":
        return {
          passed: existsSync(absTarget),
          detail: existsSync(absTarget) ? `File exists: ${check.target}` : `File missing: ${check.target}`,
        }

      case "file_contains": {
        if (!existsSync(absTarget)) {
          // Try searching across project files
          try {
            const result = execSync(`grep -r "${check.target.replace(/\\\\/g, "\\\\")}" "${cwd}/src" --include="*.ts" --include="*.tsx" 2>nul || echo ""`, { encoding: "utf-8", timeout: 5000, cwd })
            const count = result.trim().split("\n").filter(Boolean).length
            const minCount = check.minCount ?? 1
            return {
              passed: (minCount === 0 && count === 0) || count >= minCount,
              detail: `Pattern "${check.target}" found ${count} time(s) (need ${minCount})`,
            }
          } catch {
            return { passed: false, detail: `File not found and grep failed: ${check.target}` }
          }
        }
        const content = readFileSync(absTarget, "utf-8")
        const regex = new RegExp(check.target, "gm")
        const matches = content.match(regex)
        const count = matches?.length ?? 0
        const minCount = check.minCount ?? 1
        return {
          passed: (minCount === 0 && count === 0) || count >= minCount,
          detail: `Pattern "${check.target}" found ${count} time(s) (need ${minCount})`,
        }
      }

      case "test_passes": {
        const result = execSync(check.target, {
          encoding: "utf-8",
          timeout: 60000,
          cwd,
          stdio: "pipe",
        })
        return { passed: true, detail: "Test command passed" }
      }

      case "typecheck_passes": {
        try {
          execSync(check.target, {
            encoding: "utf-8",
            timeout: 30000,
            cwd,
            stdio: "pipe",
          })
          return { passed: true, detail: "Typecheck passed" }
        } catch (e) {
          const stderr = (e as { stderr?: Buffer })?.stderr?.toString() ?? ""
          const issues = stderr.split("\n").filter(l => l.includes("error TS")).length
          return { passed: false, detail: `Typecheck failed: ${issues} TS errors` }
        }
      }

      case "build_passes": {
        try {
          execSync(check.target, {
            encoding: "utf-8",
            timeout: 120000,
            cwd,
            stdio: "pipe",
          })
          return { passed: true, detail: "Build passed" }
        } catch (e) {
          return { passed: false, detail: "Build failed" }
        }
      }

      default:
        return { passed: false, detail: `Unknown check kind: ${(check as { kind: string }).kind}` }
    }
  } catch (e) {
    return { passed: false, detail: `Check error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── Quality scoring ──

function scoreQuality(checks: Array<{ passed: boolean }>): {
  correctness: number
  completeness: number
  codeQuality: number
  overall: number
} {
  const total = checks.length
  if (total === 0) return { correctness: 0, completeness: 0, codeQuality: 0, overall: 0 }
  const passed = checks.filter(c => c.passed).length
  const rate = passed / total
  return {
    correctness: rate,
    completeness: rate,
    codeQuality: rate >= 0.8 ? 0.7 : 0.4,
    overall: rate,
  }
}

// ── Baseline management ──

export interface Baseline {
  updatedAt: number
  commitHash: string
  results: Array<{
    scenarioId: string
    passed: boolean
    qualityOverall: number
    totalTokens: number
    totalMs: number
  }>
}

export function loadBaseline(): Baseline | null {
  ensureDirs()
  if (!existsSync(BASELINE_FILE)) return null
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf-8")) as Baseline
  } catch {
    return null
  }
}

export function saveBaseline(run: EvalRun): void {
  ensureDirs()
  let commitHash = ""
  try {
    commitHash = execSync("git rev-parse --short HEAD", { encoding: "utf-8", timeout: 5000 }).trim()
  } catch { /* not a git repo */ }

  const baseline: Baseline = {
    updatedAt: Date.now(),
    commitHash,
    results: run.results.map(r => ({
      scenarioId: r.scenarioId,
      passed: r.passed,
      qualityOverall: r.quality.overall,
      totalTokens: r.cost.totalTokens,
      totalMs: r.timing.totalMs,
    })),
  }
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2), "utf-8")
}

export function checkRegression(current: EvalRun, baseline: Baseline): Array<{
  scenarioId: string
  baselinePassed: boolean
  currentPassed: boolean
  severity: "REGRESSION" | "IMPROVEMENT" | "STABLE"
  detail: string
}> {
  const results: ReturnType<typeof checkRegression> = []
  const baselineMap = new Map(baseline.results.map(r => [r.scenarioId, r]))

  for (const cur of current.results) {
    const base = baselineMap.get(cur.scenarioId)
    if (!base) {
      results.push({
        scenarioId: cur.scenarioId,
        baselinePassed: false,
        currentPassed: cur.passed,
        severity: "STABLE",
        detail: "New scenario — no baseline",
      })
      continue
    }

    if (base.passed && !cur.passed) {
      results.push({
        scenarioId: cur.scenarioId,
        baselinePassed: true,
        currentPassed: false,
        severity: "REGRESSION",
        detail: `Was passing, now failing (quality: ${base.qualityOverall} → ${cur.quality.overall})`,
      })
    } else if (!base.passed && cur.passed) {
      results.push({
        scenarioId: cur.scenarioId,
        baselinePassed: false,
        currentPassed: true,
        severity: "IMPROVEMENT",
        detail: `Was failing, now passing`,
      })
    } else {
      results.push({
        scenarioId: cur.scenarioId,
        baselinePassed: base.passed,
        currentPassed: cur.passed,
        severity: "STABLE",
        detail: `No change (quality: ${base.qualityOverall} → ${cur.quality.overall})`,
      })
    }
  }

  return results
}

// ── Main runner ──

export interface RunnerOptions {
  /** Specific scenario IDs to run (default: all) */
  filter?: string[]
  /** Working directory (default: cwd) */
  cwd?: string
  /** Save baseline after run */
  saveBaseline?: boolean
  /** Check regression against saved baseline */
  checkRegression?: boolean
}

export async function runEval(
  scenarios: EvalScenario[],
  opts: RunnerOptions = {},
): Promise<EvalRun> {
  ensureDirs()
  const cwd = opts.cwd ?? process.cwd()
  const toRun = opts.filter
    ? scenarios.filter(s => opts.filter!.includes(s.id))
    : scenarios

  const run: EvalRun = {
    id: `eval-${Date.now().toString(36)}`,
    timestamp: Date.now(),
    scenarios: toRun,
    results: [],
    summary: { total: toRun.length, passed: 0, failed: 0, passRate: 0, avgTokens: 0, avgMs: 0 },
  }

  for (const scenario of toRun) {
    const startMs = Date.now()
    const result: EvalMetrics = {
      scenarioId: scenario.id,
      passed: false,
      checkResults: [],
      quality: { correctness: 0, completeness: 0, codeQuality: 0, overall: 0 },
      cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, estimatedCost: 0 },
      timing: { totalMs: 0, rounds: 0, avgRoundMs: 0 },
    }

    const scenarioCwd = scenario.cwd ? resolve(cwd, scenario.cwd) : cwd

    // ── Setup ──
    if (scenario.setup) {
      for (const cmd of scenario.setup) {
        try {
          execSync(cmd, { cwd: scenarioCwd, timeout: 30000, stdio: "pipe" })
        } catch { /* setup is best-effort */ }
      }
    }

    // ── Run checks (offline — no real agent loop, just verify current state) ──
    for (const check of scenario.rubric.checks) {
      const checkResult = runCheck(check, scenarioCwd)
      result.checkResults.push({
        id: check.id,
        passed: checkResult.passed,
        detail: checkResult.detail,
      })
    }

    result.passed = result.checkResults.every(c => c.passed)
    result.quality = scoreQuality(result.checkResults)
    if (!result.passed) {
      result.failure = classifyFailure(result)
    }

    result.timing.totalMs = Date.now() - startMs
    run.results.push(result)

    if (result.passed) run.summary.passed++
    else run.summary.failed++
  }

  run.summary.passRate = run.summary.total > 0
    ? Math.round((run.summary.passed / run.summary.total) * 100)
    : 0

  if (run.results.length > 0) {
    run.summary.avgTokens = Math.round(
      run.results.reduce((s, r) => s + r.cost.totalTokens, 0) / run.results.length
    )
    run.summary.avgMs = Math.round(
      run.results.reduce((s, r) => s + r.timing.totalMs, 0) / run.results.length
    )
  }

  // ── Save run to history ──
  const historyPath = join(HISTORY_DIR, `${run.id}.json`)
  writeFileSync(historyPath, JSON.stringify(run, null, 2), "utf-8")

  // ── Regression check ──
  if (opts.checkRegression) {
    const baseline = loadBaseline()
    if (baseline) {
      const regressions = checkRegression(run, baseline)
      const regressed = regressions.filter(r => r.severity === "REGRESSION")
      if (regressed.length > 0) {
        console.warn(`\nREGRESSION DETECTED in ${regressed.length} scenario(s):`)
        for (const r of regressed) console.warn(`  ${r.scenarioId}: ${r.detail}`)
      } else {
        console.log("No regressions detected.")
      }
    }
  }

  // ── Save baseline ──
  if (opts.saveBaseline) {
    saveBaseline(run)
    console.log(`Baseline saved: ${run.summary.passed}/${run.summary.total} passed`)
  }

  return run
}

/** Format a run summary for CLI output. */
export function formatEvalSummary(run: EvalRun): string {
  const lines: string[] = [
    `\n═══ Eval Run: ${run.id} ═══`,
    `Scenarios: ${run.summary.total} | Passed: ${run.summary.passed} | Failed: ${run.summary.failed} | Rate: ${run.summary.passRate}%`,
    `Avg tokens: ${run.summary.avgTokens.toLocaleString()} | Avg time: ${(run.summary.avgMs / 1000).toFixed(1)}s`,
    "",
  ]

  for (const result of run.results) {
    const icon = result.passed ? "PASS" : "FAIL"
    const scenario = run.scenarios.find(s => s.id === result.scenarioId)
    lines.push(`  ${icon} ${result.scenarioId}: ${scenario?.name ?? "?"}`)
    lines.push(`       quality=${result.quality.overall.toFixed(2)} checks=${result.checkResults.filter(c => c.passed).length}/${result.checkResults.length}`)
    if (result.failure) {
      lines.push(`       failure: ${result.failure.type} — ${result.failure.detail}`)
    }
  }

  return lines.join("\n")
}

/** Run offline checks only (no agent loop). Suitable for CI. */
export function evalCurrentState(scenarios: EvalScenario[], cwd?: string): EvalRun {
  ensureDirs()
  const root = cwd ?? process.cwd()
  const run: EvalRun = {
    id: `eval-offline-${Date.now().toString(36)}`,
    timestamp: Date.now(),
    scenarios,
    results: [],
    summary: { total: scenarios.length, passed: 0, failed: 0, passRate: 0, avgTokens: 0, avgMs: 0 },
  }

  for (const scenario of scenarios) {
    const startMs = Date.now()
    const scenarioCwd = scenario.cwd ? resolve(root, scenario.cwd) : root
    const checkResults = scenario.rubric.checks.map(check => {
      const result = runCheck(check, scenarioCwd)
      return { id: check.id, passed: result.passed, detail: result.detail }
    })
    const passed = checkResults.every(c => c.passed)
    const quality = scoreQuality(checkResults)

    run.results.push({
      scenarioId: scenario.id,
      passed,
      checkResults,
      quality,
      cost: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, estimatedCost: 0 },
      timing: { totalMs: Date.now() - startMs, rounds: 0, avgRoundMs: 0 },
      ...(passed ? {} : { failure: classifyFailure({ checkResults }) }),
    })
    if (passed) run.summary.passed++
    else run.summary.failed++
  }

  run.summary.passRate = run.summary.total > 0
    ? Math.round((run.summary.passed / run.summary.total) * 100)
    : 0

  return run
}
