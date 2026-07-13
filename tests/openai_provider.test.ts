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
  test("emits real nested cache usage from OpenAI-compatible relays", async () => {
    const chunk = JSON.stringify({
      id: "chunk_usage",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: { content: "complete" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 50,
        total_tokens: 1_050,
        prompt_tokens_details: { cached_tokens: 750 },
      },
    })
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200 })) as unknown as typeof fetch,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 32,
    })) events.push(event)

    const usage = events.find(event => event.type === "token_usage")?.data as Record<string, unknown> | undefined
    expect(usage?.cacheReadInputTokens).toBe(750)
    expect(usage?.cacheMissInputTokens).toBe(250)
    expect(usage?.cacheHitRate).toBe(75)
  })

  test("does not treat a malformed SSE chunk followed by DONE as a complete response", async () => {
    const valid = JSON.stringify({
      id: "chunk_partial",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
    })
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(
        `data: ${valid}\n\ndata: {broken-json\n\ndata: [DONE]\n\n`,
        { status: 200 },
      )) as unknown as typeof fetch,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
    })) events.push(event)

    expect(events.some(event => event.type === "error" && String(event.data).includes("malformed SSE"))).toBe(true)
    expect(events.some(event => event.type === "done")).toBe(false)
  })

  test("does not execute an irreparable streamed tool call payload", async () => {
    const chunk = JSON.stringify({
      id: "chunk_tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "bad", type: "function", function: { name: "write_file", arguments: "not-json" } }] },
        finish_reason: "tool_calls",
      }],
    })
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200 })) as unknown as typeof fetch,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
    })) events.push(event)

    expect(events.some(event => event.type === "error" && String(event.data).includes("invalid tool call JSON"))).toBe(true)
    expect(events.some(event => event.type === "tool_call")).toBe(false)
  })

  test("accepts relay SSE data fields without a space after the colon", async () => {
    const chunk = JSON.stringify({
      id: "chunk_relay",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: { content: "complete" }, finish_reason: "stop" }],
    })
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(`data:${chunk}\n\ndata:[DONE]\n\n`, { status: 200 })) as unknown as typeof fetch,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
    })) events.push(event)

    expect(events.some(event => event.type === "text" && event.data === "complete")).toBe(true)
    expect(events.some(event => event.type === "done" && event.data === "complete")).toBe(true)
  })

  test("reports a clean EOF without a terminal signal as an interrupted stream", async () => {
    const chunk = JSON.stringify({
      id: "chunk_partial",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: { content: "partial answer" }, finish_reason: null }],
    })
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(`data: ${chunk}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
    })) events.push(event)

    expect(events.some(event => event.type === "error" && String(event.data).includes("ended unexpectedly"))).toBe(true)
    expect(events.some(event => event.type === "done")).toBe(false)
  })

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
