/** RC-14 G6: a thinking block must be emitted exactly once in the stream —
 *  a dangling in-flight thinking block must not re-emit already-sent blocks. */

import { describe, expect, test } from "bun:test"
import { DeepSeekProvider } from "../src/provider/deepseek"
import { AnthropicProvider } from "../src/provider/anthropic"
import type { StreamEvent } from "../src/provider/types"

function fakeClient(events: unknown[]) {
  return {
    messages: {
      stream: async function* () {
        for (const event of events) yield event
      },
    },
  }
}

const DUAL_THINKING_EVENTS = [
  { type: "content_block_start", content_block: { type: "thinking", signature: "s1" } },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "think one" } },
  { type: "content_block_stop" },
  { type: "content_block_start", content_block: { type: "thinking", signature: "s2" } },
  { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "think two" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
]

async function collect(provider: DeepSeekProvider | AnthropicProvider): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const event of provider.streamChat({
    model: "test",
    purpose: "agent_main",
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    maxTokens: 1024,
  })) out.push(event)
  return out
}

function assertThinkingSentOnce(events: StreamEvent[]) {
  const thinkingEvents = events.filter(e => e.type === "thinking_blocks")
  expect(thinkingEvents.length).toBe(1)
  const data = thinkingEvents[0]!.data as Array<{ thinking: string; signature: string }>
  expect(data.map(b => b.thinking)).toEqual(["think one", "think two"])
}

describe("DeepSeekProvider thinking blocks (RC-14 G6)", () => {
  test("emits thinking blocks once even when the second block never stops", async () => {
    const provider = new DeepSeekProvider("test-key", {
      client: fakeClient(DUAL_THINKING_EVENTS),
      maxRetries: 0,
    })
    assertThinkingSentOnce(await collect(provider))
  })
})

describe("AnthropicProvider thinking blocks (RC-14 G6)", () => {
  test("emits thinking blocks once even when the second block never stops", async () => {
    const provider = new AnthropicProvider("test-key", {
      client: fakeClient(DUAL_THINKING_EVENTS),
      maxRetries: 0,
    })
    assertThinkingSentOnce(await collect(provider))
  })
})
