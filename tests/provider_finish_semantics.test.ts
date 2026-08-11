/** IC03: Provider Finish Semantics —— 结构化 finish 事件矩阵。
 *
 *  三个 production Provider（DeepSeek / Anthropic / OpenAI）每个 round 必须
 *  exactly-once 产生结构化 finish（ProviderFinishInfo），上层 control-flow
 *  只消费 ProviderFinishReason（不猜字符串）。
 *
 *  全部测试完全 mock：无网络、无 sleep、确定性。
 */

import { describe, expect, test } from "bun:test"
import { DeepSeekProvider } from "../src/provider/deepseek"
import { AnthropicProvider } from "../src/provider/anthropic"
import { OpenAIProvider } from "../src/provider/openai"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"
import { failureFromProviderFinish } from "../src/agent/provider/failure-policy"
import { runProviderRound } from "../src/agent/provider/round-runner"
import type { ProviderRoundResult } from "../src/agent/provider/round-result"

// ── helpers ──

function fakeClient(events: unknown[]) {
  return {
    messages: {
      stream: async function* () {
        for (const event of events) yield event
      },
    },
  }
}

interface CollectOut {
  events: StreamEvent[]
  /** Provider 原始流中的 finish 事件（exactly-one 验证）。 */
  providerFinishes: Array<Record<string, unknown>>
  /** Runner 对外事件流（finish 不透传——结果由 result 承载）。 */
  runnerFinishes: number
  toolCallCount: number
  result: ProviderRoundResult
}

async function collectProvider(
  make: (events: unknown[]) => LLMProvider,
  events: unknown[],
  opts: Partial<ProviderCallOptions> = {},
  abortSignal?: AbortSignal,
): Promise<CollectOut> {
  // Provider 原始流（不经 runner）——统计 exactly-once finish。
  const rawEvents: StreamEvent[] = []
  for await (const e of make(events).streamChat({
    model: "test",
    purpose: "agent_main",
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    maxTokens: 1024,
    ...opts,
    abortSignal,
  })) rawEvents.push(e)

  // Runner 路径（同一事件数组的新 provider 实例 —— 流是一次性的）。
  const outEvents: StreamEvent[] = []
  const iterator = runProviderRound({
    provider: make(events),
    request: {
      model: "test",
      purpose: "agent_main",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      maxTokens: 1024,
      ...opts,
    },
    bufferText: true,
    abortSignal,
  })
  let result: ProviderRoundResult | undefined
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      result = next.value
      break
    }
    outEvents.push(next.value)
  }
  const providerFinishes = rawEvents.filter(e => e.type === "finish").map(e => (e.data ?? {}) as Record<string, unknown>)
  const runnerFinishes = outEvents.filter(e => e.type === "finish").length
  const toolCallCount = outEvents.filter(e => e.type === "tool_call").length
  return { events: outEvents, providerFinishes, runnerFinishes, toolCallCount, result: result! }
}

const TOOL_BLOCKS = [
  { type: "content_block_start", content_block: { type: "tool_use", id: "call-1", name: "write_file", input: {} } },
  { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
  { type: "content_block_stop" },
]

const THINKING_EVENTS = [
  { type: "content_block_start", content_block: { type: "thinking", signature: "s1" } },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "think" } },
  { type: "content_block_stop" },
]

function maxTokensStop(): unknown {
  return { type: "message_delta", delta: { stop_reason: "max_tokens" } }
}

function endTurnStop(): unknown {
  return { type: "message_delta", delta: { stop_reason: "end_turn" } }
}

function toolUseStop(): unknown {
  return { type: "message_delta", delta: { stop_reason: "tool_use" } }
}

function stopSequenceStop(): unknown {
  return { type: "message_delta", delta: { stop_reason: "stop_sequence" } }
}

// ── DeepSeek + Anthropic（同一 Anthropic 流语义表）──

const ANTHROPIC_LIKE_CASES: Array<{ name: string; events: unknown[]; expect: { finishReason: import("../src/provider/types").ProviderFinishReason; partial?: boolean; toolCount?: number; emittedTools: number; rawStop?: string } }> = [
  {
    // D1: thinking → max_tokens → no tool
    name: "max_tokens / no action",
    events: [...THINKING_EVENTS, { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }, maxTokensStop()],
    expect: { finishReason: "truncated_before_action", emittedTools: 0, rawStop: "max_tokens" },
  },
  {
    // D2: thinking → completed tool → max_tokens
    name: "max_tokens / completed action",
    events: [...TOOL_BLOCKS, maxTokensStop()],
    expect: { finishReason: "truncated_after_action", toolCount: 1, emittedTools: 1, rawStop: "max_tokens" },
  },
  {
    // D3: thinking → partial tool → max_tokens
    name: "max_tokens / partial action",
    events: [
      { type: "content_block_start", content_block: { type: "tool_use", id: "call-part", name: "write_file", input: {} } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"path":' } },
      maxTokensStop(),
    ],
    expect: { finishReason: "truncated_partial_tool", partial: true, emittedTools: 0, rawStop: "max_tokens" },
  },
  {
    // D4: tool_use
    name: "tool_use",
    events: [...TOOL_BLOCKS, toolUseStop()],
    expect: { finishReason: "tool_action", toolCount: 1, emittedTools: 1, rawStop: "tool_use" },
  },
  {
    // D5: end_turn
    name: "end_turn",
    events: [{ type: "content_block_delta", delta: { type: "text_delta", text: "done" } }, endTurnStop()],
    expect: { finishReason: "complete", emittedTools: 0, rawStop: "end_turn" },
  },
  {
    // D6: stop_sequence
    name: "stop_sequence",
    events: [{ type: "content_block_delta", delta: { type: "text_delta", text: "done" } }, stopSequenceStop()],
    expect: { finishReason: "complete", emittedTools: 0, rawStop: "stop_sequence" },
  },
]

for (const [providerName, makeProvider] of [
  ["DeepSeek", (events: unknown[]) => new DeepSeekProvider("test-key", { client: fakeClient(events) })],
  ["Anthropic", (events: unknown[]) => new AnthropicProvider("test-key", { client: fakeClient(events) })],
] as const) {
  describe(`IC03 ${providerName} finish matrix`, () => {
    for (const c of ANTHROPIC_LIKE_CASES) {
      test(c.name, async () => {
        const out = await collectProvider(makeProvider, c.events)
        // exactly-one structured finish（provider 原始流）
        expect(out.providerFinishes).toHaveLength(1)
        expect(out.providerFinishes[0]!.finishReason).toBe(c.expect.finishReason)
        if (c.expect.partial !== undefined) expect(out.providerFinishes[0]!.partialToolCall).toBe(c.expect.partial)
        if (c.expect.toolCount !== undefined) expect(out.providerFinishes[0]!.completedToolCallCount).toBe(c.expect.toolCount)
        if (c.expect.rawStop !== undefined) expect(out.providerFinishes[0]!.rawStopReason).toBe(c.expect.rawStop)
        // runner 不透传 finish（结果由 result 承载）
        expect(out.runnerFinishes).toBe(0)
        // 事件流 tool_call 计数 = 声明（partial 批次 0 执行）
        expect(out.toolCallCount).toBe(c.expect.emittedTools)
        // RoundRunner 结构化结果
        expect(out.result.finishReason).toBe(c.expect.finishReason)
        expect(out.result.partialToolCall).toBe(c.expect.partial ?? false)
        expect(out.result.toolCalls.length).toBe(c.expect.toolCount ?? c.expect.emittedTools)
        // truncation 不是 failure
        expect(out.result.failure).toBeUndefined()
      })
    }

    test("abort → cancelled", async () => {
      const controller = new AbortController()
      const p = collectProvider(makeProvider, [{ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } }], {}, controller.signal)
      // 确定性：先让 stream 开始，再 abort。
      controller.abort()
      const out = await p
      expect(out.providerFinishes).toHaveLength(1)
      expect(out.providerFinishes[0]!.finishReason).toBe("cancelled")
      expect(out.result.finishReason).toBe("cancelled")
    })

    test("partial batch: complete A + partial B + max_tokens → 0 executed tools", async () => {
      const out = await collectProvider(makeProvider, [
        ...TOOL_BLOCKS, // A 完整
        { type: "content_block_start", content_block: { type: "tool_use", id: "call-B", name: "write_file", input: {} } },
        { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"path":' } },
        maxTokensStop(),
      ])
      expect(out.providerFinishes).toHaveLength(1)
      expect(out.providerFinishes[0]!.finishReason).toBe("truncated_partial_tool")
      expect(out.providerFinishes[0]!.partialToolCall).toBe(true)
      expect(out.providerFinishes[0]!.completedToolCallCount).toBe(1) // A 已 closed（observed）
      // PARTIAL_TOOL_CALL_EXECUTED = 0：本批次 0 个 tool_call / 0 可执行。
      expect(out.toolCallCount).toBe(0)
      expect(out.result.toolCalls.length).toBe(0)
      expect(out.result.partialToolCall).toBe(true)
    })

    test("exactly-once: completed tool + max_tokens → tool_call id appears exactly once", async () => {
      const out = await collectProvider(makeProvider, [...TOOL_BLOCKS, maxTokensStop()])
      const ids = out.events.filter(e => e.type === "tool_call").map(e => (e.data as { id: string }).id)
      expect(ids).toEqual(["call-1"])
      expect(out.result.toolCalls.map(tc => tc.id)).toEqual(["call-1"])
    })
  })
}

// ── OpenAI SSE ──

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

function openaiChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
}

const DONE = "data: [DONE]\n\n"

const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
  // mock 响应 abortSignal：abort → reader error（真实 fetch 行为）。
  const signal = (init as { signal?: AbortSignal } | undefined)?.signal
  const chunks = (init as { _ic03Chunks?: string[] } | undefined)?._ic03Chunks ?? []
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => controller.error(new DOMException("aborted", "AbortError"))
      signal?.addEventListener("abort", onAbort, { once: true })
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
      if (!signal?.aborted) controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
}) as unknown as typeof fetch

function openaiProvider(chunks: string[]): OpenAIProvider {
  return new OpenAIProvider("test-key", {
    baseURL: "https://test.local/v1",
    fetch: ((_url: string | URL | Request, init?: RequestInit) => fetchImpl(_url, Object.assign({}, init, { _ic03Chunks: chunks }) as RequestInit)) as unknown as typeof fetch,
    sleep: async () => {},
  })
}

const makeOpenAI = (chunks: unknown[]): LLMProvider => openaiProvider(chunks as string[])

describe("IC03 OpenAI finish matrix", () => {
  test("O1: finish_reason=length + no tool → truncated_before_action", async () => {
    const out = await collectProvider(makeOpenAI, [
      openaiChunk({ content: "partial text" }, null),
      openaiChunk({}, "length"),
      DONE,
    ])
    expect(out.providerFinishes).toHaveLength(1)
    expect(out.providerFinishes[0]!.finishReason).toBe("truncated_before_action")
    expect(out.providerFinishes[0]!.rawStopReason).toBe("length")
    expect(out.toolCallCount).toBe(0)
    expect(out.result.failure).toBeUndefined()
  })

  test("O2: finish_reason=length + complete tool → truncated_after_action + exactly one tool", async () => {
    const out = await collectProvider(makeOpenAI, [
      openaiChunk({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts"}' } }] }, null),
      openaiChunk({}, "length"),
      DONE,
    ])
    expect(out.providerFinishes).toHaveLength(1)
    expect(out.providerFinishes[0]!.finishReason).toBe("truncated_after_action")
    expect(out.providerFinishes[0]!.completedToolCallCount).toBe(1)
    expect(out.providerFinishes[0]!.partialToolCall).toBe(false)
    expect(out.toolCallCount).toBe(1)
    expect(out.result.toolCalls.map(tc => tc.id)).toEqual(["call-1"])
  })

  test("O3: finish_reason=length + partial tool（截断 JSON，仅 repair 才合法）→ truncated_partial_tool + 0 tool", async () => {
    const out = await collectProvider(makeOpenAI, [
      openaiChunk({ tool_calls: [{ index: 0, id: "call-p", type: "function", function: { name: "write_file", arguments: '{"path":' } }] }, null),
      openaiChunk({}, "length"),
      DONE,
    ])
    expect(out.providerFinishes).toHaveLength(1)
    expect(out.providerFinishes[0]!.finishReason).toBe("truncated_partial_tool")
    expect(out.providerFinishes[0]!.partialToolCall).toBe(true)
    // 截断后补括号不是 Provider 已完成的真实副作用声明 → 0 执行。
    expect(out.toolCallCount).toBe(0)
    expect(out.result.toolCalls.length).toBe(0)
  })

  test("O4: finish_reason=tool_calls → tool_action", async () => {
    const out = await collectProvider(makeOpenAI, [
      openaiChunk({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts"}' } }] }, null),
      openaiChunk({}, "tool_calls"),
      DONE,
    ])
    expect(out.providerFinishes[0]!.finishReason).toBe("tool_action")
    expect(out.result.toolCalls.length).toBe(1)
  })

  test("O5: finish_reason=stop → complete", async () => {
    const out = await collectProvider(makeOpenAI, [
      openaiChunk({ content: "final answer" }, null),
      openaiChunk({}, "stop"),
      DONE,
    ])
    expect(out.providerFinishes[0]!.finishReason).toBe("complete")
    expect(out.result.finalText).toContain("final answer")
  })

  test("O6: [DONE] compatibility（无显式 finish_reason，有 tool）→ tool_action", async () => {
    const out = await collectProvider(makeOpenAI, [
      openaiChunk({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts"}' } }] }, null),
      DONE,
    ])
    expect(out.providerFinishes).toHaveLength(1)
    expect(out.providerFinishes[0]!.finishReason).toBe("tool_action")
  })

  test("O7: abort → cancelled", async () => {
    const controller = new AbortController()
    const p = collectProvider(makeOpenAI, [openaiChunk({ content: "hi" }, null)], {}, controller.signal)
    controller.abort()
    const out = await p
    expect(out.providerFinishes).toHaveLength(1)
    expect(out.providerFinishes[0]!.finishReason).toBe("cancelled")
  })
})

// ── typed failure mapping（IC03 §19）──

describe("IC03 failure mapping", () => {
  test("truncated_* 不进入 ProviderFailure", () => {
    expect(failureFromProviderFinish("truncated_before_action")).toBeUndefined()
    expect(failureFromProviderFinish("truncated_after_action")).toBeUndefined()
    expect(failureFromProviderFinish("truncated_partial_tool")).toBeUndefined()
    expect(failureFromProviderFinish("complete")).toBeUndefined()
    expect(failureFromProviderFinish("tool_action")).toBeUndefined()
  })

  test("transport → retryable；auth/quota/malformed/cancelled → non-retryable", () => {
    expect(failureFromProviderFinish("transport_failure")?.retryable).toBe(true)
    expect(failureFromProviderFinish("auth_failure")?.retryable).toBe(false)
    expect(failureFromProviderFinish("quota_failure")?.retryable).toBe(false)
    expect(failureFromProviderFinish("malformed")?.retryable).toBe(false)
    expect(failureFromProviderFinish("cancelled")?.retryable).toBe(false)
  })
})
