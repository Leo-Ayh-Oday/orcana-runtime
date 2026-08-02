import { describe, expect, test } from "bun:test"
import { InvalidStateTransitionError } from "../src/harness/contracts/errors"
import type { AgentRun } from "../src/harness/contracts/run"
import type { HarnessEvent } from "../src/harness/contracts/events"
import { lifecycleEventName, RunLifecycleMachine } from "../src/harness/runtime/lifecycle-machine"
import { assembleRunScope } from "../src/harness/runtime/run-scope"

// H2: the lifecycle machine drives run.status exclusively — legal chains
// emit run.* events, illegal transitions fail, terminals never re-move.

function fakeRun(): AgentRun {
  const runId = "run-m-1"
  const controller = new AbortController()
  return {
    runId,
    sessionId: "sess-m",
    status: "created",
    input: { prompt: "inspect" },
    scope: assembleRunScope({ runId, sessionId: "sess-m", projectRoot: process.cwd(), controller }),
    budget: undefined as never,
    createdAt: Date.now(),
    eventSequence: 0,
    schemaVersion: 1,
  }
}

describe("RunLifecycleMachine", () => {
  test("legal chain emits lifecycle events in order and sets timestamps", () => {
    const run = fakeRun()
    const events: HarnessEvent[] = []
    const machine = new RunLifecycleMachine(run, event => events.push(event))

    machine.transition("initializing")
    machine.transition("running")
    machine.transition("completed")

    expect(run.status).toBe("completed")
    expect(events.map(e => e.type)).toEqual([
      "run.initializing",
      "run.started",
      "run.completed",
    ])
    expect(run.startedAt).toBeTruthy()
    expect(run.finishedAt).toBeTruthy()
    // Events share the run sequence counter.
    expect(events.map(e => e.sequence)).toEqual([1, 2, 3])
  })

  test("illegal transition throws InvalidStateTransitionError and leaves status unchanged", () => {
    const run = fakeRun()
    const machine = new RunLifecycleMachine(run, () => {})
    // created may only go to initializing/failed/cancelled — waiting is illegal.
    expect(() => machine.transition("waiting")).toThrow(InvalidStateTransitionError)
    expect(run.status).toBe("created")
    // And skipping initializing (created → running) is illegal too.
    expect(() => machine.transition("running")).toThrow(InvalidStateTransitionError)
    expect(run.status).toBe("created")
  })

  test("same-status transition is idempotent and emits nothing", () => {
    const run = fakeRun()
    const events: HarnessEvent[] = []
    const machine = new RunLifecycleMachine(run, event => events.push(event))
    machine.transition("initializing")
    machine.transition("running")
    machine.transition("running")
    expect(run.status).toBe("running")
    expect(events).toHaveLength(2)
  })

  test("terminal states never transition again", () => {
    const run = fakeRun()
    const machine = new RunLifecycleMachine(run, () => {})
    machine.transition("initializing")
    machine.transition("running")
    machine.transition("completed")
    expect(() => machine.transition("running")).toThrow(InvalidStateTransitionError)
    expect(run.status).toBe("completed")
  })

  test("waiting can resume but blocked can rerun", () => {
    const run = fakeRun()
    const machine = new RunLifecycleMachine(run, () => {})
    machine.transition("initializing")
    machine.transition("running")
    machine.transition("waiting")
    expect(machine.can("resuming")).toBe(true)
    machine.transition("resuming")
    machine.transition("running")
    machine.transition("blocked")
    expect(machine.can("running")).toBe(true)
    machine.transition("running")
    expect(run.status).toBe("running")
  })
})

describe("lifecycleEventName", () => {
  test("maps every non-terminal status to a run.* event", () => {
    expect(lifecycleEventName("running")).toBe("run.started")
    expect(lifecycleEventName("waiting")).toBe("run.waiting")
    expect(lifecycleEventName("blocked")).toBe("run.blocked")
    expect(lifecycleEventName("paused")).toBe("run.paused")
    expect(lifecycleEventName("completed")).toBe("run.completed")
    expect(lifecycleEventName("failed")).toBe("run.failed")
    expect(lifecycleEventName("cancelled")).toBe("run.cancelled")
  })
})
