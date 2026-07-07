import { describe, expect, test } from "bun:test"
import { DeepSeekProvider } from "../src/provider/deepseek"
import { classifyProviderError, providerRetryDelayMs } from "../src/provider/retry"
import type { StreamEvent } from "../src/provider/types"

function textDelta(text: string) {
  return { type: "content_block_delta", delta: { type: "text_delta", text } }
}

class AbortableStream implements AsyncIterable<unknown> {
  aborted = false
  controller = {
    abort: () => {
      this.aborted = true
    },
  }

  async *[Symbol.asyncIterator]() {
    yield textDelta("first")
    yield textDelta("second")
  }
}

class FakeAnthropicClient {
  calls = 0
  streams: Array<() => AsyncGenerator<unknown>>

  constructor(streams: Array<() => AsyncGenerator<unknown>>) {
    this.streams = streams
  }

  messages = {
    stream: () => {
      const factory = this.streams[Math.min(this.calls, this.streams.length - 1)]!
      this.calls += 1
      return factory()
    },
  }
}

async function collect(provider: DeepSeekProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of provider.streamChat({
    model: "test",
    system: "system",
    messages: [],
    maxTokens: 1024,
  })) {
    events.push(event)
  }
  return events
}

describe("provider retry classification", () => {
  test("classifies 429 retry-after", () => {
    const info = classifyProviderError({ status: 429, headers: { "retry-after": "2" }, message: "rate limited" })

    expect(info.kind).toBe("rate_limit")
    expect(info.retryable).toBe(true)
    expect(info.retryAfterMs).toBe(2000)
    expect(info.message).toBe("rate limited")
    expect(providerRetryDelayMs(info, 0)).toBe(2000)
  })

  test("classifies quota and billing failures as non-retryable", () => {
    const info = classifyProviderError({
      status: 429,
      message: "insufficient_quota: You exceeded your current quota, please check your plan and billing details",
    })

    expect(info.kind).toBe("quota")
    expect(info.retryable).toBe(false)
    expect(info.status).toBe(429)
  })

  test("classifies transient network failures as retryable", () => {
    const info = classifyProviderError(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }))

    expect(info.kind).toBe("network")
    expect(info.retryable).toBe(true)
  })

  test("classifies stream protocol and socket closure errors as retryable", () => {
    const protocol = classifyProviderError(new Error('Unexpected event order, got message_start before receiving "message_stop"'))
    const socket = classifyProviderError(new Error("The socket connection was closed unexpectedly"))

    expect(protocol.kind).toBe("network")
    expect(protocol.retryable).toBe(true)
    expect(socket.kind).toBe("network")
    expect(socket.retryable).toBe(true)
  })
})

describe("DeepSeekProvider retry behavior", () => {
  test("retries 429 before any streamed content", async () => {
    const sleeps: number[] = []
    const client = new FakeAnthropicClient([
      async function* () {
        throw { status: 429, headers: { "retry-after": "1" }, message: "rate limited" }
      },
      async function* () {
        yield textDelta("ok")
      },
    ])
    const provider = new DeepSeekProvider("test", {
      client,
      maxRetries: 2,
      sleep: async (ms) => { sleeps.push(ms) },
    })

    const events = await collect(provider)

    expect(client.calls).toBe(2)
    expect(sleeps).toEqual([1000])
    expect(events.some(event => event.type === "status" && String(event.data).includes("provider retry: rate_limit 429"))).toBe(true)
    expect(events.some(event => event.type === "text" && event.data === "ok")).toBe(true)
  })

  test("does not retry quota failures", async () => {
    const sleeps: number[] = []
    const client = new FakeAnthropicClient([
      async function* () {
        throw {
          status: 429,
          message: "insufficient_quota: Your account balance is too low",
          response: { status: 429, body: { error: { code: "insufficient_quota", message: "Your account balance is too low" } } },
        }
      },
      async function* () {
        yield textDelta("should not happen")
      },
    ])
    const provider = new DeepSeekProvider("test", {
      client,
      maxRetries: 2,
      sleep: async (ms) => { sleeps.push(ms) },
    })

    const events = await collect(provider)

    expect(client.calls).toBe(1)
    expect(sleeps).toEqual([])
    expect(events.some(event => event.type === "status" && String(event.data).includes("provider retry"))).toBe(false)
    expect(events.some(event => event.type === "error" && String(event.data).startsWith("quota 429:"))).toBe(true)
  })

  test("does not retry after streamed text starts", async () => {
    const client = new FakeAnthropicClient([
      async function* () {
        yield textDelta("partial")
        throw { status: 500, message: "server exploded" }
      },
      async function* () {
        yield textDelta("should not happen")
      },
    ])
    const provider = new DeepSeekProvider("test", {
      client,
      maxRetries: 2,
      sleep: async () => {},
    })

    const events = await collect(provider)

    expect(client.calls).toBe(1)
    expect(events.some(event => event.type === "text" && event.data === "partial")).toBe(true)
    expect(events.some(event => event.type === "error" && String(event.data).includes("server"))).toBe(true)
  })

  test("does not retry after tool_use starts", async () => {
    const client = new FakeAnthropicClient([
      async function* () {
        yield { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "read_file" } }
        throw { status: 500, message: "server exploded" }
      },
      async function* () {
        yield textDelta("should not happen")
      },
    ])
    const provider = new DeepSeekProvider("test", {
      client,
      maxRetries: 2,
      sleep: async () => {},
    })

    const events = await collect(provider)

    expect(client.calls).toBe(1)
    expect(events.some(event => event.type === "error" && String(event.data).includes("server"))).toBe(true)
  })

  test("closes provider stream when abort signal is raised", async () => {
    const abortable = new AbortableStream()
    const client = {
      messages: {
        stream: () => abortable,
      },
    }
    const controller = new AbortController()
    const provider = new DeepSeekProvider("test", {
      client,
      maxRetries: 0,
      sleep: async () => {},
    })

    const events: StreamEvent[] = []
    for await (const event of provider.streamChat({
      model: "test",
      system: "system",
      messages: [],
      maxTokens: 1024,
      abortSignal: controller.signal,
    })) {
      events.push(event)
      if (event.type === "text") controller.abort()
    }

    expect(abortable.aborted).toBe(true)
    expect(events.some(event => event.type === "status" && String(event.data).includes("aborted"))).toBe(true)
  })
})
