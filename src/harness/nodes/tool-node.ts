/** ToolNode (H11) — a capability execution as a node.
 *
 *  Wraps the H9 CapabilityExecutor (node mode): budget reservations land on
 *  the run-level ledger, cancellation flows through the run signal, and the
 *  default artifact tracker records patch artifacts for write-class
 *  capabilities (Node Artifact acceptance).
 *
 *  R1 (Harness Closure): the policy gate is MANDATORY and cannot be forgotten.
 *  When the caller supplies no policyContext, ToolNode derives one from the
 *  run scope (createNodePolicyContextFromRunScope) — project permission rules
 *  under the run's projectRoot apply, and the mode is strict (node mode has
 *  no interactive confirm channel, so "ask" fails closed). A resolved tool
 *  descriptor (options.tools) gives the gate full category/risk/readonly
 *  semantics; without one, the capability name still runs through the gate
 *  via category inference (policy.ts Gate 2, R1).
 */

import type { HarnessNode, NodeEvent, NodeExecutionContext, NodeResult, NodeUsage, ToolNodeInput } from "../contracts/nodes"
import { executeCapability } from "../capabilities/executor"
import { createToolArtifactTracker } from "../capabilities/tool-adapter"
import type { NodePolicyContext } from "../capabilities/policy-adapter"
import type { CapabilityArtifactTracker } from "../capabilities/executor"
import type { ToolDescriptor, ToolResult } from "../../tools/registry"
import { createNodePolicyContextFromRunScope } from "./context"

export interface ToolNodeOptions {
  id: string
  policyContext?: NodePolicyContext
  artifactTracker?: CapabilityArtifactTracker
  /** Canonical tool descriptors for policy resolution (category/risk/readonly).
   *  Optional: without one the gate still runs on the capability name. */
  tools?: ToolDescriptor[]
}

export function createToolNode(options: ToolNodeOptions): HarnessNode<ToolNodeInput, ToolResult> {
  let result: NodeResult<ToolResult> | null = null

  return {
    id: options.id,
    kind: "tool",

    async *execute(context: NodeExecutionContext, input: ToolNodeInput): AsyncGenerator<NodeEvent> {
      try {
        const descriptor = context.capabilities.resolve(input.capabilityId).descriptor
        // R1: resolve the canonical tool descriptor for the policy gate; the
        // policy context is NEVER undefined — when the caller did not supply
        // one, derive it from the run scope (project rules + strict mode).
        const tool = options.tools?.find((t) => t.defn.name === input.capabilityId)
        const policyContext = options.policyContext
          ?? createNodePolicyContextFromRunScope(context.runScope, {
            input: input.params,
            tool,
            toolCallId: input.toolCallId,
            name: input.capabilityId,
          })
        const executed = await executeCapability(context.capabilities, {
          capabilityId: input.capabilityId,
          params: input.params,
          budget: context.budget,
          policyContext,
          toolCallId: input.toolCallId,
          artifactTracker: options.artifactTracker
            ?? createToolArtifactTracker({
              store: context.artifacts,
              runId: context.runId,
              projectRoot: context.runScope.projectRoot,
            }),
          abortSignal: context.cancellation.signal,
        })

        const toolResult = executed.result
        const nodeUsage: NodeUsage = {
          modelCalls: 0,
          toolCalls: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheMissTokens: 0,
          wallTimeMs: 0,
        }

        if (toolResult.success) {
          result = {
            status: "succeeded",
            output: toolResult,
            evidence: [],
            diagnostics: [],
            usage: nodeUsage,
          }
          yield { type: "node.tool.result", nodeRunId: context.nodeRunId, toolName: input.capabilityId, success: true, content: toolResult.content }
        } else {
          const blocked = toolResult.metadata?.blocked === true
          result = {
            status: blocked ? "blocked" : "failed",
            evidence: [],
            diagnostics: [{
              code: blocked ? "policy_blocked" : "tool_failed",
              message: toolResult.error ?? toolResult.content,
              severity: "error",
              source: input.capabilityId,
            }],
            usage: nodeUsage,
            retryable: blocked ? false : descriptor.retryable,
            error: { kind: blocked ? "policy_blocked" : "tool_failed", message: toolResult.error ?? toolResult.content, retryable: blocked ? false : descriptor.retryable },
          }
          yield { type: "node.tool.result", nodeRunId: context.nodeRunId, toolName: input.capabilityId, success: false, content: toolResult.content }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Preserve typed HarnessError kinds (e.g. capability_not_found).
        const kind = error instanceof Error && "kind" in error && typeof (error as { kind?: unknown }).kind === "string"
          ? (error as { kind: string }).kind
          : "node_execution_error"
        const nodeError: NodeResult<ToolResult>["error"] = { kind, message, retryable: false }
        result = {
          status: "failed",
          evidence: [],
          diagnostics: [{ code: kind, message, severity: "error", source: options.id }],
          usage: { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheMissTokens: 0, wallTimeMs: 0 },
          error: nodeError,
        }
        yield { type: "node.error", nodeRunId: context.nodeRunId, error: nodeError }
      }
    },

    async getResult(): Promise<NodeResult<ToolResult>> {
      if (!result) throw new Error(`node ${options.id} getResult called before execute`)
      return result
    },
  }
}
