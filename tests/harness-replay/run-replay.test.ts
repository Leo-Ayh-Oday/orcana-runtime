import { describe, expect, test } from "bun:test"
import { runReplayCase } from "../../evals/harness/run-replay"
import type { RunReplayCase } from "../../evals/harness/contracts"

// H12 Tier 2: end-to-end run replay — scripted provider/tools/workspace
// through the full AgentHarness lifecycle, asserted on outcome/events/budget.

const SAVED_FLASH_TRIAGE = process.env.ORCANA_FLASH_TRIAGE
process.env.ORCANA_FLASH_TRIAGE = "off"

const COMPLETE_CASE: RunReplayCase = {
  caseId: "smoke-complete",
  input: { prompt: "probe then summarize", maxRounds: 2 },
  initialWorkspace: { "readme.md": "hello" },
  providerScript: [
    { type: "usage", input: 100, output: 20 },
    { type: "tool_call", name: "baseline_probe", input: { q: 1 } },
    { type: "round_end" },
    { type: "usage", input: 50, output: 10 },
    { type: "text", data: "probed" },
    { type: "round_end" },
  ],
  expected: {
    outcome: { kind: "completed" },
    events: [
      { type: "tool.call.requested", count: 1 },
      { type: "tool.call.completed", count: 1 },
      { type: "text.emitted", minCount: 1 },
    ],
    artifacts: { minCount: 0 },
    workspace: { noAdditionalFiles: true },
    budget: { used: { modelCalls: 2, toolCalls: 1 } },
  },
}

const CANCELLED_CASE: RunReplayCase = {
  caseId: "smoke-cancelled",
  input: { prompt: "probe", maxRounds: 2 },
  initialWorkspace: {},
  providerScript: [
    { type: "usage", input: 100, output: 20 },
    { type: "tool_call", name: "baseline_probe", input: {} },
    { type: "round_end" },
    { type: "usage", input: 50, output: 10 },
    { type: "text", data: "done" },
    { type: "round_end" },
  ],
  expected: {
    outcome: { kind: "completed" },
    events: [{ type: "tool.call.completed", count: 1 }],
    artifacts: { minCount: 0 },
    workspace: {},
  },
}

const BUDGET_CASE: RunReplayCase = {
  caseId: "smoke-budget",
  input: { prompt: "probe", maxRounds: 2, budget: { maxToolCalls: 0 } },
  initialWorkspace: {},
  providerScript: [
    { type: "usage", input: 100, output: 20 },
    { type: "tool_call", name: "baseline_probe", input: {} },
    { type: "round_end" },
    { type: "text", data: "never" },
    { type: "round_end" },
  ],
  expected: {
    outcome: { kind: "cancelled", payload: { reason: "tool_call_budget" } },
    events: [{ type: "run.cancelled", count: 1 }],
    artifacts: { minCount: 0 },
    workspace: {},
    budget: { exhausted: true, reason: "tool_call_budget" },
  },
}

describe("H12 run replay executor", () => {
  test("smoke: scripted complete run passes expectations and invariants", async () => {
    const result = await runReplayCase(COMPLETE_CASE)
    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.snapshot.status).toBe("completed")
    expect(result.snapshot.outcome?.kind).toBe("completed")
  })

  test("smoke: cancelled run with budget reason", async () => {
    const result = await runReplayCase(BUDGET_CASE)
    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
    expect(result.snapshot.outcome?.kind).toBe("cancelled")
  })

  test("basic case runs end to end", async () => {
    const result = await runReplayCase(CANCELLED_CASE)
    expect(result.passed).toBe(true)
    expect(result.failures).toEqual([])
  })

  test("invalid case fails fast with structural issues", async () => {
    const result = await runReplayCase({
      caseId: "bad",
      input: { prompt: "x" },
      initialWorkspace: {},
      providerScript: [],
      expected: { outcome: { kind: "completed" }, events: [], artifacts: {}, workspace: {} },
    })
    expect(result.passed).toBe(false)
    expect(result.failures.some((f) => f.includes("providerScript"))).toBe(true)
  })
})
