/** Ready queue (G1 + MACP-M1): topological scheduling state.
 *
 *  G1: tracks indegree per node; a node is ready when its indegree is 0 AND
 *  it has no unfinished result in the store (checkpoint restore support).
 *
 *  M1: conditional dependencies — a node enters the ready list only when
 *  every dependency has a FINISHED result; whether the results *satisfy*
 *  the `when` conditions is decided by the scheduler via
 *  evaluateReadiness (satisfied → run, unsatisfied → blocked).
 */

import type { WorkflowSpec, WorkflowNodeSpec, WorkflowDependency } from "../types"
import { buildTopology } from "../results/edge-store"
import { normalizeDependencies } from "./dependency-policy"
import type { ResultStore } from "../results/result-store"

export class ReadyQueue {
  private readonly remaining = new Map<string, number>()
  private readonly byId = new Map<string, WorkflowNodeSpec>()
  private readonly depsOf = new Map<string, WorkflowDependency[]>()
  private readonly ready: string[] = []

  constructor(spec: WorkflowSpec, store: ResultStore) {
    const { indegree } = buildTopology(spec)
    for (const node of spec.nodes) {
      this.byId.set(node.id, node)
      this.depsOf.set(node.id, normalizeDependencies(node.dependsOn, spec.schemaVersion))
      this.remaining.set(node.id, indegree.get(node.id) ?? 0)
    }
    for (const node of spec.nodes) {
      // Restored results count as finished dependencies; a restored node
      // itself is never re-executed (skipped at scheduler level).
      if (store.has(node.id)) {
        this.remaining.set(node.id, -1)
      } else if ((this.remaining.get(node.id) ?? 0) === 0) {
        this.ready.push(node.id)
      }
    }
  }

  depsOfNode(id: string): WorkflowDependency[] {
    return this.depsOf.get(id) ?? []
  }

  nodeOf(id: string): WorkflowNodeSpec | undefined {
    return this.byId.get(id)
  }

  next(): WorkflowNodeSpec | undefined {
    const id = this.ready.shift()
    if (!id) return undefined
    return this.byId.get(id)
  }

  /** Called after a dependency finishes: decrement indegree, enqueue when 0. */
  onDependencyDone(depId: string): void {
    for (const node of this.byId.values()) {
      if (this.remaining.get(node.id) === -1) continue // done/restored
      if (this.depsOf.get(node.id)?.some(d => d.nodeId === depId)) {
        const deg = (this.remaining.get(node.id) ?? 0) - 1
        this.remaining.set(node.id, deg)
        if (deg === 0) this.ready.push(node.id)
      }
    }
  }

  /** A restored node's dependents also need their indegree decremented. */
  restoreDependents(depId: string): void {
    this.onDependencyDone(depId)
  }

  /** Nodes already marked finished (restored or consumed by next()). */
  get consumedCount(): number {
    let count = 0
    for (const v of this.remaining.values()) if (v === -1) count++
    return count
  }

  get hasReady(): boolean {
    return this.ready.length > 0
  }
}
