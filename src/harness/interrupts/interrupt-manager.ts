/** Interrupt manager (H7, plan §11).
 *
 *  Owns interrupt creation (attached to a waiting run) and the resume
 *  validation chain: run is waiting → interrupt pending → interruptId
 *  matches → response passes schema → workspace hash unchanged. Rejection
 *  (accepted: false) becomes a formal rejected → cancelled branch; repeated
 *  resumes are idempotently refused once answered.
 */

import { randomUUID } from "node:crypto"
import { HarnessError, InvalidInterruptResponseError } from "../contracts/errors"
import type { HarnessInterrupt, InterruptResponse } from "../contracts/interrupt"
import type { AgentRun } from "../contracts/run"
import { validateJsonSchema } from "./response-validator"
import { createPlanApprovalInterrupt } from "./plan-approval"
import { createClarificationInterrupt } from "./clarification"

export function createInterruptForDecision(
  run: AgentRun,
  decision: "plan_approval" | "clarification",
): HarnessInterrupt {
  const input = {
    runId: run.runId,
    prompt: decision === "plan_approval"
      ? "请审核并批准执行计划（approved: true 批准；planText 携带计划文本）"
      : "请回答澄清问题（answers: [{questionId, answer}]）",
    createdAt: Date.now(),
    interruptId: randomUUID(),
  }
  return decision === "plan_approval"
    ? createPlanApprovalInterrupt(input)
    : createClarificationInterrupt(input)
}

export interface ValidateResumeInput {
  run: AgentRun
  response: InterruptResponse
  /** Workspace hash stored with the run at pause time (cross-instance resumes). */
  savedWorkspaceHash?: string
  /** Recompute the workspace hash now; mismatch rejects the resume. */
  currentWorkspaceHash?: string
}

export type ResumeValidation =
  | { ok: true; interrupt: HarnessInterrupt }
  | { ok: false; error: HarnessError }

export function validateResume(input: ValidateResumeInput): ResumeValidation {
  const { run, response } = input
  if (run.status !== "waiting") {
    return { ok: false, error: new HarnessError("invalid_state_transition", `resume requires a waiting run, got ${run.status}`, run.runId) }
  }
  const interrupt = run.interrupt
  if (!interrupt) {
    return { ok: false, error: new HarnessError("interrupt_not_pending", "run has no pending interrupt", run.runId) }
  }
  if (interrupt.status !== "pending") {
    return { ok: false, error: new HarnessError("interrupt_not_pending", `interrupt ${interrupt.interruptId} is ${interrupt.status}`, run.runId) }
  }
  if (response.interruptId !== interrupt.interruptId) {
    return { ok: false, error: new InvalidInterruptResponseError(interrupt.interruptId, "interruptId mismatch") }
  }
  const schemaErrors = validateJsonSchema(response.payload, interrupt.responseSchema)
  if (schemaErrors.length > 0) {
    return { ok: false, error: new InvalidInterruptResponseError(interrupt.interruptId, schemaErrors.join("; ")) }
  }
  if (input.savedWorkspaceHash !== undefined
    && input.currentWorkspaceHash !== undefined
    && input.currentWorkspaceHash !== input.savedWorkspaceHash) {
    return { ok: false, error: new HarnessError("workspace_changed", "workspace changed since the run paused", run.runId) }
  }
  return { ok: true, interrupt }
}

export function markInterruptAnswered(interrupt: HarnessInterrupt, accepted: boolean): void {
  interrupt.status = accepted ? "answered" : "rejected"
}
