/** Budget validator (G2): resource bounds before scheduling. */

export interface BudgetIssue {
  code: "too_many_nodes" | "invalid_parallel"
  message: string
}

export const MAX_NODES_PER_SPEC = 200

export function validateBudget(
  nodeCount: number,
  maxParallel: number | undefined,
): BudgetIssue[] {
  const issues: BudgetIssue[] = []
  if (nodeCount > MAX_NODES_PER_SPEC) {
    issues.push({
      code: "too_many_nodes",
      message: `workflow: spec has ${nodeCount} nodes (limit ${MAX_NODES_PER_SPEC})`,
    })
  }
  if (maxParallel !== undefined && maxParallel < 1) {
    issues.push({
      code: "invalid_parallel",
      message: `workflow: maxParallel must be >= 1 (got ${maxParallel})`,
    })
  }
  return issues
}
