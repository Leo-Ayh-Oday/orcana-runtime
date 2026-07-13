import { describe, expect, test } from "bun:test"
import { AnthropicProvider } from "../src/provider/anthropic"

describe("AnthropicProvider stop reason handling", () => {
  test("reports a clean EOF without stop_reason as an interrupted stream", async () => {
    const provider = new AnthropicProvider("test", {
      maxRetries: 0,
      client: {
        messages: {
          async *stream() {
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }
          },
        },
      },
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "claude-test", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 10,
    })) events.push(event)

    expect(events.some(event => event.type === "error" && String(event.data).includes("ended unexpectedly"))).toBe(true)
    expect(events.some(event => event.type === "done")).toBe(false)
  })

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

  test("treats model context-window exhaustion as recoverable interruption", async () => {
    const provider = new AnthropicProvider("test", {
      maxRetries: 0,
      client: {
        messages: {
          async *stream() {
            yield { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }
            yield { type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" } }
          },
        },
      },
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "claude-test", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 10,
    })) events.push(event)

    expect(events.some(event => event.type === "error" && String(event.data).includes("model_context_window_exceeded"))).toBe(true)
    expect(events.some(event => event.type === "done")).toBe(false)
  })

  test("does not execute an irreparable tool call payload", async () => {
    const provider = new AnthropicProvider("test", {
      maxRetries: 0,
      client: {
        messages: {
          async *stream() {
            yield { type: "content_block_start", content_block: { type: "tool_use", id: "bad", name: "write_file" } }
            yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "not-json" } }
            yield { type: "content_block_stop" }
            yield { type: "message_delta", delta: { stop_reason: "tool_use" } }
          },
        },
      },
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "claude-test", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 10,
    })) events.push(event)

    expect(events.some(event => event.type === "error" && String(event.data).includes("invalid tool call JSON"))).toBe(true)
    expect(events.some(event => event.type === "tool_call")).toBe(false)
  })

  test("accepts an empty tool input carried by content_block_start", async () => {
    const provider = new AnthropicProvider("test", {
      maxRetries: 0,
      client: {
        messages: {
          async *stream() {
            yield { type: "content_block_start", content_block: { type: "tool_use", id: "empty", name: "list_files", input: {} } }
            yield { type: "content_block_stop" }
            yield { type: "message_delta", delta: { stop_reason: "tool_use" } }
          },
        },
      },
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "claude-test", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 10,
    })) events.push(event)

    expect(events.find(event => event.type === "tool_call")?.data).toEqual({ id: "empty", name: "list_files", input: {} })
    expect(events.some(event => event.type === "error")).toBe(false)
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
