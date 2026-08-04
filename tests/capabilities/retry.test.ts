import { describe, expect, test } from "bun:test"
import { NO_RETRY, retryDelayMs, shouldRetry, type RetryPolicy } from "../../src/harness/capabilities/retry"
import { toolError } from "../../src/harness/capabilities/errors"

// RT-1: retry policy — code-scoped, exponential backoff, opt-in.

const POLICY: RetryPolicy = { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 500 }

describe("RT-1 retry policy", () => {
  test("no retry when policy is NO_RETRY", () => {
    expect(shouldRetry(toolError("TIMEOUT", "x"), NO_RETRY, 0)).toBe(false)
  })

  test("retries only retryable errors", () => {
    expect(shouldRetry(toolError("TIMEOUT", "x"), POLICY, 0)).toBe(true)
    expect(shouldRetry(toolError("PERMISSION_DENIED", "x"), POLICY, 0)).toBe(false)
  })

  test("attempt cap honored", () => {
    expect(shouldRetry(toolError("TIMEOUT", "x"), POLICY, 0)).toBe(true)
    expect(shouldRetry(toolError("TIMEOUT", "x"), POLICY, 2)).toBe(true)
    expect(shouldRetry(toolError("TIMEOUT", "x"), POLICY, 3)).toBe(false) // maxRetries reached
  })

  test("code allowlist restricts retries", () => {
    const narrow: RetryPolicy = { maxRetries: 2, baseDelayMs: 10, retryableCodes: ["RATE_LIMITED"] }
    expect(shouldRetry(toolError("RATE_LIMITED", "x"), narrow, 0)).toBe(true)
    expect(shouldRetry(toolError("TIMEOUT", "x"), narrow, 0)).toBe(false)
  })

  test("exponential backoff with cap", () => {
    expect(retryDelayMs(POLICY, 0)).toBe(100)
    expect(retryDelayMs(POLICY, 1)).toBe(200)
    expect(retryDelayMs(POLICY, 2)).toBe(400)
    expect(retryDelayMs(POLICY, 3)).toBe(500) // capped at maxDelayMs
  })

  test("non-retryable override blocks even for retryable codes", () => {
    const info = toolError("TIMEOUT", "x", { retryable: false })
    expect(shouldRetry(info, POLICY, 0)).toBe(false)
  })
})
