import { describe, expect, test } from "bun:test"
import {
  runProviderRound,
  type ProviderRoundRunnerInput,
} from "../src/agent/provider/round-runner"
import type { ProviderRoundResult } from "../src/agent/provider/round-result"
import type {
  LLMProvider,
  ProviderCallOptions,
  StreamEvent,
} from "../src/provider/types"

function request(): ProviderCallOptions {
  return {
    model: "test",
    purpose: "agent_main",
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 256,
  }
}

async function consumeRound(
  input: ProviderRoundRunnerInput,
): Promise<{
  events: StreamEvent[]
  result: ProviderRoundResult
}> {
  const events: StreamEvent[] = []
  const iterator = runProviderRound(input)
  while (true) {
    const next = await iterator.next()
    if (next.done) return { events, result: next.value }
    events.push(next.value)
  }
}

describe("ProviderRoundRunner", () => {
  test("parses one round while preserving buffered event order", async () => {
    const provider: LLMProvider = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        yield { type: "text", data: "before tool" }
        yield { type: "thinking_blocks", data: [{ thinking: "reason", signature: "sig" }] }
        yield { type: "token_usage", data: { inputTokens: 10, outputTokens: 2 } }
        yield { type: "status", data: "provider working" }
        yield { type: "tool_call", data: { id: "call-1", name: "read_file", input: { path: "a.ts" } } }
        yield { type: "text", data: " after tool" }
        yield { type: "token_usage", data: { outputTokens: 5, actualModel: "actual" } }
      },
    }

    const { events, result } = await consumeRound({
      provider,
      request: request(),
      bufferText: true,
    })

    expect(events).toEqual([
      { type: "status", data: "provider working" },
      { type: "text", data: "before tool" },
      { type: "tool_call", data: { id: "call-1", name: "read_file", input: { path: "a.ts" } } },
    ])
    expect(result.finalText).toBe("before tool after tool")
    expect(result.textChunks).toEqual(["before tool", " after tool"])
    expect(result.thinkingBlocks).toEqual([{ thinking: "reason", signature: "sig" }])
    expect(result.toolCalls).toEqual([
      { id: "call-1", name: "read_file", input: { path: "a.ts" } },
    ])
    expect(result.usage?.inputTokens).toBe(10)
    expect(result.usage?.outputTokens).toBe(5)
    expect(result.usage?.actualModel).toBe("actual")
    expect(result.bufferedTextEmitted).toBe(true)
  })

  test("streams text immediately when buffering is disabled", async () => {
    const provider: LLMProvider = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        yield { type: "text", data: "a" }
        yield { type: "text", data: "b" }
      },
    }

    const { events, result } = await consumeRound({
      provider,
      request: request(),
      bufferText: false,
    })

    expect(events).toEqual([
      { type: "text", data: "a" },
      { type: "text", data: "b" },
    ])
    expect(result.finalText).toBe("ab")
    expect(result.bufferedTextEmitted).toBe(false)
  })

  test("classifies emitted and thrown failures with the legacy policy", async () => {
    const authProvider: LLMProvider = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        yield { type: "error", data: "auth invalid api key" }
      },
    }
    const networkProvider: LLMProvider = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        throw new Error("fetch failed")
      },
    }

    const auth = await consumeRound({
      provider: authProvider,
      request: request(),
      bufferText: false,
    })
    const network = await consumeRound({
      provider: networkProvider,
      request: request(),
      bufferText: false,
    })

    expect(auth.result.failure).toEqual({
      message: "auth invalid api key",
      retryable: false,
      yielded: true,
    })
    expect(auth.events).toEqual([{ type: "error", data: "auth invalid api key" }])
    expect(network.result.failure?.message).toBe("fetch failed")
    expect(network.result.failure?.retryable).toBe(true)
    expect(network.events).toEqual([{ type: "error", data: "fetch failed" }])
  })

  test("idle timeout aborts the child signal and closes the Provider iterator", async () => {
    let childAborted = false
    let returnCalls = 0
    const provider: LLMProvider = {
      streamChat(options): AsyncGenerator<StreamEvent> {
        options.abortSignal?.addEventListener("abort", () => {
          childAborted = true
        }, { once: true })
        return {
          [Symbol.asyncIterator]() {
            return this
          },
          next() {
            return new Promise<IteratorResult<StreamEvent>>(() => {})
          },
          return() {
            returnCalls++
            return Promise.resolve({ done: true, value: undefined })
          },
        } as unknown as AsyncGenerator<StreamEvent>
      },
    }

    const { events, result } = await consumeRound({
      provider,
      request: request(),
      bufferText: false,
      idleTimeoutMs: 5,
    })

    expect(result.failure?.message).toContain("provider stream idle timeout")
    expect(result.failure?.retryable).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("error")
    expect(childAborted).toBe(true)
    expect(returnCalls).toBe(1)
  })

  test("an external abort closes the iterator without becoming a Provider failure", async () => {
    let returnCalls = 0
    const controller = new AbortController()
    controller.abort("user stop")
    const provider: LLMProvider = {
      streamChat(): AsyncGenerator<StreamEvent> {
        return {
          [Symbol.asyncIterator]() {
            return this
          },
          next() {
            return new Promise<IteratorResult<StreamEvent>>(() => {})
          },
          return() {
            returnCalls++
            return Promise.resolve({ done: true, value: undefined })
          },
        } as unknown as AsyncGenerator<StreamEvent>
      },
    }

    const { events, result } = await consumeRound({
      provider,
      request: request(),
      bufferText: false,
      abortSignal: controller.signal,
      idleTimeoutMs: 5_000,
    })

    expect(events).toEqual([])
    expect(result.aborted).toBe(true)
    expect(result.failure).toBeUndefined()
    expect(returnCalls).toBe(1)
  })
})
