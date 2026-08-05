/** Tool executor (G1): read-only bridge into the Tool Runtime.
 *
 *  Every call re-verifies the descriptor is read-only before executing
 *  (fail-closed second layer on top of the handler registry whitelist) and
 *  runs through the tool's own preflight (validation, confirmation policy,
 *  freshness) via descriptor.execute().
 *
 *  Output is bounded: the stored node output keeps the result content up to
 *  MAX_OUTPUT_CHARS and never stores the raw value beyond it.
 */

import type { ContractToolDescriptor } from "../../tools/registry"
import type { WorkflowNodeResult } from "../types"

const MAX_OUTPUT_CHARS = 200_000
const MAX_ERROR_CHARS = 500

export async function runReadonlyTool(
  nodeId: string,
  tool: ContractToolDescriptor,
  input: Record<string, unknown>,
): Promise<WorkflowNodeResult> {
  const startedAt = Date.now()
  if (tool.defn.isReadonly !== true) {
    return fail(nodeId, startedAt, `workflow: write tool "${tool.defn.name}" blocked (read-only scheduler)`)
  }
  try {
    const result = await tool.execute(input)
    if (!result.success) {
      const message = result.error ?? result.content
      return fail(nodeId, startedAt, String(message).slice(0, MAX_ERROR_CHARS))
    }
    const output = {
      content: String(result.content).slice(0, MAX_OUTPUT_CHARS),
      metadata: result.metadata ?? {},
    }
    return {
      nodeId,
      status: "done",
      output,
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    return fail(nodeId, startedAt, error instanceof Error ? error.message : String(error))
  }
}

function fail(nodeId: string, startedAt: number, message: string): WorkflowNodeResult {
  return {
    nodeId,
    status: "failed",
    output: null,
    error: message.slice(0, MAX_ERROR_CHARS),
    startedAt,
    finishedAt: Date.now(),
    durationMs: Date.now() - startedAt,
  }
}
