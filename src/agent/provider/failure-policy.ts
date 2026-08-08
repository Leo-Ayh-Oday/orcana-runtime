import { classifyProviderError } from "../../provider/retry"
import type { ProviderMessage } from "../../provider/types"
import {
  formatGenericProviderStreamBlockedReport,
  formatGenericProviderStreamRecoveryPrompt,
  formatProviderStreamBlockedReport,
  formatProviderStreamRecoveryPrompt,
} from "../runtime-failure"
import type { RetryLedger } from "../../runtime/retry-ledger"
import { compactAssistantContext } from "../round/helpers"
import { missingTaskRequirements, type TaskTracker } from "../task-tracker"
import type { ProviderFailure } from "../run/types"

export function isNonRetryableProviderStreamError(error: string): boolean {
  // GATE-02 (GS-03): max_tokens is TRUNCATED — never a generic retryable
  // provider error. The main path (deepseek/anthropic providers) already
  // emits `truncated` events instead of errors; this is the backstop for any
  // path that still surfaces it as an error: re-issuing the same doomed
  // request was the OTS-013 loop.
  return /stop_reason=max_tokens|finish_reason=(length|max_tokens)/i.test(error)
    || /^(auth|client|quota)(?:\s|:)/i.test(error)
    || /insufficient[_\s-]*quota|quota[_\s-]*(?:exceeded|insufficient)|(?:exceeded|insufficient)[_\s-]*quota|balance|billing|payment\s*required|prepaid|credits?|额度|余额|欠费|账户余额|资源包|套餐/i.test(error)
}

/**
 * Provider error events historically default to retryable unless they carry a
 * known auth/client/quota marker.
 */
export function failureFromProviderEvent(message: string): ProviderFailure {
  return {
    message,
    retryable: !isNonRetryableProviderStreamError(message),
    yielded: true,
  }
}

/** Thrown failures use the provider transport classifier. */
export function failureFromProviderException(error: unknown): ProviderFailure {
  const classified = classifyProviderError(error)
  return {
    message: error instanceof Error ? error.message : String(error),
    retryable: classified.retryable,
    yielded: true,
  }
}

export interface ProviderFailureRecoveryInput {
  failure: ProviderFailure
  round: number
  maxRounds: number
  finalText: string
  taskTracker: TaskTracker | null
  changedFiles: string[]
  /** PR-GATE-06：Run 级 RetryLedger —— 同一 round 的轮续跑（truncation 类）
   *  最多一次，预算与 provider/capability/repair 层共享。 */
  retryLedger?: RetryLedger
}

export interface ProviderFailureRecoveryDecision {
  action: "continue" | "break"
  status: string
  messages: ProviderMessage[]
  text?: string
  emitError: boolean
  trace: Record<string, unknown>
}

/**
 * Pure retry-or-block policy. The Agent loop remains the control-flow owner,
 * but Provider-specific recovery prompts and failure classification stay in
 * the Provider stage.
 */
export function decideProviderFailureRecovery(
  input: ProviderFailureRecoveryInput,
): ProviderFailureRecoveryDecision {
  const { failure } = input
  if (!failure.retryable) {
    return {
      action: "break",
      status: `provider-stream-gate: blocked (non-retryable: ${failure.message.slice(0, 80)})`,
      messages: [],
      emitError: !failure.yielded,
      trace: {
        gate: "provider_stream",
        decision: "blocked",
        reason: "non_retryable",
        error: failure.message,
      },
    }
  }

  // PR-GATE-06：轮续跑属于 truncation 类 —— 同一 round 经 ledger 严格限次
  // （truncation <= 1），不再只依赖 maxRounds 宽松边界。
  const roundFingerprint = `truncation:${input.round}`
  const ledgerAllows = !input.retryLedger || input.retryLedger.canRetry("truncation", roundFingerprint)
  const canRetry = ledgerAllows && input.round + 1 < input.maxRounds
  const assistantContext: ProviderMessage[] = input.finalText.trim()
    ? [{ role: "assistant", content: compactAssistantContext(input.finalText) }]
    : []

  if (input.taskTracker) {
    const missing = missingTaskRequirements(input.taskTracker)
    if (canRetry) {
      input.retryLedger?.record("truncation", roundFingerprint)
      return {
        action: "continue",
        status: "provider-stream-gate: retrying unfinished long task",
        messages: [
          ...assistantContext,
          {
            role: "user",
            content: formatProviderStreamRecoveryPrompt({
              error: failure.message,
              missing,
            }),
          },
        ],
        emitError: !failure.yielded,
        trace: {
          gate: "provider_stream",
          decision: "continue",
          error: failure.message,
          missing,
        },
      }
    }

    return {
      action: "break",
      status: "provider-stream-gate: blocked unfinished long task",
      messages: [],
      text: formatProviderStreamBlockedReport({
        error: failure.message,
        missing,
        changedFiles: input.changedFiles,
      }),
      emitError: !failure.yielded,
      trace: {
        gate: "provider_stream",
        decision: "blocked",
        error: failure.message,
        missing,
      },
    }
  }

  if (canRetry) {
    input.retryLedger?.record("truncation", roundFingerprint)
    return {
      action: "continue",
      status: "provider-stream-gate: retrying interrupted round",
      messages: [
        ...assistantContext,
        {
          role: "user",
          content: formatGenericProviderStreamRecoveryPrompt({
            error: failure.message,
          }),
        },
      ],
      emitError: !failure.yielded,
      trace: {
        gate: "provider_stream",
        decision: "continue",
        error: failure.message,
      },
    }
  }

  return {
    action: "break",
    status: "provider-stream-gate: blocked interrupted round",
    messages: [],
    text: formatGenericProviderStreamBlockedReport({
      error: failure.message,
    }),
    emitError: !failure.yielded,
    trace: {
      gate: "provider_stream",
      decision: "blocked",
      error: failure.message,
    },
  }
}
