import { describe, expect, test } from "bun:test"
import { buildCacheAnatomy, estimateTokens, summarizeMessages, summarizeSections } from "../src/context/cache-anatomy"

describe("cache anatomy", () => {
  test("uses deterministic chars-per-token estimation", () => {
    expect(estimateTokens("abcdef")).toBe(2)
    expect(estimateTokens({ a: "bc" })).toBe(Math.round(JSON.stringify({ a: "bc" }).length / 3))
  })

  test("classifies stable and volatile sections", () => {
    const anatomy = summarizeSections([
      { kind: "system", tokens: 10, stable: true },
      { kind: "tools", tokens: 20, stable: true },
      { kind: "conversation", tokens: 50, stable: true },
      { kind: "volatileContext", tokens: 7, stable: false },
      { kind: "currentPrompt", tokens: 3, stable: false },
    ])

    expect(anatomy.stableTokens).toBe(80)
    expect(anatomy.volatileTokens).toBe(10)
    expect(anatomy.totalTokens).toBe(90)
    expect(anatomy.estimatedCacheableRate).toBe(88.9)
  })

  test("splits messages into stable prefix, conversation, volatile, budget guard, and current prompt", () => {
    const summary = summarizeMessages([
      { role: "user", content: "## Stable Prefix Context\nM0 and project kernel" },
      { role: "user", content: "older user" },
      { role: "assistant", content: "older assistant" },
      { role: "user", content: "## Volatile Round Context\nLoaded file" },
      { role: "user", content: "## Context Budget Guard\nfinish current stage" },
      { role: "user", content: "current prompt" },
    ])

    expect(summary.stableContextTokens).toBeGreaterThan(0)
    expect(summary.conversationTokens).toBeGreaterThan(0)
    expect(summary.volatileTokens).toBeGreaterThan(0)
    expect(summary.budgetGuardTokens).toBeGreaterThan(0)
    expect(summary.currentPromptTokens).toBeGreaterThan(0)
  })

  test("builds full cache anatomy with future memory placeholders", () => {
    const anatomy = buildCacheAnatomy({
      system: "stable system",
      tools: [{ name: "read_file" }],
      messages: [{ role: "user", content: "current prompt" }],
    })

    expect(anatomy.sections.map(section => section.kind)).toContain("memoryAnchor")
    expect(anatomy.sections.map(section => section.kind)).toContain("memoryDeltas")
    expect(anatomy.stableTokens).toBeGreaterThan(0)
    expect(anatomy.volatileTokens).toBeGreaterThan(0)
  })

  test("conversation messages are not marked as stable", () => {
    const anatomy = buildCacheAnatomy({
      system: "system",
      tools: [],
      messages: [
        { role: "user", content: "earlier user turn" },
        { role: "assistant", content: "earlier assistant turn" },
        { role: "user", content: "current prompt" },
      ],
    })

    const conversation = anatomy.sections.find(section => section.kind === "conversation")
    expect(conversation).toBeDefined()
    expect(conversation!.tokens).toBeGreaterThan(0)
    expect(conversation!.stable).toBe(false)
  })
})
