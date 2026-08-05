/** MACP-M6: criterion evaluator + deterministic verification compile.
 *
 *  Evaluates deterministic criteria mechanically (task 10: compile →
 *  deterministic verification nodes); semantic_review criteria NEVER
 *  auto-pass — they surface as verdicts for human adjudication (task 8).
 */

import type { CompletionCriterion } from "../contracts/criteria"
import type { VerificationResult } from "../../verification/result"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

export interface CriterionContext {
  /** Project root for relative paths. */
  cwd: string
  readFile?: (path: string) => string | undefined
  exists?: (path: string) => boolean
  runCommand?: (command: string) => Promise<{ passed: boolean; output: string }>
  /** Evidence entries available (evidenceKind matches on kind/summary). */
  evidence?: Array<{ kind: string; summary?: string }>
}

export interface CriterionVerdict {
  criterionId: string
  hard: boolean
  passed: boolean
  /** Empty when passed; reason when failed / not auto-verifiable. */
  reason?: string
  checkedAt: number
  /** True when the criterion requires human adjudication. */
  requiresReview: boolean
}

export function evaluateCriterion(criterion: CompletionCriterion, ctx: CriterionContext): Promise<CriterionVerdict> {
  const base = { criterionId: criterion.id, hard: criterion.hard, checkedAt: Date.now() }
  const check = criterion.check

  // Task 8: semantic conditions are never auto-passed.
  if (criterion.mode === "semantic" || check?.type === "semantic_review") {
    return Promise.resolve({
      ...base,
      passed: false,
      requiresReview: true,
      reason: check?.type === "semantic_review"
        ? `semantic review required: ${check.guidance}`
        : "semantic criterion requires human adjudication",
    })
  }

  return Promise.resolve().then(() => {
    switch (check?.type) {
      case "command": {
        if (!ctx.runCommand) return { ...base, passed: false, requiresReview: false, reason: "no command runner available" }
        return ctx.runCommand(check.command).then(r => ({
          ...base,
          passed: r.passed,
          requiresReview: false,
          reason: r.passed ? undefined : `command failed: ${r.output.slice(0, 200)}`,
        }))
      }
      case "file_exists": {
        const exists = ctx.exists ?? ((p: string) => existsSync(p))
        const found = exists(resolvePath(ctx.cwd, check.path))
        return { ...base, passed: found, requiresReview: false, reason: found ? undefined : `file missing: ${check.path}` }
      }
      case "file_content": {
        const read = ctx.readFile ?? ((p: string) => { try { return readFileSync(p, "utf8") } catch { return undefined } })
        const content = read(resolvePath(ctx.cwd, check.path))
        const contains = content !== undefined && content.includes(check.contains)
        return { ...base, passed: contains, requiresReview: false, reason: contains ? undefined : `${check.path} does not contain the required marker` }
      }
      case "evidence": {
        const evidence = ctx.evidence ?? []
        const hit = evidence.some(e => e.kind === check.evidenceKind)
        return { ...base, passed: hit, requiresReview: false, reason: hit ? undefined : `no passing evidence of kind "${check.evidenceKind}"` }
      }
      default:
        return { ...base, passed: false, requiresReview: false, reason: "criterion has no check" }
    }
  })
}

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p)
}

/** Task 10: compile deterministic criteria into verification results.
 *  semantic_review criteria are excluded (they are not machine-checkable). */
export function compileCriterionVerifications(criteria: CompletionCriterion[]): VerificationResult[] {
  const results: VerificationResult[] = []
  for (const criterion of criteria) {
    if (criterion.mode === "semantic" || criterion.check?.type === "semantic_review") continue
    const check = criterion.check
    if (check?.type === "command") {
      results.push({
        kind: check.verificationKind ?? "test",
        command: check.command,
        passed: false,
        issues: 0,
        durationMs: 0,
        summary: `criterion ${criterion.id}`,
      })
    }
  }
  return results
}
