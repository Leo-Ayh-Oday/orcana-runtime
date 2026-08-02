/**
 * H0: Interrupt / Resume contract.
 *
 * A run that needs human input pauses into a WAITING state with a typed
 * HarnessInterrupt. Resume must answer by interruptId, pass schema validation,
 * and be idempotent.
 */

import type { JsonSchema } from "./schema"

export type InterruptKind =
  | "plan_approval"
  | "clarification"
  | "tool_approval"
  | "credential_required"
  | "conflict_resolution"
  | "manual_verification"

export type InterruptStatus = "pending" | "answered" | "rejected" | "expired"

export interface HarnessInterrupt {
  interruptId: string
  runId: string
  kind: InterruptKind

  prompt: string
  responseSchema: JsonSchema

  checkpointId: string
  createdAt: number
  expiresAt?: number

  status: InterruptStatus
}

export interface InterruptResponse {
  interruptId: string
  /** Validated against the interrupt's responseSchema. */
  payload: unknown
  accepted: boolean
  answeredAt: number
}
