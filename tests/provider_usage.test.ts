import { describe, expect, test } from "bun:test"
import { extractProviderTokenUsage } from "../src/provider/usage"

describe("provider usage extraction", () => {
  test("extracts Anthropic-style cache usage from message_start", () => {
    const usage = extractProviderTokenUsage({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 120,
          output_tokens: 0,
          cache_read_input_tokens: 880,
          cache_creation_input_tokens: 20,
        },
      },
    })

    expect(usage?.inputTokens).toBe(120)
    expect(usage?.outputTokens).toBe(0)
    expect(usage?.cacheReadInputTokens).toBe(880)
    expect(usage?.cacheCreationInputTokens).toBe(20)
    expect(usage?.cacheMissInputTokens).toBe(0)
    expect(usage?.cacheHitRate).toBe(100)
  })

  test("extracts DeepSeek-compatible explicit cache hit and miss names", () => {
    const usage = extractProviderTokenUsage({
      usage: {
        prompt_cache_hit_tokens: 900,
        prompt_cache_miss_tokens: 100,
        completion_tokens: 33,
      },
    })

    expect(usage?.cacheReadInputTokens).toBe(900)
    expect(usage?.cacheMissInputTokens).toBe(100)
    expect(usage?.outputTokens).toBe(33)
    expect(usage?.cacheHitRate).toBe(90)
  })

  test("extracts OpenAI cached prompt tokens from nested usage details", () => {
    const usage = extractProviderTokenUsage({
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 750 },
      },
    })

    expect(usage?.inputTokens).toBe(1_000)
    expect(usage?.cacheReadInputTokens).toBe(750)
    expect(usage?.cacheMissInputTokens).toBe(250)
    expect(usage?.cacheHitRate).toBe(75)
  })

  test("marks Claude-style high cache hit usage shape", () => {
    const usage = extractProviderTokenUsage({
      usage: {
        prompt_cache_hit_tokens: 331_501_312,
        prompt_cache_miss_tokens: 1_354_726,
        completion_tokens: 616_971,
      },
    })

    expect(usage?.cacheHitRate).toBeGreaterThanOrEqual(99)
    expect(usage?.missShare).toBeLessThanOrEqual(1)
    expect(usage?.outputShare).toBeLessThanOrEqual(1)
    expect(usage?.claudeStyleCacheShape).toBe(true)
  })
})
