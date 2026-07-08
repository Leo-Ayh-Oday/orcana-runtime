import { describe, expect, test } from "bun:test"
import { parseRuntimeInput, resolveRuntimeControlIntent } from "../src/runtime/control-plane"
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

  test("command catalog resolves local slash command metadata", () => {
    const controller = new RuntimeController({
      sessionId: "s1",
      repoRoot: "E:/repo",
      commandCatalog: [{ name: "status", safeConcurrent: true }],
    })

    const result = controller.handleIntent({ type: "slash_command", raw: "/status now" })

    expect(result.action).toBe("local_command")
    expect(result.controlIntent).toMatchObject({
      kind: "local_command",
      name: "status",
      canonicalName: "status",
      argsText: "now",
      argv: ["now"],
    })
  })

  test("unknown catalog slash command is routed as an agent request", () => {
    const controller = new RuntimeController({
      sessionId: "s1",
      repoRoot: "E:/repo",
      commandCatalog: [{ name: "status", safeConcurrent: true }],
      now: () => 7,
    })

    const result = controller.handleIntent({ type: "slash_command", raw: "/custom do this" })

    expect(result.action).toBe("agent_request")
    expect(result.status).toBe("planning")
    expect(result.controlIntent).toMatchObject({ kind: "unknown_command", name: "custom" })
  })

  test("running controller blocks unsafe catalog slash command", () => {
    const controller = new RuntimeController({
      sessionId: "s1",
      repoRoot: "E:/repo",
      commandCatalog: [{ name: "clear" }],
      now: () => 1,
    })

    controller.setStatus("running")
    const result = controller.handleIntent({ type: "slash_command", raw: "/clear" })

    expect(result.ok).toBe(false)
    expect(result.status).toBe("running")
    expect(result.controlIntent).toMatchObject({ kind: "blocked_command", name: "clear" })
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

describe("Runtime control plane", () => {
  test("parses prompts, empty input, and slash command args", () => {
    expect(parseRuntimeInput("  fix the test  ")).toEqual({
      kind: "prompt",
      raw: "  fix the test  ",
      text: "fix the test",
    })
    expect(parseRuntimeInput("   ")).toEqual({ kind: "empty", raw: "   " })
    expect(parseRuntimeInput('/search "failing test" --limit 3')).toEqual({
      kind: "slash_command",
      raw: '/search "failing test" --limit 3',
      name: "search",
      argsText: '"failing test" --limit 3',
      argv: ["failing test", "--limit", "3"],
    })
  })

  test("resolves aliases and safe concurrent commands", () => {
    expect(resolveRuntimeControlIntent("/model deepseek", [
      { name: "models", aliases: ["model"], safeConcurrent: true },
    ], { isRunning: true })).toMatchObject({
      kind: "local_command",
      name: "model",
      canonicalName: "models",
      safeConcurrent: true,
      argv: ["deepseek"],
    })
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
