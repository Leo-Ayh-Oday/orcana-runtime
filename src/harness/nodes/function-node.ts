/** FunctionNode (H11) — a deterministic handler wrapped as a node.
 *
 *  Cancellation is checked before the handler runs; the handler result is
 *  emitted as node.output and returned from getResult. Exceptions become
 *  node.error with a typed NodeRunError (HarnessError.kind when available).
 */

import type { HarnessNode, NodeEvent, NodeExecutionContext, NodeResult, NodeUsage } from "../contracts/nodes"
import { HarnessError } from "../contracts/errors"

export interface FunctionNodeOptions<I, O> {
  id: string
  handler: (input: I, context: NodeExecutionContext) => O | Promise<O>
}

export function createFunctionNode<I, O>(options: FunctionNodeOptions<I, O>): HarnessNode<I, O> {
  let result: NodeResult<O> | null = null

  return {
    id: options.id,
    kind: "function",

    async *execute(context: NodeExecutionContext, input: I): AsyncGenerator<NodeEvent> {
      try {
        context.cancellation.throwIfCancelled()
        const output = await options.handler(input, context)
        result = { status: "succeeded", output, evidence: [], diagnostics: [], usage: zeroUsage() }
        yield { type: "node.output", nodeRunId: context.nodeRunId, output }
      } catch (error) {
        const nodeError = toNodeError(error)
        result = {
          status: "failed",
          evidence: [],
          diagnostics: [{ code: "node_execution_error", message: nodeError.message, severity: "error", source: options.id }],
          usage: zeroUsage(),
          error: nodeError,
        }
        yield { type: "node.error", nodeRunId: context.nodeRunId, error: nodeError }
      }
    },

    async getResult(): Promise<NodeResult<O>> {
      if (!result) throw new Error(`node ${options.id} getResult called before execute`)
      return result
    },
  }
}

function zeroUsage(): NodeUsage {
  return { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheMissTokens: 0, wallTimeMs: 0 }
}

function toNodeError(error: unknown): { kind: string; message: string; retryable: boolean; cause?: unknown } {
  if (error instanceof HarnessError) {
    return { kind: error.kind, message: error.message, retryable: false, cause: error }
  }
  if (error instanceof Error) {
    return { kind: "node_execution_error", message: error.message, retryable: false, cause: error }
  }
  return { kind: "node_execution_error", message: String(error), retryable: false, cause: error }
}
