import { describe, expect, test } from "bun:test"
import { RuntimeController } from "../src/runtime/controller"
import { RuntimeEventBus } from "../src/runtime/event-bus"
import type { RuntimeEvent } from "../src/runtime/events"
import { createRuntimeSession, updateRuntimeSessionStatus } from "../src/runtime/session"

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

describe("RuntimeController", () => {
  test("start emits session boundary events once", () => {
    let time = 10
    const controller = new RuntimeController({
      sessionId: "s1",
      repoRoot: "E:/repo",
      now: () => time++,
    })

    controller.start()
    controller.start()

    expect(controller.eventBus.getHistory()).toEqual([
      { type: "session.started", sessionId: "s1", repoRoot: "E:/repo", timestamp: 11 },
      { type: "session.status", status: "idle", timestamp: 11 },
    ])
  })

  test("submit_prompt is classified as an agent request without executing it", () => {
    const controller = new RuntimeController({
      sessionId: "s1",
      repoRoot: "E:/repo",
      now: () => 1,
    })

    const result = controller.handleIntent({ type: "submit_prompt", text: "fix the failing test" })

    expect(result).toEqual({ ok: true, action: "agent_request", status: "planning" })
    expect(controller.getSession().status).toBe("planning")
    expect(controller.eventBus.getHistory()).toEqual([
      { type: "session.status", status: "planning", timestamp: 1 },
    ])
  })

  test("slash_command remains local control-plane intent", () => {
    const controller = new RuntimeController({
      sessionId: "s1",
      repoRoot: "E:/repo",
    })

    const result = controller.handleIntent({ type: "slash_command", raw: "/status" })

    expect(result.action).toBe("local_command")
    expect(result.status).toBe("idle")
    expect(controller.eventBus.getHistory()).toEqual([])
  })

  test("interrupt moves runtime to blocked status", () => {
    const controller = new RuntimeController({
      sessionId: "s1",
      repoRoot: "E:/repo",
      now: () => 5,
    })

    const result = controller.handleIntent({ type: "interrupt" })

    expect(result).toEqual({ ok: true, action: "interrupted", status: "blocked" })
    expect(controller.eventBus.getHistory()).toEqual([
      { type: "session.status", status: "blocked", timestamp: 5 },
    ])
  })
})

describe("RuntimeSession", () => {
  test("creates idle session metadata", () => {
    expect(createRuntimeSession({
      sessionId: "s1",
      repoRoot: "E:/repo",
      timestamp: 100,
    })).toEqual({
      sessionId: "s1",
      repoRoot: "E:/repo",
      status: "idle",
      createdAt: 100,
      updatedAt: 100,
    })
  })

  test("status updates preserve identity and creation time", () => {
    const session = createRuntimeSession({
      sessionId: "s1",
      repoRoot: "E:/repo",
      timestamp: 100,
    })

    expect(updateRuntimeSessionStatus(session, "running", 200)).toEqual({
      sessionId: "s1",
      repoRoot: "E:/repo",
      status: "running",
      createdAt: 100,
      updatedAt: 200,
    })
  })
})

function compileTimeOnly(bus: RuntimeEventBus) {
  if (false) {
    // @ts-expect-error unknown runtime event payloads are not accepted
    bus.emitEvent({ type: "unknown.event", timestamp: 1 })
  }
}

void compileTimeOnly
