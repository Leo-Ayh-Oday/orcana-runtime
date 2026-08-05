/** MACP-M2: harness node executor — one workflow node run through H11.
 *
 *  Wraps the sequential H11 runner (runNodeToResult) for scheduler use:
 *  builds the NodeExecutionContext (per-node nodeRunId over the run's
 *  shared scope + ledger), executes, and adapts the NodeResult back into a
 *  WorkflowNodeResult (evidence/diagnostics/usage preserved). Cancellation
 *  flows from the run scope's RunCancellation — a running node observes the
 *  abort signal (ToolNode abortSignal / HumanNode throwIfCancelled /
 *  LlmAgentNode loop signal) and terminates with a structured result.
 */

import type { WorkflowNodeSpec, WorkflowNodeResult } from "../types"
import type { WorkflowHarnessRuntime } from "../harness/node-context-factory"
import { createWorkflowNodeContext } from "../harness/node-context-factory"
import { buildHarnessNode, harnessInputFor } from "../harness/workflow-node-adapter"
import { adaptNodeResult } from "../harness/node-result-adapter"
import { runNodeToResult } from "../../harness/nodes/run"
import type { ResultStore } from "../results/result-store"

export async function executeHarnessNode(
  node: WorkflowNodeSpec,
  runtime: WorkflowHarnessRuntime,
  store: ResultStore,
  projectRootOverride?: string,
): Promise<WorkflowNodeResult> {
  const startedAt = Date.now()
  try {
    const harnessNode = buildHarnessNode(node, runtime.environment)
    const context = createWorkflowNodeContext(runtime, node.id, projectRootOverride)
    const input = harnessInputFor(node)
    const { result } = await runNodeToResult(harnessNode, context, input)
    const adapted = adaptNodeResult(result, { nodeId: node.id, startedAt })
    store.put(adapted)
    return adapted
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const result: WorkflowNodeResult = {
      nodeId: node.id,
      status: "failed",
      output: null,
      error: message,
      errorKind: "harness_execution_error",
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    }
    store.put(result)
    return result
  }
}
