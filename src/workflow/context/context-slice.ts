/** Context slice (G5): the minimal context a node executes with.
 *
 *  Makes the scheduler's implicit dependency semantics explicit: a node's
 *  context is its own input plus the outputs of its *direct* dependencies —
 *  unrelated history, sibling nodes and transitive noise never enter the
 *  slice (PR-G5: "nodes do not inherit unrelated history").
 */

import type { WorkflowNodeSpec, WorkflowNodeResult, WorkflowNodeResultStatus } from "../types"

export interface DependencySlice {
  nodeId: string
  status: WorkflowNodeResultStatus
  output: unknown
}

export interface ContextSlice {
  nodeId: string
  input: Record<string, unknown>
  dependencies: DependencySlice[]
}

/** Build the execution context for a node from the run's results.
 *
 *  Only direct dependencies (node.dependsOn) that have a result are
 *  included; any other node — including siblings and transitive
 *  dependencies — is excluded. Dependency failures are still surfaced
 *  (the scheduler does not run a node whose dependency failed). */
export function buildContextSlice(node: WorkflowNodeSpec, results: WorkflowNodeResult[]): ContextSlice {
  const byId = new Map(results.map(r => [r.nodeId, r]))
  const dependencies: DependencySlice[] = []
  for (const dep of node.dependsOn ?? []) {
    const depId = typeof dep === "string" ? dep : dep.nodeId
    const result = byId.get(depId)
    if (!result) continue
    dependencies.push({
      nodeId: depId,
      status: result.status,
      output: result.output,
    })
  }
  return { nodeId: node.id, input: node.input, dependencies }
}

/** The set of dependency node ids a node context is built from. */
export function sliceDependencyIds(node: WorkflowNodeSpec): string[] {
  return (node.dependsOn ?? []).map(dep => (typeof dep === "string" ? dep : dep.nodeId))
}
