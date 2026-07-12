import { describe, expect, test } from "bun:test"
import { cleanAgentError } from "../../src/tui/state/adapter-helpers"
import { StreamEventAdapter } from "../../src/tui/state/event-adapter"

describe("TUI provider error formatting", () => {
  test("explains truncated escape request errors as recoverable context corruption", () => {
    expect(cleanAgentError("client 400: Failed to parse request: unexpected end of hex escape")).toContain("上下文")
  })

  test("renders quota failures as a short Chinese action message", () => {
    const message = cleanAgentError("quota 429: insufficient_quota: Your account balance is too low")

    expect(message).toBe("模型服务额度或余额不足。请在 /models 切换模型、重新输入可用 key，或到对应平台充值后再试。")
  })

  test("deduplicates repeated provider errors for the scrollback", () => {
    const adapter = new StreamEventAdapter()
    const events = adapter.adapt({
      type: "error",
      data: "quota 429: insufficient_quota: Your account balance is too low",
    })

    const eventMessage = events.find(event => event.type === "ui.event_message")
    expect(eventMessage).toBeDefined()
    expect(eventMessage).toMatchObject({
      kind: "error",
      dedupeKey: "error:模型服务额度或余额不足。请在 /models 切换模型、重新输入可用 key，或到对应平台充值后再试。",
      minIntervalMs: 10_000,
    })
  })
})
