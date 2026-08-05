/** Transaction executor (G3): write-node execution under the write lock.
 *
 *  Write handlers run through the existing Tool Runtime transaction chain
 *  (apply_patch = dry-run validation → atomic commit → auto-rollback;
 *  run_targeted_verification = verification producer; run_process =
 *  parameterized, shell-free commands). The executor enforces the
 *  WorkspaceWriteLock: without an acquired handle the node is rejected.
 */

import type { ContractToolDescriptor } from "../../tools/registry"
import type { WorkflowNodeResult } from "../types"
import type { WriteLockHandle } from "../scheduler/concurrency-controller"

const MAX_OUTPUT_CHARS = 200_000
const MAX_ERROR_CHARS = 500

/** Write-handler whitelist for read-write specs (G3 §7.3). */
export const WRITE_HANDLERS = new Set([
  "tool.apply_patch",
  "tool.run_process",
  "tool.run_targeted_verification",
])

export async function runWriteNode(
  nodeId: string,
  tool: ContractToolDescriptor,
  input: Record<string, unknown>,
  lock: WriteLockHandle,
): Promise<WorkflowNodeResult> {
  const startedAt = Date.now()
  if (tool.defn.isReadonly === true) {
    lock.release()
    return fail(nodeId, startedAt, `workflow: read-only tool "${tool.defn.name}" cannot run as a write node`)
  }
  try {
    const result = await tool.execute(input)
    if (!result.success) {
      return fail(nodeId, startedAt, result.error ?? result.content ?? `tool ${tool.defn.name} failed`)
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
  } finally {
    lock.release()
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
