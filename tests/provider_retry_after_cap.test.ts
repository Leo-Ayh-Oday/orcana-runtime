/** RC-14 G11: Retry-After must be capped — a hostile or broken header can
 *  never make the provider sleep without bound (cap 60s). */

import { describe, expect, test } from "bun:test"
import { classifyProviderError, providerRetryDelayMs } from "../src/provider/retry"

const MAX_RETRY_AFTER_MS = 60_000

describe("Retry-After cap (RC-14 G11)", () => {
  test("caps a huge seconds-based Retry-After at 60s", () => {
    const info = classifyProviderError({ status: 429, headers: { "retry-after": "3600" }, message: "rate limited" })
    expect(info.retryAfterMs).toBe(3_600_000)
    expect(providerRetryDelayMs(info, 0)).toBe(MAX_RETRY_AFTER_MS)
  })

  test("caps a far-future date-based Retry-After at 60s", () => {
    const farFuture = new Date(Date.now() + 7 * 24 * 3600 * 1000).toUTCString()
    const info = classifyProviderError({ status: 429, headers: { "retry-after": farFuture }, message: "rate limited" })
    expect(providerRetryDelayMs(info, 0)).toBe(MAX_RETRY_AFTER_MS)
  })

  test("keeps small Retry-After values uncapped", () => {
    const info = classifyProviderError({ status: 429, headers: { "retry-after": "2" }, message: "rate limited" })
    expect(providerRetryDelayMs(info, 0)).toBe(2_000)
  })
})
