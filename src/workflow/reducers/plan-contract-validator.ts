/** MACP-M6: plan contract validator — planner output must pass the JSON
 *  Schema AND the semantic rules:
 *    - every criterion has a stable, unique ID (tasks 2);
 *    - semantic conditions must be `semantic_review`, never disguised as a
 *      deterministic grep-ish check (tasks 8/9, FAKE_DETERMINISTIC_CHECK);
 *    - write tasks require at least one verification criterion — a
 *      deterministic command/evidence check bound to a hard criterion
 *      (task 6, HARD_CRITERION_BYPASS: 0);
 *    - key permission/security conditions are automatically hard (task 7).
 */

import { validateJsonSchema } from "../../harness/interrupts/response-validator"
import type { JsonSchema } from "../../harness/contracts/schema"
import { TYPED_PLAN_SCHEMA, type TypedPlanContract } from "../contracts/plan-contract"
import { AUTO_SECURITY_CRITERION, CRITERION_ID_PATTERN, type CompletionCriterion } from "../contracts/criteria"

export interface PlanContractValidation {
  ok: boolean
  errors: string[]
  /** Criteria every write task inherits (auto-hard security, task 7). */
  autoCriteria: CompletionCriterion[]
}

const DETERMINISTIC_CHECK_TYPES = new Set(["command", "file_exists", "file_content", "evidence"])

/** Validate the raw planner payload: schema first (task 5), then rules. */
export function validatePlanContract(contract: unknown): PlanContractValidation {
  const errors: string[] = []

  // Task 5: JSON Schema gate (shared validator keyword subset).
  const schemaErrors = validateJsonSchema(contract, TYPED_PLAN_SCHEMA as unknown as JsonSchema)
  if (schemaErrors.length > 0) {
    return { ok: false, errors: schemaErrors.map(e => `schema: ${e}`), autoCriteria: [] }
  }
  const plan = contract as TypedPlanContract
  if (plan.schemaVersion !== "0.3") {
    return { ok: false, errors: [`schema: unsupported schemaVersion "${plan.schemaVersion}" (expected 0.3)`], autoCriteria: [] }
  }

  // Task 2: stable unique IDs.
  const ids = new Set<string>()
  for (const criterion of plan.criteria) {
    if (!criterion.id || !CRITERION_ID_PATTERN.test(criterion.id)) {
      errors.push(`criterion id invalid or missing: "${criterion.id ?? ""}" (must match ${CRITERION_ID_PATTERN})`)
    } else if (ids.has(criterion.id)) {
      errors.push(`duplicate criterion id: "${criterion.id}"`)
    }
    ids.add(criterion.id)

    // Tasks 8/9: mode ↔ check consistency (FAKE_DETERMINISTIC_CHECK: 0).
    const check = criterion.check
    if (criterion.mode === "semantic") {
      if (!check || check.type !== "semantic_review") {
        errors.push(`criterion "${criterion.id}": semantic mode requires an explicit semantic_review check`)
      }
    } else {
      if (!check || !DETERMINISTIC_CHECK_TYPES.has(check.type)) {
        errors.push(`criterion "${criterion.id}": deterministic mode requires a machine-checkable check (command/file_exists/file_content/evidence)`)
      } else if (check.type === "command" && !check.command) {
        errors.push(`criterion "${criterion.id}": command check requires a command`)
      } else if ((check.type === "file_exists" || check.type === "file_content") && !check.path) {
        errors.push(`criterion "${criterion.id}": file check requires a path`)
      } else if (check.type === "file_content" && !check.contains) {
        errors.push(`criterion "${criterion.id}": file_content check requires a contains marker`)
      } else if (check.type === "evidence" && !check.evidenceKind) {
        errors.push(`criterion "${criterion.id}": evidence check requires an evidenceKind`)
      } else if (check.type === "semantic_review" && (!check.reviewer || !check.guidance)) {
        errors.push(`criterion "${criterion.id}": semantic_review requires reviewer + guidance`)
      }
    }
  }
  if (plan.criteria.length === 0) {
    errors.push("plan requires at least one criterion")
  }

  // Task 6: write tasks must reference at least one verification criterion
  // (a deterministic command/evidence check). Task 7: security conditions
  // are auto-hard — write tasks inherit AUTO_SECURITY_CRITERION unless they
  // already reference an evidence-kind criterion.
  const autoCriteria: CompletionCriterion[] = []
  for (const task of plan.tasks) {
    if (!task.writes) continue
    const bound = task.criterionIds.map(id => plan.criteria.find(c => c.id === id))
    const verificationBound = bound.filter(c => c !== undefined).filter(c =>
      c!.mode === "deterministic" && (c!.check?.type === "command" || c!.check?.type === "evidence"),
    )
    if (verificationBound.length === 0) {
      errors.push(`write task "${task.taskId}" has no verification criterion (requires a deterministic command/evidence check)`)
    }
    if (!bound.some(c => c?.hard === true)) {
      errors.push(`write task "${task.taskId}" must be bound to at least one hard criterion`)
    }
    if (!bound.some(c => c?.check?.type === "evidence" && c.check.evidenceKind === "ownership")) {
      autoCriteria.push(AUTO_SECURITY_CRITERION)
    }
  }

  // Task 11/12: version presence (consumers reject stale versions).
  if (!plan.version || plan.version.trim().length === 0) {
    errors.push("plan version is required (any modification must produce a new version)")
  }

  return { ok: errors.length === 0, errors, autoCriteria }
}

/** Whether a plan modification (old vs new) violates version discipline. */
export function planVersionChanged(oldVersion: string | undefined, newContract: TypedPlanContract): boolean {
  return oldVersion !== undefined && oldVersion === newContract.version
}
