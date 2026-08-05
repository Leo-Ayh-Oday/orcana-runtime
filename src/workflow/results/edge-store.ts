/** Edge store (G1): dependency queries for the scheduler.
 *
 *  Pure in-memory topology over a WorkflowSpec: indegree / successors /
 *  cycle detection (DFS coloring). Used by the ready queue and the
 *  deadlock guard.
 */

import type { WorkflowSpec } from "../types"

export interface EdgeTopology {
  indegree: Map<string, number>
  successors: Map<string, string[]>
}

export function buildTopology(spec: WorkflowSpec): EdgeTopology {
  const indegree = new Map<string, number>()
  const successors = new Map<string, string[]>()
  const nodeIds = new Set(spec.nodes.map(n => n.id))

  for (const node of spec.nodes) {
    indegree.set(node.id, 0)
    successors.set(node.id, [])
  }
  for (const node of spec.nodes) {
    const seen = new Set<string>()
    for (const dep of node.dependsOn) {
      const depId = typeof dep === "string" ? dep : dep.nodeId
      if (!nodeIds.has(depId)) throw new Error(`workflow: node "${node.id}" depends on unknown node "${depId}"`)
      if (seen.has(depId)) continue // duplicate edges collapse
      seen.add(depId)
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1)
      successors.get(depId)?.push(node.id)
    }
  }
  return { indegree, successors }
}

/** Detect a dependency cycle; returns the cycle path or null when acyclic. */
export function detectCycle(spec: WorkflowSpec): string[] | null {
  const color = new Map<string, 0 | 1 | 2>() // 0=unvisited 1=in-stack 2=done
  const stack: string[] = []
  const { successors } = buildTopology(spec)

  const visit = (id: string): string[] | null => {
    color.set(id, 1)
    stack.push(id)
    for (const next of successors.get(id) ?? []) {
      const c = color.get(next) ?? 0
      if (c === 0) {
        const found = visit(next)
        if (found) return found
      } else if (c === 1) {
        const start = stack.indexOf(next)
        return [...stack.slice(start), next]
      }
    }
    stack.pop()
    color.set(id, 2)
    return null
  }

  for (const node of spec.nodes) {
    if ((color.get(node.id) ?? 0) === 0) {
      const found = visit(node.id)
      if (found) return found
    }
  }
  return null
}

/** Topologically ordered node ids (throws on cycles). */
export function topologicalOrder(spec: WorkflowSpec): string[] {
  const { indegree, successors } = buildTopology(spec)
  const order: string[] = []
  const queue = spec.nodes.map(n => n.id).filter(id => (indegree.get(id) ?? 0) === 0)
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of successors.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1
      indegree.set(next, deg)
      if (deg === 0) queue.push(next)
    }
  }
  if (order.length !== spec.nodes.length) {
    const cycle = detectCycle(spec)
    throw new Error(`workflow: cycle detected: ${cycle?.join(" → ") ?? "unknown"}`)
  }
  return order
}
