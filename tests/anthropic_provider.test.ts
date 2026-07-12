import { describe, expect, test } from "bun:test"
import { AnthropicProvider } from "../src/provider/anthropic"

describe("AnthropicProvider stop reason handling", () => {
  test("does not report a max-token response as normal completion", async () => {
    const provider = new AnthropicProvider("test", {
      maxRetries: 0,
      client: {
        messages: {
          async *stream() {
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }
            yield { type: "message_delta", delta: { stop_reason: "max_tokens" } }
          },
        },
      },
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "claude-test", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 10,
    })) events.push(event)

    expect(events.some(event => event.type === "error" && String(event.data).includes("max_tokens"))).toBe(true)
    expect(events.some(event => event.type === "done")).toBe(false)
  })
})

describe("AnthropicProvider cache breakpoints", () => {
  test("marks the stable system and first message prefixes cacheable", async () => {
    let captured: Record<string, unknown> | undefined
    const provider = new AnthropicProvider("test", {
      client: { messages: { async *stream(params) { captured = params as unknown as Record<string, unknown> } } },
    })
    for await (const _event of provider.streamChat({
      model: "claude-test", system: "stable system", messages: [{ role: "user", content: "stable prefix" }], maxTokens: 10,
    })) { /* consume */ }

    expect(JSON.stringify(captured?.system)).toContain("cache_control")
    expect(JSON.stringify(captured?.messages)).toContain("cache_control")
  })
})
