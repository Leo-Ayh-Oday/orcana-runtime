/** RC-19 Phase 1 fault baseline — Provider Side-Effect Safety.
 *
 *  Invariants:
 *    G3  DUPLICATE_PROVIDER_SIDE_EFFECT — a stream that already emitted text /
 *        thinking / tool calls must never be auto-replayed by a retry.
 *    NEW ABORT_RETRIED                  — an aborted request must never be
 *        retried, including abort landing during retry backoff.
 *    NEW STREAM_REPLAY_SIDE_EFFECT      — partial output (thinking deltas) makes
 *        a stream non-replayable.
 *    NEW DUPLICATE_TOOL_CALL_EXECUTED   — a completed tool call must never be
 *        executed twice because a later round re-issues the same call id.
 *
 *  Fault seeds (directive §5.4): stream reset after full tool call, provider
 *  500 after tool JSON, client retry after tool executed, abort during backoff,
 *  text cut, thinking cut, 429/500 before any output.
 *
 *  Counter discipline: any fault seed that drives the non-idempotent
 *  increment_counter tool above 1 is a P0 FAIL.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { OpenAIProvider } from "../../src/provider/openai"
import { DeepSeekProvider } from "../../src/provider/deepseek"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../../src/provider/types"
import { runProviderRound } from "../../src/agent/provider/round-runner"
import { createAgentHarness } from "../../src/harness/runtime/agent-harness"
import { buildTools, Result } from "../../src/tools/registry"

const encoder = new TextEncoder()

const SAVED_ORCANA_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"
afterAll(() => {
  if (SAVED_ORCANA_FLASH_TRIAGE === undefined) delete process.env.ORCANA_FLASH_TRIAGE
  else process.env.ORCANA_FLASH_TRIAGE = SAVED_ORCANA_FLASH_TRIAGE
})

function openaiChunk(fields: {
  content?: string
  toolCalls?: Array<{ index: number; id?: string; name?: string; args?: string }>
  finish?: string | null
}): string {
  return JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        ...(fields.content !== undefined ? { content: fields.content } : {}),
        ...(fields.toolCalls ? { tool_calls: fields.toolCalls.map(tc => ({
          index: tc.index,
          ...(tc.id ? { id: tc.id } : {}),
          type: "function",
          function: { ...(tc.name ? { name: tc.name } : {}), ...(tc.args !== undefined ? { arguments: tc.args } : {}) },
        })) } : {}),
      },
      finish_reason: fields.finish ?? null,
    }],
  })
}

function openaiStreamResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200 })
}

function sse(chunk: string): Uint8Array {
  return encoder.encode(`data: ${chunk}\n\n`)
}

// ── Fault seed: abort during retry backoff ──

describe("ABORT_RETRIED", () => {
  test("abort landing during backoff must stop the request — never another fetch", async () => {
    let fetchCount = 0
    const ac = new AbortController()
    const fetchFn = (async () => {
      fetchCount += 1
      return new Response("rate limited", { status: 429 })
    }) as unknown as typeof fetch

    const provider = new OpenAIProvider("test-key", {
      maxRetries: 3,
      sleep: async () => { ac.abort() }, // abort during the first backoff
      fetch: fetchFn,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
      abortSignal: ac.signal,
    })) events.push(event)

    // After the abort lands, the provider must NOT issue another fetch.
    expect(fetchCount).toBe(1)
    expect(events.some(e => e.type === "error")).toBe(true)
  })

  test("abort before the request: no fetch at all", async () => {
    let fetchCount = 0
    const ac = new AbortController()
    ac.abort()
    const fetchFn = (async () => {
      fetchCount += 1
      return new Response(`data: ${openaiChunk({ content: "late" })}\n\ndata: [DONE]\n\n`, { status: 200 })
    }) as unknown as typeof fetch

    const provider = new OpenAIProvider("test-key", {
      maxRetries: 2,
      sleep: async () => {},
      fetch: fetchFn,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
      abortSignal: ac.signal,
    })) events.push(event)

    expect(fetchCount).toBe(0)
    expect(events.some(e => e.type === "error")).toBe(true)
  })
})

// ── Fault seed: thinking emitted, then stream cut (DeepSeek) ──

describe("STREAM_REPLAY_SIDE_EFFECT (thinking cut)", () => {
  function thinkingThenCutClient() {
    let streamCalls = 0
    const client = {
      messages: {
        stream() {
          streamCalls += 1
          let step = 0
          const iterator: AsyncIterable<unknown> = {
            async *[Symbol.asyncIterator]() {
              yield { type: "content_block_start", content_block: { type: "thinking", thinking: "" } }
              yield { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "let me reason about this" } }
              yield { type: "content_block_delta", delta: { type: "thinking_delta", thinking: " more" } }
              step = 3
              throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
            },
          }
          return { ...iterator, abort: () => {}, return: () => Promise.resolve(undefined) }
        },
      },
    }
    return { client, streamCalls: () => streamCalls }
  }

  test("a thinking stream cut mid-stream must not auto-retry (replay duplicates thinking)", async () => {
    const { client, streamCalls } = thinkingThenCutClient()
    const provider = new DeepSeekProvider("test-key", {
      client: client as never,
      maxRetries: 2,
      sleep: async () => {},
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "deepseek-v4",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
    })) events.push(event)

    expect(streamCalls()).toBe(1)
    expect(events.some(e => e.type === "error")).toBe(true)
  })
})

// ── Fault seed: full tool JSON then provider 500 / stream reset ──

describe("DUPLICATE_PROVIDER_SIDE_EFFECT (tool-call streams)", () => {
  test("complete tool call JSON then 500 mid-stream: no retry, no tool_call event, one fetch", async () => {
    let fetchCount = 0
    const chunk1 = openaiChunk({ toolCalls: [{ index: 0, id: "call-1", name: "increment_counter", args: "{}" }] })
    const chunk2 = openaiChunk({ toolCalls: [{ index: 0, args: "{\"amount\":1}" }] })
    const fetchFn = (async () => {
      fetchCount += 1
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse(chunk1))
          controller.enqueue(sse(chunk2))
          setTimeout(() => controller.error(Object.assign(new Error("upstream 500"), { status: 500 })), 5)
        },
      })
      return openaiStreamResponse(stream)
    }) as unknown as typeof fetch

    const provider = new OpenAIProvider("test-key", {
      maxRetries: 2,
      sleep: async () => {},
      fetch: fetchFn,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
    })) events.push(event)

    expect(fetchCount).toBe(1)
    // A partial tool stream must not surface a tool_call (nothing executes).
    expect(events.some(e => e.type === "tool_call")).toBe(false)
    expect(events.some(e => e.type === "error")).toBe(true)
  })

  test("complete tool call JSON then stream reset: same guarantee", async () => {
    let fetchCount = 0
    const chunk = openaiChunk({ toolCalls: [{ index: 0, id: "call-1", name: "increment_counter", args: "{\"amount\":1}" }] })
    const fetchFn = (async () => {
      fetchCount += 1
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse(chunk))
          setTimeout(() => controller.error(new Error("socket connection was closed")), 5)
        },
      })
      return openaiStreamResponse(stream)
    }) as unknown as typeof fetch

    const provider = new OpenAIProvider("test-key", {
      maxRetries: 2,
      sleep: async () => {},
      fetch: fetchFn,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
    })) events.push(event)

    expect(fetchCount).toBe(1)
    expect(events.some(e => e.type === "tool_call")).toBe(false)
    expect(events.some(e => e.type === "error")).toBe(true)
  })
})

// ── Fault seed: text emitted then stream cut ──

describe("DUPLICATE_PROVIDER_SIDE_EFFECT (text streams)", () => {
  test("text emitted then stream cut: no retry", async () => {
    let fetchCount = 0
    const fetchFn = (async () => {
      fetchCount += 1
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse(openaiChunk({ content: "partial answer" })))
          setTimeout(() => controller.error(new Error("socket connection was closed unexpectedly")), 5)
        },
      })
      return openaiStreamResponse(stream)
    }) as unknown as typeof fetch

    const provider = new OpenAIProvider("test-key", {
      maxRetries: 2,
      sleep: async () => {},
      fetch: fetchFn,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
    })) events.push(event)

    expect(fetchCount).toBe(1)
    expect(events.some(e => e.type === "error")).toBe(true)
  })
})

// ── Safe retries: 429 / 500 before any output ──

describe("safe pre-output retries", () => {
  test("429 before any output retries then succeeds", async () => {
    let fetchCount = 0
    const fetchFn = (async () => {
      fetchCount += 1
      if (fetchCount === 1) return new Response("rate limited", { status: 429 })
      return new Response(`data: ${openaiChunk({ content: "recovered" })}\n\ndata: [DONE]\n\n`, { status: 200 })
    }) as unknown as typeof fetch

    const provider = new OpenAIProvider("test-key", {
      maxRetries: 2,
      sleep: async () => {},
      fetch: fetchFn,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
    })) events.push(event)

    expect(fetchCount).toBe(2)
    expect(events.filter(e => e.type === "text").map(e => e.data)).toEqual(["recovered"])
  })

  test("500 before any output retries then succeeds", async () => {
    let fetchCount = 0
    const fetchFn = (async () => {
      fetchCount += 1
      if (fetchCount === 1) return new Response("upstream down", { status: 503 })
      return new Response(`data: ${openaiChunk({ content: "ok" })}\n\ndata: [DONE]\n\n`, { status: 200 })
    }) as unknown as typeof fetch

    const provider = new OpenAIProvider("test-key", {
      maxRetries: 2,
      sleep: async () => {},
      fetch: fetchFn,
    })

    const events = []
    for await (const event of provider.streamChat({
      model: "test-model",
      system: "",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 32,
    })) events.push(event)

    expect(fetchCount).toBe(2)
    expect(events.some(e => e.type === "error")).toBe(false)
  })
})

// ── Round runner: once a tool_call is delivered, abort must not re-stream ──

describe("round runner replay safety", () => {
  test("abort after tool_call delivery closes the iterator and never re-invokes the provider", async () => {
    let streamChatCalls = 0
    const ac = new AbortController()
    const provider: LLMProvider = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        streamChatCalls += 1
        yield { type: "tool_call", data: { id: "tc-1", name: "increment_counter", input: {} } }
        await new Promise(() => {}) // never resolves on its own; abort must release us
      },
    }

    const runnerPromise = (async () => {
      const result: unknown[] = []
      for await (const event of runProviderRound({
        provider,
        request: { model: "m", system: "", messages: [], maxTokens: 8 },
        abortSignal: ac.signal,
        bufferText: true,
      })) result.push(event)
      return result
    })()

    // Let the tool_call land, then abort.
    await new Promise(resolve => setTimeout(resolve, 20))
    ac.abort()

    const events = await runnerPromise
    expect(streamChatCalls).toBe(1)
    expect(events.some(e => (e as StreamEvent).type === "tool_call")).toBe(true)
  })
})

// ── DUPLICATE_TOOL_CALL_EXECUTED: a broken provider re-issues the SAME call
//    id in a later round — the kernel must not execute it twice ──

describe("DUPLICATE_TOOL_CALL_EXECUTED", () => {
  test("re-issued tool call id is not executed twice (increment_counter stays 1)", async () => {
    let counter = 0
    const tools = buildTools({
      name: "increment_counter",
      description: "non-idempotent counter",
      // Test-only: readable declaration so the harness risk policy does not
      // deny an unknown tool; execution still increments the real counter.
      isReadonly: true,
      isConcurrencySafe: true,
      inputSchema: { type: "object", properties: { amount: { type: "number" } } },
      execute() {
        counter += 1
        return Result.ok(`counter=${counter}`)
      },
    })

    class ReplayToolCallProvider implements LLMProvider {
      calls = 0
      async *streamChat(_options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
        const call = this.calls++
        if (call === 0) {
          yield { type: "tool_call", data: { id: "tc-1", name: "increment_counter", input: { amount: 1 } } }
          return
        }
        // Round 2+ re-issues the SAME call id — a client-side replay of the
        // previous round's request. Executing it again is a P0 duplicate.
        yield { type: "tool_call", data: { id: "tc-1", name: "increment_counter", input: { amount: 1 } } }
        yield { type: "done", data: "done" }
      }
    }

    const provider = new ReplayToolCallProvider()
    const harness = createAgentHarness({ deps: { provider, tools }, sessionId: "sess-side-effect" })
    const session = await harness.createSession()
    const events: unknown[] = []
    for await (const event of harness.run(session.sessionId, { prompt: "count", maxRounds: 3 })) {
      events.push(event)
    }
    expect(counter).toBe(1)
  })
})
