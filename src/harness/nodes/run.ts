/** Sequential node runner (H11).
 *
 *  NOT a scheduler: no DAG, no edges, no parallelism, no dynamic workflows —
 *  plan §23 forbids scheduler wiring before H11 acceptance. This is the
 *  single-node helper that executes one node to completion, owning the
 *  lifecycle status events (running at start, terminal status at the end).
 *  Nodes are single-use: execute → getResult exactly once (H12 scheduler
 *  must not reuse instances).
 */

import type { HarnessNode, NodeEvent, NodeExecutionContext, NodeResult } from "../contracts/nodes"
import { createNodeEventEmitter } from "./events"

const usedNodes = new WeakSet<object>()

export async function* runNode<I, O>(
  node: HarnessNode<I, O>,
  context: NodeExecutionContext,
  input: I,
): AsyncGenerator<NodeEvent> {
  if (usedNodes.has(node)) {
    throw new Error(`node ${node.id} is single-use: execute already consumed`)
  }
  usedNodes.add(node)

  // Every yielded event is also appended to the run's trace (best-effort).
  const emitter = createNodeEventEmitter(context)
  const forward = async (event: NodeEvent): Promise<NodeEvent> => {
    await emitter.emit(event)
    return event
  }

  yield await forward({ type: "node.status", nodeRunId: context.nodeRunId, status: "running", attempt: 1 })
  try {
    for await (const event of node.execute(context, input)) {
      yield await forward(event)
    }
  } finally {
    const result = await node.getResult()
    yield await forward({ type: "node.status", nodeRunId: context.nodeRunId, status: result.status, attempt: 1 })
  }
}

/** Convenience: drain a node run and return the final NodeResult. */
export async function runNodeToResult<I, O>(
  node: HarnessNode<I, O>,
  context: NodeExecutionContext,
  input: I,
): Promise<{ events: NodeEvent[]; result: NodeResult<O> }> {
  const events: NodeEvent[] = []
  for await (const event of runNode(node, context, input)) {
    events.push(event)
  }
  return { events, result: await node.getResult() }
}
