/** MACP-M2: WorkflowNodeSpec → H11 HarnessNode adapter.
 *
 *  Every declared execution kind maps to exactly one H11 node type:
 *    tool          → ToolNode (CapabilityExecutor)
 *    llm_agent     → LlmAgentNode (LegacyLoopAdapter + BudgetGuard)
 *    verification  → VerificationNode (H8 artifact/evidence adapter)
 *    human         → HumanNode (interrupt bridge)
 *    function      → not a harness node (handler registry reducer path)
 *
 *  Fail-closed (H11_ADAPTER / DIRECT_LLM_BYPASS / DIRECT_TOOL_BYPASS):
 *  an llm_agent node requires loopDeps, a tool node requires capabilities —
 *  missing prerequisites throw instead of falling back to a handler bypass.
 *  The handler registry remains a *read-only reducer* surface only.
 */

import type { HarnessNode } from "../../harness/contracts/nodes"
import { createToolNode } from "../../harness/nodes/tool-node"
import { createLlmAgentNode } from "../../harness/nodes/llm-agent-node"
import { createVerificationNode } from "../../harness/nodes/verification-node"
import { createHumanNode } from "../../harness/nodes/human-node"
import type { WorkflowNodeSpec } from "../types"
import type { WorkflowHarnessEnvironment } from "./environment"
import type { VerificationResult } from "../../verification/result"

/** Input the harness node will receive for this workflow node. */
export function harnessInputFor(node: WorkflowNodeSpec): unknown {
  const execution = node.execution
  switch (execution?.kind) {
    case "tool":
      return {
        capabilityId: execution.capabilityId,
        params: execution.params ?? node.input,
        toolCallId: `${node.id}:${execution.capabilityId}`,
      }
    case "llm_agent":
      return {
        prompt: execution.prompt,
        maxRounds: execution.maxRounds,
        tools: execution.tools,
        metadata: execution.metadata,
      }
    case "verification": {
      const results = node.input.results as VerificationResult[] | undefined
      if (!Array.isArray(results) || results.length === 0) {
        throw new Error(
          `workflow: verification node "${node.id}" requires input.results (VerificationResult[]) — produced by upstream nodes`,
        )
      }
      return {
        results,
        modifiedFiles: execution.modifiedFiles,
        workspaceHash: execution.workspaceHash,
      }
    }
    case "human":
      return {
        kind: (node.input.kind as import("../../harness/contracts/interrupt").InterruptKind) ?? "clarification",
        prompt: execution.prompt,
        responseSchema: execution.responseSchema,
      }
    default:
      return node.input
  }
}

/** Whether this workflow node executes through the H11 runtime. */
export function isHarnessNode(node: WorkflowNodeSpec): boolean {
  return node.execution !== undefined && node.execution.kind !== "function"
}

/** Build the H11 node; throws when the environment cannot honor the
 *  declared execution kind (fail-closed, no bypass). */
export function buildHarnessNode(
  node: WorkflowNodeSpec,
  environment: WorkflowHarnessEnvironment,
): HarnessNode<unknown, unknown> {
  const execution = node.execution
  if (!execution || execution.kind === "function") {
    throw new Error(`workflow: node "${node.id}" is not an H11 execution — use the handler path`)
  }
  switch (execution.kind) {
    case "tool": {
      if (!environment.capabilities) {
        throw new Error(`workflow: tool node "${node.id}" requires a capability registry (no harness environment)`)
      }
      return createToolNode({
        id: node.id,
        policyContext: undefined, // derived from run scope (strict, fail-closed)
        tools: environment.tools,
      }) as HarnessNode<unknown, unknown>
    }
    case "llm_agent": {
      if (!environment.loopDeps) {
        throw new Error(
          `workflow: llm_agent node "${node.id}" requires environment.loopDeps — direct model bypass is forbidden (MACP-M2)`,
        )
      }
      return createLlmAgentNode({ id: node.id, deps: environment.loopDeps }) as HarnessNode<unknown, unknown>
    }
    case "verification":
      return createVerificationNode({ id: node.id }) as HarnessNode<unknown, unknown>
    case "human":
      return createHumanNode({
        id: node.id,
        respond: environment.respond
          ? async interrupt => environment.respond!(interrupt)
          : undefined,
      }) as HarnessNode<unknown, unknown>
  }
}
