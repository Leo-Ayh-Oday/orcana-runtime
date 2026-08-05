/** Scheduler (G1): parallel read-only DAG execution.
 *
 *  Semantics (plan G1 §4.4):
 *    - ready queue (indegree 0) → bounded concurrency pool;
 *    - failure isolation: a failed node keeps its result, its dependents
 *      still run (the edge passes the failed result through);
 *    - deadlock guard: no ready + no running + still pending ⇒ dependency
 *      cycle ⇒ rejected (the spec is also cycle-checked up front);
 *    - incremental checkpoint: every finished node lands in the ResultStore
 *      immediately; restore() skips finished nodes.
 *
 *  Write tools can never reach this path: handler registration rejects them
 *  and the tool executor re-verifies isReadonly per call.
 */

import type { WorkflowRunResult, WorkflowSpec } from "../types"
import { detectCycle } from "../results/edge-store"
import { ResultStore } from "../results/result-store"
import { ReadyQueue } from "./ready-queue"
import type { HandlerRegistry } from "../execution/handler-registry"
import { executeNode } from "../execution/node-executor"

export interface SchedulerOptions {
  maxParallel?: number
  checkpointDir?: string
  onNodeFinished?: (result: import("../types").WorkflowNodeResult) => void
}

export async function runScheduler(
  spec: WorkflowSpec,
  registry: HandlerRegistry,
  options: SchedulerOptions = {},
): Promise<WorkflowRunResult> {
  const maxParallel = options.maxParallel ?? spec.maxParallel ?? 4
  if (maxParallel < 1) throw new Error("workflow: maxParallel must be >= 1")

  const cycle = detectCycle(spec)
  if (cycle) throw new Error(`workflow: cycle detected: ${cycle.join(" → ")}`)

  const store = new ResultStore(spec.specId, options.checkpointDir)
  const queue = new ReadyQueue(spec, store)

  const running = new Map<string, Promise<void>>()
  const finished = new Set<string>(spec.nodes.filter(n => store.has(n.id)).map(n => n.id))

  const launch = (node: import("../types").WorkflowNodeSpec): void => {
    const promise = executeNode(node, registry, store).then(result => {
      running.delete(node.id)
      finished.add(node.id)
      queue.onDependencyDone(node.id)
      options.onNodeFinished?.(result)
    })
    running.set(node.id, promise)
  }

  while (true) {
    // Fill concurrency slots.
    while (running.size < maxParallel && queue.hasReady) {
      const node = queue.next()
      if (!node) break
      if (store.has(node.id)) {
        // Restored checkpoint result: count as finished dependency, never re-run.
        queue.onDependencyDone(node.id)
        continue
      }
      launch(node)
    }
    if (finished.size === spec.nodes.length) break
    if (running.size === 0) {
      // Nothing running and nothing ready but work remains ⇒ deadlock.
      const blocked = spec.nodes.filter(n => !finished.has(n.id)).map(n => n.id)
      throw new Error(`workflow: deadlock — no ready node while ${blocked.length} pending (${blocked.join(", ")})`)
    }
    await Promise.race([...running.values()])
  }

  return {
    specId: spec.specId,
    finishedAt: Date.now(),
    results: store.all(),
  }
}
