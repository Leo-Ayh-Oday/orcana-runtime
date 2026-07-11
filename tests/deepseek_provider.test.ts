import { describe, expect, test } from "bun:test"
import { DeepSeekProvider } from "../src/provider/deepseek"

function fakeClient(events: unknown[]) {
  return {
    messages: {
      stream: async function* () {
        for (const event of events) yield event
      },
    },
  }
}

async function collect(events: unknown[]) {
  const provider = new DeepSeekProvider("test-key", { client: fakeClient(events), maxRetries: 0 })
  const out = []
  for await (const ev of provider.streamChat({
    model: "deepseek-v4-flash",
    purpose: "agent_main",
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    maxTokens: 1024,
  })) {
    out.push(ev)
  }
  return out
}

describe("DeepSeekProvider stop_reason handling", () => {
  test("emits a recoverable error when the provider stops at max_tokens", async () => {
    const events = await collect([
      { type: "content_block_delta", delta: { type: "text_delta", text: "partial table" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
    ])

    expect(events.some(ev => ev.type === "text" && ev.data === "partial table")).toBe(true)
    expect(events.some(ev => ev.type === "status" && String(ev.data).includes("provider-stop: max_tokens"))).toBe(true)
    expect(events.some(ev => ev.type === "error" && String(ev.data).includes("max_tokens"))).toBe(true)
    // 关键断言：max_tokens 不是正常结束，不得 emit done
    expect(events.some(ev => ev.type === "done")).toBe(false)
  })

  test("normal end_turn remains a status-only stop reason", async () => {
    const events = await collect([
      { type: "content_block_delta", delta: { type: "text_delta", text: "complete answer" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
    ])

    expect(events.some(ev => ev.type === "status" && String(ev.data).includes("provider-stop: end_turn"))).toBe(true)
    expect(events.some(ev => ev.type === "error")).toBe(false)
  })
})

describe("DeepSeekProvider official endpoint handling", () => {
  test("routes the persisted official API root through the Anthropic-compatible endpoint", async () => {
    let requestedUrl = ""
    const provider = new DeepSeekProvider("test-key", {
      baseURL: "https://api.deepseek.com",
      maxRetries: 0,
      fetch: (async (input: RequestInfo | URL) => {
        requestedUrl = typeof input === "string" ? input : input.toString()
        return new Response("not found", { status: 404 })
      }) as typeof fetch,
    })

    for await (const _event of provider.streamChat({
      model: "deepseek-v4-pro",
      purpose: "agent_main",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      maxTokens: 1,
    })) {
      // Consume the stream so the SDK performs the request.
    }

    expect(requestedUrl).toBe("https://api.deepseek.com/anthropic/v1/messages")
  })
})
