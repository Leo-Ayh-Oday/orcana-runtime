import { describe, expect, test } from "bun:test"
import {
  evaluateRubric,
  outcomeIs,
  eventType,
  noEventType,
  noSecretInEvents,
  sequenceContinuous,
  allToolCallsTerminated,
  defaultHrRubric,
  type RubricCheck,
} from "../../evals/harness/rubric"
import type { RunReplayResult } from "../../evals/harness/contracts"

// H12 §18.4/18.5: pass rules — all required, quality floors, no Safety/
// Truthfulness P0. Never a plain pass-rate.

function result(overrides: Partial<RunReplayResult> = {}): RunReplayResult {
  return {
    caseId: "t",
    passed: true,
    failures: [],
    events: [],
    snapshot: { status: "completed", outcome: { kind: "completed" }, budgetState: { used: {} }, artifactRefs: [] },
    durationMs: 1,
    workspaceDir: "",
    ...overrides,
  }
}

describe("H12 rubric pass rules", () => {
  test("all required pass + floor met → passed", () => {
    const checks: RubricCheck[] = [
      { id: "a", dimension: "correctness", weight: 2, required: true, evaluator: outcomeIs("completed") },
      { id: "b", dimension: "safety", weight: 1, required: false, evaluator: eventType("x", { minCount: 0 }) },
    ]
    const evaluation = evaluateRubric({ result: result() }, checks, { correctness: 0.5 })
    expect(evaluation.passed).toBe(true)
    expect(evaluation.failures).toEqual([])
  })

  test("required failure → failed", () => {
    const checks: RubricCheck[] = [
      { id: "a", dimension: "correctness", weight: 2, required: true, evaluator: outcomeIs("failed") },
    ]
    const evaluation = evaluateRubric({ result: result() }, checks, {})
    expect(evaluation.passed).toBe(false)
    expect(evaluation.failures.some((f) => f.includes("required check failed"))).toBe(true)
  })

  test("R1: non-required failure becomes a warning and does NOT veto the run", () => {
    const checks: RubricCheck[] = [
      { id: "a", dimension: "correctness", weight: 2, required: true, evaluator: outcomeIs("completed") },
      { id: "b", dimension: "safety", weight: 1, required: false, evaluator: eventType("never-happens") },
    ]
    const evaluation = evaluateRubric({ result: result() }, checks, {})
    expect(evaluation.passed).toBe(true)
    expect(evaluation.failures).toEqual([])
    expect(evaluation.warnings.some((w) => w.includes("never-happens"))).toBe(true)
  })

  test("quality floor below target → failed", () => {
    const checks: RubricCheck[] = [
      { id: "a", dimension: "correctness", weight: 2, required: false, evaluator: eventType("run.completed") },
    ]
    // No run.completed event → score 0/2, floor 0.5 unmet.
    const evaluation = evaluateRubric({ result: result() }, checks, { correctness: 0.5 })
    expect(evaluation.passed).toBe(false)
    expect(evaluation.failures.some((f) => f.includes("below floor"))).toBe(true)
  })

  test("safety P0 violation vetoes even with passing checks", () => {
    const checks: RubricCheck[] = [
      { id: "s", dimension: "safety", weight: 3, required: true, severity: "p0", evaluator: noSecretInEvents(/sk-[a-zA-Z0-9]{20,}/) },
      { id: "a", dimension: "correctness", weight: 2, required: true, evaluator: outcomeIs("completed") },
    ]
    const leaked = result({ events: [{ type: "text.emitted", payload: { text: "sk-abcdef0123456789abcdef0123456789" } }] })
    const evaluation = evaluateRubric({ result: leaked }, checks, {})
    expect(evaluation.passed).toBe(false)
    expect(evaluation.p0Violations.length).toBeGreaterThan(0)
  })

  test("default HR rubric passes on a clean completed run", () => {
    const evaluation = evaluateRubric({ result: result() }, defaultHrRubric(), {})
    expect(evaluation.passed).toBe(true)
  })
})

describe("H12 built-in evaluators", () => {
  test("outcomeIs matches the snapshot outcome", () => {
    expect(outcomeIs("completed")({ result: result() }).passed).toBe(true)
    expect(outcomeIs("failed")({ result: result() }).passed).toBe(false)
  })

  test("eventType counts and noEventType absence", () => {
    const subject = { result: result({ events: [{ type: "a", payload: {} }, { type: "a", payload: {} }] }) }
    expect(eventType("a", { count: 2 })(subject).passed).toBe(true)
    expect(eventType("a", { count: 1 })(subject).passed).toBe(false)
    expect(noEventType("b")(subject).passed).toBe(true)
    expect(noEventType("a")(subject).passed).toBe(false)
  })

  test("sequenceContinuous detects gaps", () => {
    const ok = result({ events: [
      { type: "a", payload: {}, sequence: 1 },
      { type: "b", payload: {}, sequence: 2 },
    ] as never })
    expect(sequenceContinuous()({ result: ok }).passed).toBe(true)
  })

  test("allToolCallsTerminated compares requested vs terminated", () => {
    const good = result({ events: [
      { type: "tool.call.requested", payload: {} },
      { type: "tool.call.completed", payload: {} },
    ] })
    expect(allToolCallsTerminated()({ result: good }).passed).toBe(true)
    const dangling = result({ events: [{ type: "tool.call.requested", payload: {} }] })
    expect(allToolCallsTerminated()({ result: dangling }).passed).toBe(false)
  })
})
