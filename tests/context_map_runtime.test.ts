import { describe, expect, test } from "bun:test"
import { agentLoop } from "../src/agent/loop"
import type { LLMProvider, ProviderCallOptions, StreamEvent } from "../src/provider/types"

class ContextMapCaptureProvider implements LLMProvider {
  messages: ProviderCallOptions["messages"][] = []

  async *streamChat(options: ProviderCallOptions): AsyncGenerator<StreamEvent> {
    this.messages.push(options.messages)
    yield { type: "text", data: "done" }
  }
}

describe("agentLoop ContextMap runtime integration", () => {
  test("injects ContextMap evidence into the stable provider context", async () => {
    const provider = new ContextMapCaptureProvider()
    const events: StreamEvent[] = []

    for await (const event of agentLoop("Say hello briefly", {
      provider,
      model: "test",
      tools: [],
      maxRounds: 1,
      flashTriagePolicy: "off",
      contextMapPolicy: "always",
    })) {
      events.push(event)
    }

    expect(events.some(event => event.type === "status" && String(event.data).startsWith("context-map:"))).toBe(true)
    expect(JSON.stringify(provider.messages[0])).toContain("## Context Map")
  })
})
