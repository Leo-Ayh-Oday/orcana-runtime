/** HumanNode (H11) — the interrupt bridge for graph-side human interaction.
 *
 *  Emits a node.interrupt request, awaits the respond() callback (the future
 *  scheduler's connection to a human), and validates the answer against the
 *  interrupt's response schema (H7 validateJsonSchema). It deliberately does
 *  NOT write run-level interrupt state (run.interrupt / validateResume /
 *  markInterruptAnswered) — that H7 machinery stays with AgentHarness;
 *  writing it here would double-own run state (plan §23).
 */

import type { HarnessNode, HumanNodeInput, NodeEvent, NodeExecutionContext, NodeResult, NodeUsage } from "../contracts/nodes"
import { validateJsonSchema } from "../interrupts/response-validator"
import { PLAN_APPROVAL_SCHEMA } from "../interrupts/plan-approval"
import { CLARIFICATION_SCHEMA } from "../interrupts/clarification"
import { HarnessError } from "../contracts/errors"
import type { JsonSchema } from "../contracts/schema"
import { randomUUID } from "node:crypto"

export interface HumanNodeOptions {
  id: string
  /** Resolves the interrupt with a human answer; default throws not_implemented. */
  respond?: (interrupt: { interruptId: string; kind: HumanNodeInput["kind"]; prompt: string; responseSchema: JsonSchema }) => Promise<unknown>
}

export function createHumanNode(options: HumanNodeOptions): HarnessNode<HumanNodeInput, unknown> {
  let result: NodeResult<unknown> | null = null

  return {
    id: options.id,
    kind: "human",

    async *execute(context: NodeExecutionContext, input: HumanNodeInput): AsyncGenerator<NodeEvent> {
      const responseSchema = input.responseSchema
        ?? (input.kind === "plan_approval" ? PLAN_APPROVAL_SCHEMA : CLARIFICATION_SCHEMA)
      const interrupt = {
        interruptId: randomUUID(),
        kind: input.kind,
        prompt: input.prompt,
        responseSchema,
      }

      yield { type: "node.interrupt", nodeRunId: context.nodeRunId, kind: input.kind, prompt: input.prompt, responseSchema }

      try {
        context.cancellation.throwIfCancelled()
        const respond = options.respond
          ?? (async () => { throw new HarnessError("internal", `human node ${options.id} has no responder`) })
        const answer = await respond(interrupt)

        const errors = validateJsonSchema(answer, responseSchema)
        if (errors.length > 0) {
          const message = `invalid interrupt response: ${errors.join("; ")}`
          const nodeError = { kind: "invalid_interrupt_response", message, retryable: false }
          result = {
            status: "failed",
            evidence: [],
            diagnostics: [{ code: "invalid_interrupt_response", message, severity: "error", source: options.id }],
            usage: zeroUsage(),
            error: nodeError,
          }
          yield { type: "node.error", nodeRunId: context.nodeRunId, error: nodeError }
          return
        }

        result = { status: "succeeded", output: answer, evidence: [], diagnostics: [], usage: zeroUsage() }
        yield { type: "node.output", nodeRunId: context.nodeRunId, output: answer }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const nodeError = { kind: "human_node_error", message, retryable: false }
        result = {
          status: "failed",
          evidence: [],
          diagnostics: [{ code: "human_node_error", message, severity: "error", source: options.id }],
          usage: zeroUsage(),
          error: nodeError,
        }
        yield { type: "node.error", nodeRunId: context.nodeRunId, error: nodeError }
      }
    },

    async getResult(): Promise<NodeResult<unknown>> {
      if (!result) throw new Error(`node ${options.id} getResult called before execute`)
      return result
    },
  }
}

function zeroUsage(): NodeUsage {
  return { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cacheMissTokens: 0, wallTimeMs: 0 }
}
