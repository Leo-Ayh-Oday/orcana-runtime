/** RC-14 G3: a provider stream that already produced text/tool calls must never
 *  be retried — retrying would duplicate the side effects (P-01: 1000 分片零重复). */

import { describe, expect, test } from "bun:test"
import { OpenAIProvider } from "../src/provider/openai"

const encoder = new TextEncoder()

function firstChunk(text: string) {
  return JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })
}

describe("OpenAI provider retry side-effect guard (RC-14 G3)", () => {
  test("does not retry a stream that already emitted text, even on a retryable mid-stream error", async () => {
    let fetchCount = 0
    const fetchFn = (async () => {
      fetchCount += 1
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${firstChunk("first")}\n\n`))
          setTimeout(() => controller.error(new Error("socket connection was closed unexpectedly")), 10)
        },
      })
      return new Response(stream, { status: 200 })
    }) as typeof fetch

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
    const texts = events.filter(e => e.type === "text").map(e => e.data)
    expect(texts).toEqual(["first"])
    expect(events.some(e => e.type === "error")).toBe(true)
  })

  test("does not retry a stream that already started a tool call", async () => {
    let fetchCount = 0
    const chunk = JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read_file", arguments: "" } }] },
        finish_reason: null,
      }],
    })
    const fetchFn = (async () => {
      fetchCount += 1
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`))
          setTimeout(() => controller.error(new Error("connection reset")), 10)
        },
      })
      return new Response(stream, { status: 200 })
    }) as typeof fetch

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

  test("still retries a request that failed before producing any output", async () => {
    const sleeps: number[] = []
    let fetchCount = 0
    const fetchFn = (async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        return new Response("upstream down", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        })
      }
      return new Response(`data: ${firstChunk("second")}\n\ndata: [DONE]\n\n`, { status: 200 })
    }) as typeof fetch

    const provider = new OpenAIProvider("test-key", {
      maxRetries: 2,
      sleep: async (ms) => { sleeps.push(ms) },
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
    expect(sleeps.length).toBe(1)
    expect(events.filter(e => e.type === "text").map(e => e.data)).toEqual(["second"])
    expect(events.some(e => e.type === "status" && String(e.data).includes("provider retry"))).toBe(true)
  })
})
