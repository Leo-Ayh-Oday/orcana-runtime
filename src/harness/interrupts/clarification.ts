/** Clarification interrupt (H7, plan §11.4 first batch).
 *
 *  The legacy clarification_ready pause becomes a persistent clarification
 *  interrupt. Resume injects the user's answers into the conversation
 *  history as a user message following the clarification marker — the
 *  kernel's findPendingClarification(history) then keeps the next run from
 *  re-triggering the clarification gate.
 */

import type { HarnessInterrupt } from "../contracts/interrupt"
import type { JsonSchema } from "../contracts/schema"
import type { AgentRunInput } from "../contracts/run"
import { LEGACY_CONVERSATION_HISTORY } from "../runtime/legacy-loop-adapter"

export const CLARIFICATION_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    answers: { type: "array" },
  },
  required: ["answers"],
}

export function createClarificationInterrupt(input: {
  runId: string
  prompt: string
  createdAt: number
  interruptId: string
}): HarnessInterrupt {
  return {
    interruptId: input.interruptId,
    runId: input.runId,
    kind: "clarification",
    prompt: input.prompt,
    responseSchema: CLARIFICATION_SCHEMA,
    checkpointId: "",
    createdAt: input.createdAt,
    status: "pending",
  }
}

/** Apply clarification answers onto the continuation input (history injection). */
export function applyClarificationResponse(
  input: AgentRunInput,
  payload: { answers: Array<{ questionId?: string; answer: string }> },
): AgentRunInput {
  const history = (input.metadata?.[LEGACY_CONVERSATION_HISTORY] as Array<{ role: string; content: string }> | undefined) ?? []
  const answerText = payload.answers
    .map(a => a.answer)
    .filter(Boolean)
    .join("\n")
  const continuationHistory = answerText
    ? [
        ...history,
        // findPendingClarification looks for the marker assistant message and
        // then the user message BEFORE it — so the original prompt must
        // precede the marker, and the answer follows it. That keeps the
        // clarification gate from re-firing on the continuation run.
        { role: "user" as const, content: input.prompt },
        { role: "assistant" as const, content: "[clarification-gate] answered" },
        { role: "user" as const, content: `用户回答：\n${answerText}` },
      ]
    : history
  return {
    ...input,
    metadata: { ...input.metadata, [LEGACY_CONVERSATION_HISTORY]: continuationHistory },
  }
}
