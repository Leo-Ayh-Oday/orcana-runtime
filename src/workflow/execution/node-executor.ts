/** Node executor (G1): single-node state machine.
 *
 *  pending → running → done | failed. The result is written to the
 *  ResultStore immediately on completion (incremental checkpoint).
 */

import type { WorkflowNodeSpec, WorkflowNodeResult } from "../types"
import type { HandlerRegistry } from "./handler-registry"
import type { ResultStore } from "../results/result-store"

export async function executeNode(
  node: WorkflowNodeSpec,
  registry: HandlerRegistry,
  store: ResultStore,
): Promise<WorkflowNodeResult> {
  const startedAt = Date.now()
  const handler = registry.get(node.handler)
  if (!handler) {
    const result: WorkflowNodeResult = {
      nodeId: node.id,
      status: "failed",
      output: null,
      error: `workflow: unknown handler "${node.handler}"`,
      startedAt,
      finishedAt: Date.now(),
      durationMs: 0,
    }
    store.put(result)
    return result
  }
  try {
    const output = await handler.run(node.input)
    const result: WorkflowNodeResult = {
      nodeId: node.id,
      status: "done",
      output,
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    }
    store.put(result)
    return result
  } catch (error) {
    const result: WorkflowNodeResult = {
      nodeId: node.id,
      status: "failed",
      output: null,
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    }
    store.put(result)
    return result
  }
}
