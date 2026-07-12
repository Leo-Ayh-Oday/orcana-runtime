import { describe, expect, test } from "bun:test"
import { OpenAIProvider } from "../src/provider/openai"

function emptyStreamResponse(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("OpenAIProvider message conversion", () => {
  test("accepts either an API root or a full chat completions endpoint", async () => {
    const requested: string[] = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return emptyStreamResponse()
    }) as typeof fetch
    const options = {
      model: "test-model",
      system: "",
      messages: [{ role: "user" as const, content: "hello" }],
      maxTokens: 32,
    }

    for (const baseURL of ["https://relay.test/v1/", "https://relay.test/v1/chat/completions"]) {
      const provider = new OpenAIProvider("test-key", { baseURL, fetch: fetchFn })
      for await (const _event of provider.streamChat(options)) {
        // Consume the stream so the request URL is captured.
      }
    }

    expect(requested).toEqual([
      "https://relay.test/v1/chat/completions",
      "https://relay.test/v1/chat/completions",
    ])
  })

  test("sends Anthropic-style tool results as OpenAI tool messages", async () => {
    let requestBody: Record<string, unknown> | undefined
    const provider = new OpenAIProvider("test-key", {
      baseURL: "https://example.test/v1",
      maxRetries: 0,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return emptyStreamResponse()
      }) as typeof fetch,
    })

    for await (const _event of provider.streamChat({
      model: "test-model",
      system: "system",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "file contents" }],
        },
      ],
      tools: [],
      maxTokens: 32,
    })) {
      // Consume the provider stream so the request is captured.
    }

    expect(requestBody?.messages).toEqual([
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
    ])
  })

  test("forwards JSON Schema response format to compatible providers", async () => {
    let requestBody: Record<string, unknown> | undefined
    const provider = new OpenAIProvider("test-key", {
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return emptyStreamResponse()
      }) as typeof fetch,
    })
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    }

    for await (const _event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "return json" }],
      maxTokens: 32,
      responseFormat: { type: "json_schema", name: "result", schema, strict: true },
    })) {
      // Consume the provider stream so the request is captured.
    }

    expect(requestBody?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "result", schema, strict: true },
    })
  })
})

describe("OpenAIProvider stop reason handling", () => {
  test("reports length truncation instead of completing normally", async () => {
    const chunk = JSON.stringify({
      id: "chunk_1",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: { content: "partial answer" }, finish_reason: "length" }],
    })
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as typeof fetch,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      maxTokens: 32,
    })) {
      events.push(event)
    }

    expect(events.some(event => event.type === "text" && event.data === "partial answer")).toBe(true)
    expect(events.some(event => event.type === "error" && String(event.data).includes("length"))).toBe(true)
    expect(events.some(event => event.type === "done")).toBe(false)
  })
})
