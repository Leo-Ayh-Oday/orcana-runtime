/** Validation entry (G2): aggregate all validators into one report. */

import type { WorkflowSpec } from "../types"
import { validateDAG, type DAGIssue } from "./dag-validator"
import { validateCapabilities, type CapabilityIssue } from "./capability-validator"
import { validateBudget, type BudgetIssue } from "./budget-validator"
import { validateSideEffects, type SideEffectIssue } from "./side-effect-validator"
import { validateSchema, type SchemaIssue } from "./schema-validator"

export type ValidationIssue =
  | DAGIssue
  | CapabilityIssue
  | BudgetIssue
  | SideEffectIssue
  | SchemaIssue

export interface ValidationReport {
  ok: boolean
  issues: ValidationIssue[]
}

export interface ValidationContext {
  knownHandlers: Set<string>
  readonlyHandlers: Set<string>
  handlerInputKind?: Record<string, "object" | "array" | "any">
}

/** Validate a spec for execution (G1 read-only / G3 read-write contract). */
export function validateSpec(spec: WorkflowSpec, ctx: ValidationContext): ValidationReport {
  const issues: ValidationIssue[] = [
    ...validateDAG(spec),
    ...validateBudget(spec.nodes.length, spec.maxParallel),
    ...validateCapabilities(spec.nodes, {
      knownHandlers: ctx.knownHandlers,
      readonlyHandlers: ctx.readonlyHandlers,
      mode: spec.mode ?? "readonly",
    }),
    ...validateSideEffects(spec.nodes, ctx.readonlyHandlers, spec.mode ?? "readonly"),
    ...validateSchema(spec.nodes, {
      handlerInputKind: ctx.handlerInputKind ?? {},
    }),
  ]
  return { ok: issues.length === 0, issues }
}

/** Convenience: throw when invalid. */
export function assertValidSpec(spec: WorkflowSpec, ctx: ValidationContext): void {
  const report = validateSpec(spec, ctx)
  if (!report.ok) {
    const detail = report.issues.map(i => i.message).join("; ")
    throw new Error(detail)
  }
}
