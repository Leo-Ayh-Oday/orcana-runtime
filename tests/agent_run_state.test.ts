import { describe, expect, test } from "bun:test"
import { createEvidenceLedger } from "../src/agent/evidence-ledger"
import { applyAgentRunStatePatch } from "../src/agent/run/state-patch"
import { snapshotAgentRunState } from "../src/agent/run/snapshot"
import { createAgentRunState, createRoundState } from "../src/agent/run/state"
import { L1_STATE_OWNERSHIP } from "../src/agent/run/types"

function makeRunState() {
  return createAgentRunState({
    runId: "run-l1",
    sessionId: "session-l1",
    prompt: "implement the loop state boundary",
    effectivePrompt: "implement the loop state boundary",
    language: "en",
    rawMessages: [{ role: "user", content: "implement the loop state boundary" }],
    intentPolicy: { mode: "narrow_edit", reason: "test" },
    evidenceLedger: createEvidenceLedger(),
    now: () => 1234,
  })
}

describe("AgentRunState L1 ownership", () => {
  test("creates isolated run facts without runtime services", () => {
    const first = makeRunState()
    const second = makeRunState()

    first.execution.taskFiles.add("src/agent/loop.ts")
    first.verification.evidenceLedger.entries.push({
      id: "evi-l1",
      kind: "test",
      output: "pass",
      passed: true,
      timestamp: 1234,
    })

    expect(second.execution.taskFiles.size).toBe(0)
    expect(second.verification.evidenceLedger.entries).toHaveLength(0)
    expect("provider" in first).toBe(false)
    expect("tools" in first).toBe(false)
    expect("hooks" in first).toBe(false)
    expect("sandbox" in first).toBe(false)
  })

  test("documents Router State and StateMachine authority without embedding either", () => {
    const state = makeRunState()

    expect(L1_STATE_OWNERSHIP).toEqual({
      agentRunState: "durable-run-facts",
      routerState: "legacy-behavior-driver",
      stateMachine: "readonly-monitor",
    })
    expect("routerState" in state).toBe(false)
    expect("stateMachine" in state).toBe(false)
  })
})

describe("AgentRunState snapshot", () => {
  test("returns a detached, deeply frozen, JSON-safe projection", () => {
    const state = makeRunState()
    state.execution.taskFiles.add("src/agent/loop.ts")
    state.execution.runtimeSelfEditFiles.add("src/agent/run/state.ts")
    state.planning.planningRejections = 2

    const snapshot = snapshotAgentRunState(state)
    const execution = snapshot.execution as Readonly<Record<string, unknown>>

    expect(execution.taskFiles).toEqual(["src/agent/loop.ts"])
    expect(execution.runtimeSelfEditFiles).toEqual(["src/agent/run/state.ts"])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(execution)).toBe(true)
    expect(Object.isFrozen(execution.taskFiles)).toBe(true)
    expect(() => JSON.stringify(snapshot)).not.toThrow()

    state.execution.taskFiles.add("tests/agent_run_state.test.ts")
    state.planning.planningRejections = 3
    expect(execution.taskFiles).toEqual(["src/agent/loop.ts"])
    expect((snapshot.planning as Record<string, unknown>).planningRejections).toBe(2)
  })

  test("fails closed when state acquires a circular non-serializable fact", () => {
    const state = makeRunState()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    ;(state.identity as unknown as Record<string, unknown>).invalid = circular

    expect(() => snapshotAgentRunState(state)).toThrow("circular reference")
  })
})

describe("AgentRunStatePatch and RoundState", () => {
  test("patches named ownership sections without replacing the run state", () => {
    const state = makeRunState()
    const executionRef = state.execution
    const lifecycleRef = state.lifecycle

    const result = applyAgentRunStatePatch(state, {
      execution: {
        consecutiveErrors: 2,
        lastToolNames: ["read_file"],
      },
      lifecycle: {
        finalRound: 4,
      },
    })

    expect(result).toBe(state)
    expect(state.execution).toBe(executionRef)
    expect(state.lifecycle).toBe(lifecycleRef)
    expect(state.execution.consecutiveErrors).toBe(2)
    expect(state.execution.lastToolNames).toEqual(["read_file"])
    expect(state.lifecycle.finalRound).toBe(4)
    expect(state.planning.planningRejections).toBe(0)
  })

  test("allocates fresh per-round collections and commits only explicit copies", () => {
    const state = makeRunState()
    const firstRound = createRoundState(0, 100)
    const secondRound = createRoundState(1, 200)

    firstRound.toolNames.push("read_file")
    firstRound.modifiedFiles.add("src/agent/loop.ts")
    firstRound.verificationResults.push({
      kind: "test",
      command: "bun test",
      passed: true,
      issues: 0,
      durationMs: 10,
      summary: "pass",
    })

    expect(secondRound.toolNames).toEqual([])
    expect(secondRound.modifiedFiles.size).toBe(0)
    expect(secondRound.verificationResults).toEqual([])

    applyAgentRunStatePatch(state, {
      execution: { lastToolNames: [...firstRound.toolNames] },
      verification: { lastResults: [...firstRound.verificationResults] },
    })
    firstRound.toolNames.push("shell")
    firstRound.verificationResults.length = 0

    expect(state.execution.lastToolNames).toEqual(["read_file"])
    expect(state.verification.lastResults).toHaveLength(1)
  })
})
