/** DAG validator (G2): unknown dependencies + cycles.
 *
 *  Reuses the G1 edge-store topology primitives; adds unknown-dependency
 *  and duplicate-consistency checks so a spec is validated before any node
 *  can run.
 */

import { detectCycle } from "../results/edge-store"
import type { WorkflowSpec } from "../types"

export interface DAGIssue {
  code: "unknown_dependency" | "cycle" | "empty_spec" | "duplicate_node_id"
  message: string
}

export function validateDAG(spec: WorkflowSpec): DAGIssue[] {
  const issues: DAGIssue[] = []
  if (spec.nodes.length === 0) {
    issues.push({ code: "empty_spec", message: "workflow: spec has no nodes" })
    return issues
  }
  // M8: duplicate node ids must fail validation before anything runs — the
  // id-keyed topology maps would silently overwrite (last-writer-wins).
  const seen = new Set<string>()
  for (const node of spec.nodes) {
    if (seen.has(node.id)) {
      issues.push({ code: "duplicate_node_id", message: `workflow: duplicate node id "${node.id}"` })
    }
    seen.add(node.id)
  }
  const ids = new Set(spec.nodes.map(n => n.id))
  let hasUnknown = false
  for (const node of spec.nodes) {
    for (const dep of node.dependsOn) {
      const depId = typeof dep === "string" ? dep : dep.nodeId
      if (!ids.has(depId)) {
        hasUnknown = true
        issues.push({
          code: "unknown_dependency",
          message: `workflow: node "${node.id}" depends on unknown node "${depId}"`,
        })
      }
    }
  }
  if (hasUnknown) return issues // cycle check needs a closed graph
  const cycle = detectCycle(spec)
  if (cycle) {
    issues.push({ code: "cycle", message: `workflow: cycle detected: ${cycle.join(" → ")}` })
  }
  return issues
}
