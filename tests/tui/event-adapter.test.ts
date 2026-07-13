import { describe, expect, test } from "bun:test"
import { StreamEventAdapter } from "../../src/tui/state/event-adapter"

describe("StreamEventAdapter usage authority", () => {
  test("estimated cache misses do not overwrite the latest provider hit rate", () => {
    const adapter = new StreamEventAdapter()
    const events = adapter.adapt({
      type: "token_usage",
      data: { cacheSource: "estimate", cacheHitRate: 0, round: 9 },
    })
    const token = events.find(event => event.type === "token.updated")
    expect(token).toMatchObject({ type: "token.updated", round: 9 })
    expect(token).not.toHaveProperty("cacheHitRate")
  })

  test("provider cache hit rate remains authoritative", () => {
    const adapter = new StreamEventAdapter()
    const events = adapter.adapt({
      type: "token_usage",
      data: { cacheSource: "provider", cacheHitRate: 91, contextUsagePercent: 42, round: 8 },
    })
    expect(events.find(event => event.type === "token.updated")).toMatchObject({
      type: "token.updated",
      cacheHitRate: 91,
      activeContextPercent: 42,
      round: 8,
    })
  })
})

describe("StreamEventAdapter tool result status", () => {
  test("preserves a failed tool result instead of marking it passed", () => {
    const adapter = new StreamEventAdapter()
    const [started] = adapter.adapt({ type: "tool_call", data: { name: "shell" } })
    const [finished] = adapter.adapt({
      type: "tool_result",
      data: { name: "shell", content: "exit code 1", success: false },
    })

    expect(started).toMatchObject({ type: "tool.started", tool: "shell" })
    expect(finished).toMatchObject({ type: "tool.finished", ok: false })
    expect(finished && "outputSummary" in finished ? finished.outputSummary : "").toContain("exit code 1")
  })
})
