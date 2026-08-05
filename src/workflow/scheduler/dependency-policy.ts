/** Conditional dependency policy (MACP-M1).
 *
 *  schemaVersion "0.1" specs keep the legacy semantic: every dependency is
 *  `terminal` (unblock on finish, success or failure). "0.2" specs may
 *  declare `when` conditions — a node only becomes ready when every
 *  dependency's result satisfies its condition; a dependency that finished
 *  without satisfying its condition blocks the dependent (fail-closed, no
 *  deadlock).
 *
 *  Execution and acceptance are separated (MACP §5.2): a done node whose
 *  output declares `metadata.acceptance` decides how `accepted` /
 *  `rejected` dependencies evaluate. Who may declare acceptance is a
 *  coordination-authority concern (MACP M7/M9); this layer only interprets
 *  the declaration.
 */

import type { WorkflowDependency, WorkflowDependencyWhen, WorkflowNodeResult, WorkflowNodeSpec } from "../types"

export const DEFAULT_DEPENDENCY_WHEN: WorkflowDependencyWhen = "terminal"

export function normalizeDependencies(
  dependsOn: Array<string | WorkflowDependency> | undefined,
  schemaVersion: string,
): WorkflowDependency[] {
  const legacy = schemaVersion !== "0.2"
  const deps: WorkflowDependency[] = []
  const seen = new Set<string>()
  for (const dep of dependsOn ?? []) {
    const normalized: WorkflowDependency = legacy
      ? { nodeId: typeof dep === "string" ? dep : dep.nodeId, when: "terminal" }
      : typeof dep === "string"
        ? { nodeId: dep, when: DEFAULT_DEPENDENCY_WHEN }
        : { nodeId: dep.nodeId, when: dep.when }
    if (seen.has(normalized.nodeId)) continue
    seen.add(normalized.nodeId)
    deps.push(normalized)
  }
  return deps
}

export function dependencyIds(deps: WorkflowDependency[]): string[] {
  return deps.map(d => d.nodeId)
}

/** The acceptance declared by a result's output (metadata.acceptance). */
export function declaredAcceptance(result: WorkflowNodeResult): string | undefined {
  const output = result.output
  if (!output || typeof output !== "object") return undefined
  const metadata = (output as { metadata?: Record<string, unknown> }).metadata
  if (!metadata || typeof metadata.acceptance !== "string") return undefined
  return metadata.acceptance
}

export type DependencyVerdict = "satisfied" | "pending" | "unsatisfied"

/** Evaluate one dependency against the dependency's result.
 *  `pending` = result not finished yet; `unsatisfied` = finished but the
 *  `when` condition did not hold (dependent must be blocked). */
export function dependencySatisfied(
  dep: WorkflowDependency,
  result: WorkflowNodeResult | undefined,
): DependencyVerdict {
  if (!result) return "pending"
  switch (dep.when) {
    case "terminal":
      return "satisfied"
    case "succeeded":
      return result.status === "done" ? "satisfied" : "unsatisfied"
    case "failed":
      return result.status === "failed" ? "satisfied" : "unsatisfied"
    case "blocked":
      return result.status === "blocked" ? "satisfied" : "unsatisfied"
    case "accepted":
      return result.status === "done" && declaredAcceptance(result) === "accepted" ? "satisfied" : "unsatisfied"
    case "rejected":
      return result.status === "done" && declaredAcceptance(result) === "rejected" ? "satisfied" : "unsatisfied"
  }
}

export interface ReadinessEvaluation {
  verdict: "executable" | "blocked" | "pending"
  /** Dependencies that finished but did not satisfy their condition. */
  unsatisfied: Array<{ nodeId: string; when: WorkflowDependencyWhen }>
}

/** Evaluate a node against finished dependency results. */
export function evaluateReadiness(
  node: WorkflowNodeSpec,
  deps: WorkflowDependency[],
  results: Map<string, WorkflowNodeResult>,
): ReadinessEvaluation {
  const unsatisfied: Array<{ nodeId: string; when: WorkflowDependencyWhen }> = []
  for (const dep of deps) {
    const verdict = dependencySatisfied(dep, results.get(dep.nodeId))
    if (verdict === "pending") return { verdict: "pending", unsatisfied }
    if (verdict === "unsatisfied") unsatisfied.push({ nodeId: dep.nodeId, when: dep.when })
  }
  return unsatisfied.length > 0 ? { verdict: "blocked", unsatisfied } : { verdict: "executable", unsatisfied }
}
