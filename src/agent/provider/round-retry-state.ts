/**
 * RC-19 Phase 1: per-round provider retry state.
 *
 * Tracks what a round has already emitted so a retry or replay can never
 * duplicate side effects:
 *   - DUPLICATE_PROVIDER_SIDE_EFFECT — emitted thinking/text is never replayed.
 *   - RETRY_AFTER_SIDE_EFFECT — once `sideEffectBoundaryCrossed` is true (a
 *     complete tool call was handed to the executor) NO_BLIND_RETRY applies.
 *   - DUPLICATE_TOOL_CALL_EXECUTED — `completedToolCallIds` is the per-round
 *     dedup key (the run-scoped ToolExecutionLedger is the run-wide one).
 *   - ABORT_RETRIED — `aborted` is surfaced for policy decisions.
 *
 * The kernel/round-runner layer is the observer; providers enforce their own
 * side-effect safety via `unsafeToRetry` (openai.ts/deepseek.ts/anthropic.ts).
 */

import { randomUUID } from "node:crypto"

export interface ProviderRoundRetryState {
  /** Stable identity for this round's provider request (observability + dedup). */
  requestId: string
  emittedThinking: boolean
  emittedText: boolean
  /** True once a complete tool call was delivered to the executor. */
  toolCallStarted: boolean
  /** Tool call ids this round handed to the executor (per-round dedup key). */
  completedToolCallIds: Set<string>
  /** True once any irreversible output (a full tool call) was consumed. */
  sideEffectBoundaryCrossed: boolean
  aborted: boolean
}

export function createProviderRoundRetryState(): ProviderRoundRetryState {
  return {
    requestId: `req-${randomUUID().slice(0, 8)}`,
    emittedThinking: false,
    emittedText: false,
    toolCallStarted: false,
    completedToolCallIds: new Set(),
    sideEffectBoundaryCrossed: false,
    aborted: false,
  }
}

/**
 * NO_BLIND_RETRY policy (directive §5.3): once a round crossed the side-effect
 * boundary, no provider round may be blindly replayed — the caller must treat
 * the round as terminal (surface the error, let the kernel decide recovery).
 */
export function noBlindRetry(state: Pick<ProviderRoundRetryState, "sideEffectBoundaryCrossed">): boolean {
  return state.sideEffectBoundaryCrossed
}
