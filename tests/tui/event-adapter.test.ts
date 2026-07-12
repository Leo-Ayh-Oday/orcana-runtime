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
