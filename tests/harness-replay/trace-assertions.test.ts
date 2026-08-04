import { describe, expect, test } from "bun:test"
import { assertTraceInvariants, type ReplayEvent } from "../../evals/harness/trace-assertions"

// R1 (Harness Closure): HR-026 is now a per-toolCallId pairing — the old
// name/count check let a same-named second call with zero terminals slip
// through when the first call had two. These cases lock the new semantics.

function requested(callId: string, name = "baseline_probe"): ReplayEvent {
  return { type: "tool.call.requested", payload: { toolCall: { id: callId, name } } }
}

function completed(callId: string, name = "baseline_probe"): ReplayEvent {
  return { type: "tool.call.completed", payload: { toolName: name, toolCallId: callId, content: "ok", success: true } }
}

function failed(callId: string, name = "baseline_probe"): ReplayEvent {
  return { type: "tool.call.failed", payload: { toolName: name, toolCallId: callId, error: "boom" } }
}

function policyBlockedTrace(name: string): ReplayEvent {
  return { type: "display.changed", payload: { display: { data: `tool "${name}" blocked by policy` } } }
}

const terminal = { status: "completed", outcome: { kind: "completed" } }

describe("R1 HR-026 tool-call termination pairing", () => {
  test("same-name calls pair by callId: A terminated, B terminated → pass", () => {
    const events = [requested("a"), requested("b"), completed("a"), completed("b")]
    expect(assertTraceInvariants(events, terminal)).toEqual([])
  })

  test("same-name calls: A has TWO terminals, B has ZERO → duplicate-terminal failure", () => {
    // The audit case: the old name-based check saw name covered and passed.
    const events = [requested("a"), requested("b"), completed("a"), completed("a")]
    const failures = assertTraceInvariants(events, terminal)
    expect(failures.some((f) => f.includes("2 terminal events"))).toBe(true)
    expect(failures.some((f) => f.includes('"baseline_probe" (b) has no terminal'))).toBe(true)
  })

  test("missing terminal → failure", () => {
    const events = [requested("a")]
    const failures = assertTraceInvariants(events, terminal)
    expect(failures.some((f) => f.includes("has no terminal event"))).toBe(true)
  })

  test("policy-block trace exempts a requested call without terminal (HR-019)", () => {
    const events = [requested("shell", "shell"), policyBlockedTrace("shell")]
    expect(assertTraceInvariants(events, terminal)).toEqual([])
  })

  test("terminal before its request is not a valid terminal (order)", () => {
    const events = [completed("a"), requested("a")]
    const failures = assertTraceInvariants(events, terminal)
    expect(failures.some((f) => f.includes("has no terminal event"))).toBe(true)
  })

  test("run ending on an un-terminated request fails (lastType)", () => {
    const events = [requested("a"), completed("a"), requested("b")]
    const failures = assertTraceInvariants(events, terminal)
    expect(failures.some((f) => f.includes("ends on an un-terminated tool call"))).toBe(true)
  })

  test("missing sequences are tolerated (synthetic events)", () => {
    const events = [requested("a"), completed("a")]
    expect(assertTraceInvariants(events, terminal)).toEqual([])
  })

  test("non-stopped snapshot status fails HR-027 (G0-1: blocked is stopped, running is not)", () => {
    const events = [requested("a"), completed("a")]
    const failures = assertTraceInvariants(events, { status: "running" })
    expect(failures.some((f) => f.includes("not a stopped state"))).toBe(true)
    // blocked is stopped-but-resumable → passes with an outcome.
    expect(assertTraceInvariants(events, { status: "blocked", outcome: { kind: "blocked" } })).toEqual([])
  })

  test("legacy events without toolCallId fall back to name pairing", () => {
    const legacyCompleted: ReplayEvent = { type: "tool.call.completed", payload: { toolName: "baseline_probe", content: "ok", success: true } }
    const events = [requested("a"), legacyCompleted]
    expect(assertTraceInvariants(events, terminal)).toEqual([])
  })
})
