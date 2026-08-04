import { describe, expect, test } from "bun:test"
import {
  TERMINAL_RUN_STATUSES,
  STOPPED_RUN_STATUSES,
  isTerminalRunStatus,
  isStoppedRunStatus,
} from "../../src/harness/contracts/run"
import { canTransition } from "../../src/harness/contracts/lifecycle"
import { assertTraceInvariants } from "../../evals/harness/trace-assertions"

// G0-1: terminal vs stopped semantics — a run that is no longer
// auto-advancing can be terminal (finished forever) OR stopped-resumable
// (blocked/waiting/paused → resume). Graph scheduling needs this split.

describe("G0-1 terminal vs stopped semantics", () => {
  test("blocked is NOT a terminal status", () => {
    expect(TERMINAL_RUN_STATUSES).not.toContain("blocked")
    expect(isTerminalRunStatus("blocked")).toBe(false)
    expect(TERMINAL_RUN_STATUSES).toEqual(["completed", "failed", "cancelled", "restart_required"])
  })

  test("blocked/waiting/paused are stopped but resumable", () => {
    expect(STOPPED_RUN_STATUSES).toEqual(["blocked", "waiting", "paused"])
    // The lifecycle already allows resuming out of them.
    expect(canTransition("blocked", "running")).toBe(true)
    expect(canTransition("waiting", "resuming")).toBe(true)
    expect(canTransition("paused", "resuming")).toBe(true)
  })

  test("isStoppedRunStatus covers terminal + stopped-resumable, not active states", () => {
    for (const s of ["completed", "failed", "cancelled", "restart_required", "blocked", "waiting", "paused"]) {
      expect(isStoppedRunStatus(s as never)).toBe(true)
    }
    for (const s of ["created", "initializing", "running", "pausing", "resuming"]) {
      expect(isStoppedRunStatus(s as never)).toBe(false)
    }
  })

  test("terminal states never transition; stopped-resumable do", () => {
    expect(canTransition("completed", "running")).toBe(false)
    expect(canTransition("failed", "running")).toBe(false)
    expect(canTransition("blocked", "cancelled")).toBe(true)
  })
})

describe("G0-1 replay invariants use stopped semantics", () => {
  const stoppedWithOutcome = (status: string) =>
    assertTraceInvariants([], { status, outcome: { kind: status as never } })

  test("blocked snapshot with outcome passes invariants", () => {
    expect(stoppedWithOutcome("blocked")).toEqual([])
  })

  test("waiting snapshot with outcome passes invariants", () => {
    expect(stoppedWithOutcome("waiting")).toEqual([])
  })

  test("paused snapshot with outcome passes invariants", () => {
    expect(stoppedWithOutcome("paused")).toEqual([])
  })

  test("active snapshot fails invariants (not stopped)", () => {
    const failures = assertTraceInvariants([], { status: "running" })
    expect(failures.some((f) => f.includes("not a stopped state"))).toBe(true)
  })

  test("stopped snapshot without outcome fails invariants", () => {
    const failures = assertTraceInvariants([], { status: "blocked", outcome: null })
    expect(failures.some((f) => f.includes("without outcome"))).toBe(true)
  })
})
