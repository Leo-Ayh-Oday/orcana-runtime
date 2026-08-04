import { describe, expect, test } from "bun:test"
import { runReplayCase, runReplayPair, runReplaySuite } from "../../evals/harness/run-replay"
import { loadHrScenarios } from "../../evals/harness/scenarios"
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

  test("R1: collected events carry the real increasing sequence (HR-025 not vacuous)", async () => {
    // The sequence was dropped from RunReplayResult before R1 — this locks
    // that sequenceContinuous() sees an actual 1,2,3,… stream.
    const result = await runReplayCase(COMPLETE_CASE)
    const sequences = result.events.map((e) => e.sequence).filter((s) => s !== undefined)
    expect(sequences.length).toBeGreaterThan(0)
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1)
    }
  })
})

// ── HR scenario suite (plan §18.6) ──

describe("H12 HR scenario suite", () => {
  const all = loadHrScenarios()

  test(`loads ${all.length} first-batch scenarios (9 core + 3 dual)`, () => {
    expect(all.length).toBe(12)
    expect(all.some((c) => c.caseId === "HR-001")).toBe(true)
    expect(all.some((c) => c.caseId === "HR-024")).toBe(true)
  })

  // R1: 12 scenarios (HR-031 runs a full write+claim loop, ~9s) — the suite
  // needs a longer window than bun's 5s default.
  test("every single-run scenario passes (core + trace invariants)", async () => {
    const suite = await runReplaySuite(all, { keepWorkspaceOnFailure: true })
    expect(suite.failed).toBe(0)
    const failures = suite.results.filter((r) => !r.passed)
    if (failures.length > 0) {
      throw new Error(failures.map((f) => `${f.caseId}: ${f.failures.join("; ")}`).join("\n"))
    }
  }, 60_000)

  test("dual-run cases pass through runReplayPair", async () => {
    const [hr21, hr22] = all.filter((c) => c.caseId === "HR-021" || c.caseId === "HR-022")
    const [a, b] = await runReplayPair(hr21!, hr22!)
    expect(a.passed).toBe(true)
    expect(b.passed).toBe(true)
  })
})
