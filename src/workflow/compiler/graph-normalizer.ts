/** Graph normalizer (G2): stable ids, folded edges, topological output.
 *
 *  Guarantees the G2 acceptance property "same input ⇒ same graph":
 *  duplicate dependencies collapse, node order is deterministic, and the
 *  output spec passes the DAG validator.
 */

import { topologicalOrder } from "../results/edge-store"
import type { WorkflowNodeSpec, WorkflowSpec } from "../types"

export function normalizeSpec(spec: WorkflowSpec): WorkflowSpec {
  const byId = new Map<string, WorkflowNodeSpec>()
  const seenIds = new Set<string>()

  for (const node of spec.nodes) {
    if (seenIds.has(node.id)) {
      throw new Error(`workflow: duplicate node id "${node.id}"`)
    }
    seenIds.add(node.id)
    const deps: Array<import("../types").WorkflowDependency | string> = []
    const seen = new Set<string>()
    for (const dep of node.dependsOn) {
      const depId = typeof dep === "string" ? dep : dep.nodeId
      if (seen.has(depId)) continue
      seen.add(depId)
      deps.push(dep)
    }
    byId.set(node.id, { ...node, dependsOn: deps })
  }

  // Topological order (stable: Kahn's algorithm over deterministic input).
  const ordered = topologicalOrder({ ...spec, nodes: [...byId.values()] })
  const orderIndex = new Map(ordered.map((id, i) => [id, i]))
  const sorted = [...byId.values()].sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))

  return { ...spec, nodes: sorted }
}
