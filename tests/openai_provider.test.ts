import { describe, expect, test } from "bun:test"
import { OpenAIProvider } from "../src/provider/openai"
import { mergeStreamedField, createToolCallAssembler } from "../src/provider/tool-call-assembler"
import { decideProviderFailureRecovery, constrainedToolRecoveryPrompt } from "../src/agent/provider/failure-policy"
import { createRetryLedger } from "../src/runtime/retry-ledger"
import { agentLoop } from "../src/agent/loop"
import { HookEvent, HookSystem } from "../src/hooks"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"

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

  test("preserves tool arguments when a relay repeats the tool id in every chunk", async () => {
    const chunks = [
      {
        id: "chunk_tool_1", object: "chat.completion.chunk", created: 1, model: "test-model",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":' } }] }, finish_reason: null }],
      },
      {
        id: "chunk_tool_2", object: "chat.completion.chunk", created: 1, model: "test-model",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { arguments: '"src/a.ts"}' } }] }, finish_reason: "tool_calls" }],
      },
    ]
    const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 32,
    })) events.push(event)

    expect(events.find(event => event.type === "tool_call")?.data).toEqual({
      id: "call-1", name: "read_file", input: { path: "src/a.ts" },
    })
    expect(events.some(event => event.type === "error")).toBe(false)
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

  test("processes a valid final SSE data line when the relay closes without a trailing newline", async () => {
    const chunk = JSON.stringify({
      id: "chunk_no_newline",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: { content: "complete" }, finish_reason: "stop" }],
    })
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(`data: ${chunk}`, { status: 200 })) as unknown as typeof fetch,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 32,
    })) events.push(event)

    expect(events.some(event => event.type === "done" && event.data === "complete")).toBe(true)
    expect(events.some(event => event.type === "error")).toBe(false)
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
    // GATE-02：finish_reason=length 是 TRUNCATED，不再是 error
    expect(events.some(event => event.type === "error")).toBe(false)
    expect(events.some(event => event.type === "truncated")).toBe(true)
    expect(events.some(event => event.type === "done")).toBe(false)
  })

  test("reports a compat relay max_tokens stop as TRUNCATED (GATE-02 GS-03)", async () => {
    const chunk = JSON.stringify({
      id: "chunk_unknown_stop",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "max_tokens" }],
    })
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200 })) as unknown as typeof fetch,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 32,
    })) events.push(event)

    expect(events.some(event => event.type === "truncated")).toBe(true)
    expect(events.some(event => event.type === "error")).toBe(false)
    expect(events.some(event => event.type === "done")).toBe(false)
  })

  test("emits already-parsed tool calls from a truncated response (GATE-02 GS-05)", async () => {
    const chunk = JSON.stringify({
      id: "chunk_truncated_tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0, id: "call-1", type: "function",
            function: { name: "write_file", arguments: JSON.stringify({ path: "a.ts" }) },
          }],
        },
        finish_reason: "length",
      }],
    })
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200 })) as unknown as typeof fetch,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 32,
    })) events.push(event)

    // 截断前已解析的 tool call 是完整副作用，必须到达执行器而非陪葬
    expect(events.some(event => event.type === "tool_call" && (event.data as { id?: string }).id === "call-1")).toBe(true)
    expect(events.some(event => event.type === "truncated")).toBe(true)
    expect(events.some(event => event.type === "error")).toBe(false)
  })
})

// ── TB2-1: 流式 tool call 组装状态机（重叠/累积快照/交错/repeated id） ──

describe("TB2-1 tool-call assembler (mergeStreamedField)", () => {
  test("重叠增量片段合并（最长前后缀重叠，不重复拼接）", () => {
    // 片段边界重叠 "hi"（2 字符）：chunk2 重复了 chunk1 的尾部。
    const merged = mergeStreamedField('{"cmd":"echo hi', 'hi"}')
    expect(merged).toBe('{"cmd":"echo hi"}')
    expect(() => JSON.parse(merged)).not.toThrow()
  })

  test("累积快照参数（逐轮更长的完整快照）取最终快照", () => {
    const a = mergeStreamedField('{"path":', '{"path":"a.ts"}')
    expect(a).toBe('{"path":"a.ts"}')
    // 更新的快照是超集 → 取更长者。
    const b = mergeStreamedField('{"path":"a.ts"}', '{"path":"a.ts","mode":"r"}')
    expect(b).toBe('{"path":"a.ts","mode":"r"}')
  })

  test("多段重叠（2 段以上）最终 JSON 合法", () => {
    let args = ""
    for (const fragment of ['{"cmd":"grep -n f', 'foo src/a.ts', 'a.ts"}']) {
      args = mergeStreamedField(args, fragment)
    }
    expect(() => JSON.parse(args)).not.toThrow()
    expect(JSON.parse(args)).toEqual({ cmd: "grep -n foo src/a.ts" })
  })

  test("assembler：repeated tool id + 多工具交错 + 无尾换行", async () => {
    // 流末尾没有换行的 SSE 行必须被处理（buffer flush 路径）。
    const chunks = [
      JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":' } }] }, finish_reason: null }] }),
      JSON.stringify({ id: "c2", object: "chat.completion.chunk", created: 1, model: "m",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { arguments: '"src/' } }] }, finish_reason: null }] }),
      JSON.stringify({ id: "c3", object: "chat.completion.chunk", created: 1, model: "m",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call-2", type: "function", function: { name: "write_file", arguments: '{"path":' } }] }, finish_reason: null }] }),
      JSON.stringify({ id: "c4", object: "chat.completion.chunk", created: 1, model: "m",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { arguments: 'a.ts"}' } }] }, finish_reason: null }] }),
      JSON.stringify({ id: "c5", object: "chat.completion.chunk", created: 1, model: "m",
        choices: [{ index: 1, delta: { tool_calls: [{ index: 1, id: "call-2", type: "function", function: { arguments: '"b.ts"}' } }] }, finish_reason: "tool_calls" }] }),
    ]
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(`data: ${chunks[0]}\n\ndata: ${chunks[1]}\n\ndata: ${chunks[2]}\n\ndata: ${chunks[3]}\n\ndata: ${chunks[4]}`, { status: 200 })) as unknown as typeof fetch,
    })

    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of provider.streamChat({
      model: "test-model", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 32,
    })) events.push(event)

    const calls = events.filter(e => e.type === "tool_call").map(e => e.data)
    expect(calls).toEqual([
      { id: "call-1", name: "read_file", input: { path: "src/a.ts" } },
      { id: "call-2", name: "write_file", input: { path: "b.ts" } },
    ])
    expect(events.some(e => e.type === "error")).toBe(false)
  })
})

// ── TB2-1: fail-closed——坏批次绝不部分执行副作用工具 ──

describe("TB2-1 fail-closed tool batch", () => {
  test("多工具批次有一个损坏 → 前面的副作用工具也不执行（无 tool_call 事件）", async () => {
    const chunk = JSON.stringify({
      id: "chunk_bad_batch", object: "chat.completion.chunk", created: 1, model: "m",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: "call-ok", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts"}' } },
            { index: 1, id: "call-bad", type: "function", function: { name: "write_file", arguments: "{broken" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
    })
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200 })) as unknown as typeof fetch,
    })
    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of provider.streamChat({
      model: "test-model", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 32,
    })) events.push(event)

    expect(events.some(e => e.type === "tool_call")).toBe(false)
    expect(events.some(e => e.type === "error" && String(e.data).includes("invalid tool call JSON"))).toBe(true)
    // 脱敏诊断存在（哈希/计数，无原始参数）。
    const diag = events.find(e => e.type === "error")!
    expect(String(diag.data)).toContain("argSha256=")
    expect(String(diag.data)).not.toContain("{broken")
  })

  test("截断响应中 repair 过的调用绝不执行（勉强补括号 ≠ 完整副作用）", async () => {
    const chunk = JSON.stringify({
      id: "chunk_trunc_incomplete", object: "chat.completion.chunk", created: 1, model: "m",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: "call-cut", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts"' } }],
        },
        finish_reason: "length",
      }],
    })
    const provider = new OpenAIProvider("test-key", {
      maxRetries: 0,
      fetch: (async () => new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200 })) as unknown as typeof fetch,
    })
    const events: Array<{ type: string; data?: unknown }> = []
    for await (const event of provider.streamChat({
      model: "test-model", system: "", messages: [{ role: "user", content: "hello" }], maxTokens: 32,
    })) events.push(event)

    expect(events.some(e => e.type === "tool_call")).toBe(false)
    expect(events.some(e => e.type === "truncated")).toBe(true)
    const truncated = events.find(e => e.type === "truncated")!
    expect((truncated.data as { toolCalls: number }).toolCalls).toBe(0)
  })
})

// ── TB2-1: invalid JSON 受约束恢复（最多一次） ──

describe("TB2-1 constrained tool-protocol recovery", () => {
  test("failure-policy：第一次受约束恢复 continue + reduceThinking；第二次立即 break", () => {
    const ledger = createRetryLedger()
    const failure = {
      message: "provider returned invalid tool call JSON for write_file\ntool-protocol: tool_protocol_invalid_json requestId=…",
      retryable: false,
      yielded: true,
      kind: "tool_protocol_invalid_json",
    }
    const first = decideProviderFailureRecovery({
      failure, round: 1, maxRounds: 4, finalText: "", taskTracker: null, changedFiles: [], retryLedger: ledger,
    })
    expect(first.action).toBe("continue")
    expect(first.reduceThinking).toBe(true)
    const prompt = first.messages[0]!.content as string
    expect(prompt).toContain("只重发一个工具调用")
    expect(prompt).toContain("禁止重新规划")

    const second = decideProviderFailureRecovery({
      failure, round: 2, maxRounds: 4, finalText: "", taskTracker: null, changedFiles: [], retryLedger: ledger,
    })
    expect(second.action).toBe("break")
  })

  test("连续两次 invalid JSON → 立即 provider_failure（kernel 集成，不再烧剩余轮次）", async () => {
    const savedTriage = process.env.ORCANA_FLASH_TRIAGE
    process.env.ORCANA_FLASH_TRIAGE = "off"
    try {
    class InvalidJsonProvider implements LLMProvider {
      rounds = 0
      async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        this.rounds++
        yield { type: "error", data: "provider returned invalid tool call JSON for write_file\ntool-protocol: tool_protocol_invalid_json requestId=test" }
      }
    }
    const stopReasons: string[] = []
    const hooks = new HookSystem()
    hooks.on(HookEvent.Stop, input => {
      stopReasons.push(input.reason)
      return {}
    })
    const provider = new InvalidJsonProvider()
    const events: StreamEvent[] = []
    let decision: unknown
    const iterator = agentLoop("inspect the project state", {
      provider,
      model: "test",
      tools: [],
      hooks,
      contextMapPolicy: "off",
      maxRounds: 8,
    })[Symbol.asyncIterator]()
    while (true) {
      const step = await iterator.next()
      if (step.done) { decision = step.value; break }
      events.push(step.value)
    }

    expect(provider.rounds).toBe(2) // 1 次受约束恢复 + 1 次失败 → 不再继续
    expect(decision).toMatchObject({ kind: "break", reason: "provider_failure" })
    expect(stopReasons).toEqual(["error"])
    expect(events.some(e => e.type === "status" && String(e.data).includes("constrained recovery"))).toBe(true)
    expect(events.some(e => e.type === "status" && String(e.data).includes("failed after one constrained recovery"))).toBe(true)
    } finally {
      if (savedTriage === undefined) delete process.env.ORCANA_FLASH_TRIAGE
      else process.env.ORCANA_FLASH_TRIAGE = savedTriage
    }
  })
})
