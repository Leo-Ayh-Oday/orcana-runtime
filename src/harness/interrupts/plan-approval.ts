/** Plan approval interrupt (H7, plan §11.4 first batch).
 *
 *  The legacy plan_ready pause becomes a persistent plan_approval interrupt:
 *  the run waits with a typed interrupt, resume() validates the response and
 *  re-invokes the loop with the approved plan (LEGACY_INITIAL_PLAN_STATE +
 *  LEGACY_PLAN_TEXT — the same continuation input the CLI used pre-H7).
 */

import type { HarnessInterrupt } from "../contracts/interrupt"
import type { JsonSchema } from "../contracts/schema"
import type { AgentRunInput } from "../contracts/run"
import { LEGACY_INITIAL_PLAN_STATE, LEGACY_PLAN_TEXT } from "../runtime/legacy-loop-adapter"

export const PLAN_APPROVAL_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    accepted: { type: "boolean" },
    planText: { type: "string" },
  },
  required: ["accepted"],
}

export function createPlanApprovalInterrupt(input: {
  runId: string
  prompt: string
  createdAt: number
  interruptId: string
}): HarnessInterrupt {
  return {
    interruptId: input.interruptId,
    runId: input.runId,
    kind: "plan_approval",
    prompt: input.prompt,
    responseSchema: PLAN_APPROVAL_SCHEMA,
    checkpointId: "",
    createdAt: input.createdAt,
    status: "pending",
  }
}

/** Apply an approved plan response onto the continuation input. */
export function applyPlanApprovalResponse(
  input: AgentRunInput,
  payload: { accepted: boolean; planText?: string },
): AgentRunInput {
  const metadata = { ...input.metadata }
  if (payload.accepted) {
    metadata[LEGACY_INITIAL_PLAN_STATE] = "approved"
    if (payload.planText) metadata[LEGACY_PLAN_TEXT] = payload.planText
  }
  return { ...input, metadata }
}
