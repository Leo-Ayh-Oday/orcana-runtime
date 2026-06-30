import { describe, expect, test } from "bun:test"
import { RuntimeEventBus } from "../src/runtime/event-bus"
import type { RuntimeEvent } from "../src/runtime/events"

function statusEvent(status: "idle" | "running" | "done", timestamp: number): RuntimeEvent {
  return { type: "session.status", status, timestamp }
}

describe("RuntimeEventBus", () => {
  test("preserves event order for subscribers and history", () => {
    const bus = new RuntimeEventBus()
    const seen: RuntimeEvent[] = []
    bus.subscribe(event => {
      seen.push(event)
    })

    const events = [
      { type: "session.started", sessionId: "s1", repoRoot: "E:/repo", timestamp: 1 },
      statusEvent("running", 2),
      { type: "agent.round.started", round: 1, mode: "coder", timestamp: 3 },
    ] satisfies RuntimeEvent[]

    for (const event of events) bus.emitEvent(event)

    expect(seen).toEqual(events)
    expect(bus.getHistory()).toEqual(events)
  })

  test("unsubscribe stops future notifications", () => {
    const bus = new RuntimeEventBus()
    const seen: RuntimeEvent[] = []
    const unsubscribe = bus.subscribe(event => {
      seen.push(event)
    })

    bus.emitEvent(statusEvent("running", 1))
    unsubscribe()
    bus.emitEvent(statusEvent("done", 2))

    expect(seen).toEqual([statusEvent("running", 1)])
    expect(bus.getHistory()).toEqual([statusEvent("running", 1), statusEvent("done", 2)])
  })

  test("bounded history keeps the newest events", () => {
    const bus = new RuntimeEventBus(2)

    bus.emitEvent(statusEvent("idle", 1))
    bus.emitEvent(statusEvent("running", 2))
    bus.emitEvent(statusEvent("done", 3))

    expect(bus.getHistory()).toEqual([
      statusEvent("running", 2),
      statusEvent("done", 3),
    ])
  })

  test("zero history still emits to subscribers", () => {
    const bus = new RuntimeEventBus(0)
    const seen: RuntimeEvent[] = []
    bus.subscribe(event => {
      seen.push(event)
    })

    bus.emitEvent(statusEvent("running", 1))

    expect(seen).toEqual([statusEvent("running", 1)])
    expect(bus.getHistory()).toEqual([])
  })

  test("getHistory returns a copy", () => {
    const bus = new RuntimeEventBus()
    bus.emitEvent(statusEvent("running", 1))

    const history = bus.getHistory()
    history.push(statusEvent("done", 2))

    expect(bus.getHistory()).toEqual([statusEvent("running", 1)])
  })
})

function compileTimeOnly(bus: RuntimeEventBus) {
  if (false) {
    // @ts-expect-error unknown runtime event payloads are not accepted
    bus.emitEvent({ type: "unknown.event", timestamp: 1 })
  }
}

void compileTimeOnly
