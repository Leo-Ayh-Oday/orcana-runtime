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
import { WorkflowInterruptError, type WorkflowInterruptRecord } from "../interrupts/types"

/** M4: H11 interrupt kinds → workflow interrupt kinds. */
function humanInterruptKind(node: WorkflowNodeSpec): WorkflowInterruptRecord["kind"] {
  const kind = (node.input as { kind?: string }).kind
  switch (kind) {
    case "plan_approval":
      return "approval"
    case "clarification":
      return "user_input"
    default:
      return "approval"
  }
}

export interface HarnessInterruptRuntime {
  /** ResumeController for persisting the waiting record. */
  controller: import("../interrupts/resume-controller").ResumeController
  specId: string
  specDigest: string
  /** Injected answer for a resumed human node (matched by node id — the
   *  H11 HumanNode generates its own interruptId per run). */
  resumeAnswer?: { nodeId: string; answer: unknown }
  onWaiting?: (record: import("../interrupts/types").WorkflowInterruptRecord, resumeToken: string) => void
  onResolved?: (interruptId: string) => void
}

export async function executeHarnessNode(
  node: WorkflowNodeSpec,
  runtime: WorkflowHarnessRuntime,
  store: ResultStore,
  projectRootOverride?: string,
  interrupts?: HarnessInterruptRuntime,
): Promise<WorkflowNodeResult> {
  const startedAt = Date.now()
  try {
    // MACP-M4: a human node with no answer pauses the run (persisted
    // record + waiting result) instead of blocking the process. The record
    // is written BEFORE the H11 node starts; the H11 node never sees the
    // interrupt error (no failed result, no double state).
    if (node.execution?.kind === "human" && interrupts) {
      const hasAnswer =
        (interrupts.resumeAnswer !== undefined && interrupts.resumeAnswer.nodeId === node.id) ||
        runtime.environment.respond !== undefined
      if (!hasAnswer) {
        const context = createWorkflowNodeContext(runtime, node.id, projectRootOverride)
        const opened = interrupts.controller.openInterrupt({
          runId: runtime.runId,
          specId: interrupts.specId,
          specDigest: interrupts.specDigest,
          nodeId: node.id,
          nodeRunId: context.nodeRunId,
          kind: humanInterruptKind(node),
          prompt: (node.execution as { prompt?: string }).prompt ?? "approval required",
          responseSchema: (node.execution as { responseSchema?: unknown }).responseSchema,
          expiresInMs: undefined,
        })
        interrupts.onWaiting?.(opened.record, opened.resumeToken)
        throw new WorkflowInterruptError(opened.record)
      }
    }
    const harnessNode = buildHarnessNode(node, runtime.environment, {
      respond: interrupts?.resumeAnswer && interrupts.resumeAnswer.nodeId === node.id
        ? async () => interrupts.resumeAnswer!.answer
        : undefined,
    })
    const context = createWorkflowNodeContext(runtime, node.id, projectRootOverride)
    const input = harnessInputFor(node)
    const { result } = await runNodeToResult(harnessNode, context, input)
    const adapted = adaptNodeResult(result, { nodeId: node.id, startedAt })
    store.put(adapted)
    return adapted
  } catch (error) {
    if (error instanceof WorkflowInterruptError) {
      throw error // pause propagates to the scheduler, never a failed result
    }
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
