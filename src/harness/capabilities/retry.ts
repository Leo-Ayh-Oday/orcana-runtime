/** Tool Runtime 2.0 (RT-1): retry policy for capability execution.
 *
 *  Retry is opt-in per capability (descriptor.retryable) and code-scoped:
 *  only errors whose code is retryable (or explicitly listed) are retried.
 */

import type { ToolErrorInfo, ToolErrorCode } from "./errors"

export interface RetryPolicy {
  /** Maximum attempts AFTER the first (0 = no retry). */
  maxRetries: number
  /** Base backoff delay in ms (exponential: base * 2^attempt). */
  baseDelayMs: number
  /** Cap on the backoff delay. */
  maxDelayMs?: number
  /** Optional allowlist of codes that may be retried (default: error.retryable). */
  retryableCodes?: ToolErrorCode[]
}

export const NO_RETRY: RetryPolicy = { maxRetries: 0, baseDelayMs: 0 }

/** Whether `error` may be retried at `attempt` (0-based) under `policy`. */
export function shouldRetry(error: ToolErrorInfo, policy: RetryPolicy, attempt: number): boolean {
  if (attempt >= policy.maxRetries) return false
  if (!error.retryable) return false
  if (policy.retryableCodes && !policy.retryableCodes.includes(error.code)) return false
  return true
}

/** Backoff delay for `attempt` (0-based) — exponential with jitter-free cap. */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  const base = policy.baseDelayMs * 2 ** attempt
  const capped = policy.maxDelayMs === undefined ? base : Math.min(base, policy.maxDelayMs)
  return Math.max(0, Math.floor(capped))
}
