/** G0: shadow projection — trace events → execution graph snapshot. */

import { describe, expect, test } from "bun:test"
import { WorkflowProjector, wrapRunTrace } from "../../src/workflow/telemetry/workflow-trace"
import type { WorkflowSnapshot } from "../../src/workflow/types"

function runEvents(): Array<[string, Record<string, unknown>]> {
  return [
    ["agent_loop_started", { maxRounds: 10, toolCount: 24 }],
    ["round_started", { round: 0 }],
    ["thinking_decision", { round: 0, thinking: "high", maxTokens: 8192 }],
    ["model_selected", { round: 0, requestedModel: "deepseek-v4-pro", thinkingEnabled: true }],
    ["tool_call", { round: 0, id: "call_a1", tool: "read_file", input: { path: "src/a.ts" } }],
    ["tool_result", { id: "call_a1", round: 0, success: true, durationMs: 2 }],
    ["gate_decision", { round: 0, gate: "policy:context_budget", decision: "pass", percent: 12 }],
    ["verification_result", { round: 0, passed: true, durationMs: 300 }],
    ["round_started", { round: 1 }],
    ["tool_call", { round: 1, id: "call_b1", tool: "apply_patch", input: { path: "src/a.ts", diff: "…" } }],
    ["tool_result", { id: "call_b1", round: 1, success: false, durationMs: 5 }],
    ["gate_decision", { round: 1, gate: "completion", decision: "block", percent: 30 }],
    ["agent_loop_finished", { reason: "orchestrator_done" }],
  ]
}

describe("WorkflowProjector (G0 shadow projection)", () => {
  test("projects the full event stream into a snapshot", () => {
    const projector = new WorkflowProjector("run_g0test", "fix divide-by-zero")
    for (const [type, data] of runEvents()) projector.observe(type, data)
    const snap = projector.snapshot()

    expect(snap.schemaVersion).toBe("0.1")
    expect(snap.mode).toBe("shadow")
    expect(snap.runId).toBe("run_g0test")
    expect(snap.prompt).toBe("fix divide-by-zero")
    expect(snap.decision).toBe("orchestrator_done")
    expect(snap.finishedAt).toBeGreaterThanOrEqual(snap.startedAt)
  })

  test("node kinds: root, rounds, tools, gates, verifications", () => {
    const projector = new WorkflowProjector("r", "p")
    for (const [type, data] of runEvents()) projector.observe(type, data)
    const kinds = projector.snapshot().nodes.map(n => n.kind)

    expect(kinds).toContain("root")
    expect(kinds.filter(k => k === "round")).toHaveLength(2)
    expect(kinds.filter(k => k === "tool")).toHaveLength(2)
    expect(kinds.filter(k => k === "gate")).toHaveLength(2)
    expect(kinds.filter(k => k === "verification")).toHaveLength(1)
  })

  test("round → tool containment edges", () => {
    const projector = new WorkflowProjector("r", "p")
    for (const [type, data] of runEvents()) projector.observe(type, data)
    const snap = projector.snapshot()

    const toolEdges = snap.edges.filter(e => e.to.startsWith("tool:"))
    expect(toolEdges).toHaveLength(2)
    expect(toolEdges.every(e => e.from === "round:0" || e.from === "round:1")).toBe(true)
    expect(snap.edges.filter(e => e.from === "root:run")).toHaveLength(2) // round:0, round:1
  })

  test("tool nodes carry input KEY summaries, never raw values", () => {
    const projector = new WorkflowProjector("r", "p")
    for (const [type, data] of runEvents()) projector.observe(type, data)
    const snap = projector.snapshot()

    const readFile = snap.nodes.find(n => n.id === "tool:call_a1")
    expect(readFile?.data).toEqual({ inputKeys: ["path"] })
    expect(JSON.stringify(snap)).not.toContain("src/a.ts")
  })

  test("tool terminal status and failure metrics", () => {
    const projector = new WorkflowProjector("r", "p")
    for (const [type, data] of runEvents()) projector.observe(type, data)
    const snap = projector.snapshot()

    expect(snap.nodes.find(n => n.id === "tool:call_a1")?.status).toBe("done")
    expect(snap.nodes.find(n => n.id === "tool:call_b1")?.status).toBe("failed")
    expect(snap.metrics.toolCalls).toBe(2)
    expect(snap.metrics.toolFailures).toBe(1)
  })

  test("gate nodes accumulate decisions; blocks counted", () => {
    const projector = new WorkflowProjector("r", "p")
    const events: Array<[string, Record<string, unknown>]> = [
      ["agent_loop_started", { maxRounds: 3 }],
      ["round_started", { round: 0 }],
      ["gate_decision", { round: 0, gate: "planning", decision: "revise" }],
      ["gate_decision", { round: 0, gate: "planning", decision: "accepted" }],
    ]
    for (const [type, data] of events) projector.observe(type, data)

    const snap = projector.snapshot()
    const gate = snap.nodes.find(n => n.id === "gate:0:planning")
    expect(gate?.data?.decisions).toEqual(["revise", "accepted"])
    expect(snap.metrics.gateDecisions).toBe(2)
    expect(snap.metrics.gateBlocks).toBe(0)

    const blocked = new WorkflowProjector("r2", "p")
    for (const [type, data] of runEvents()) blocked.observe(type, data)
    expect(blocked.snapshot().metrics.gateBlocks).toBe(1)
  })

  test("verification node status follows passed/success", () => {
    const projector = new WorkflowProjector("r", "p")
    for (const [type, data] of runEvents()) projector.observe(type, data)
    const snap = projector.snapshot()
    expect(snap.nodes.find(n => n.kind === "verification")?.status).toBe("done")
  })

  test("terminal events: finished → done root, aborted → failed root", () => {
    const ok = new WorkflowProjector("r1", "p")
    for (const [type, data] of runEvents()) ok.observe(type, data)
    expect(ok.snapshot().nodes.find(n => n.kind === "root")?.status).toBe("done")

    const aborted = new WorkflowProjector("r2", "p")
    aborted.observe("agent_loop_started", {})
    aborted.observe("round_started", { round: 0 })
    aborted.observe("agent_loop_aborted", { round: 0, reason: "aborted" })
    const snap = aborted.snapshot()
    expect(snap.nodes.find(n => n.kind === "root")?.status).toBe("failed")
    expect(snap.decision).toBe("aborted")
  })

  test("observe never throws on malformed payloads", () => {
    const projector = new WorkflowProjector("r", "p")
    projector.observe("tool_call", { id: 42, tool: 7, input: "nope" })
    projector.observe("gate_decision", null)
    projector.observe("token_usage", { inputTokens: "n/a" })
    expect(projector.snapshot().nodes.length).toBeGreaterThan(0)
  })

  test("token metering numbers survive projection (redactor-exempt)", () => {
    const projector = new WorkflowProjector("r", "p")
    projector.observe("agent_loop_started", {})
    projector.observe("round_started", { round: 0 })
    projector.observe("token_usage", { inputTokens: 123456, outputTokens: 2345, cacheHitRate: 42 })
    const round = projector.snapshot().nodes.find(n => n.id === "round:0")
    expect(round?.data?.token_usage).toMatchObject({ inputTokens: 123456, cacheHitRate: 42 })
  })
})

describe("wrapRunTrace (G0 wiring)", () => {
  test("off mode returns the trace unchanged (zero overhead)", () => {
    const trace = { record: () => {}, runId: "r", file: "/tmp/.orcana/runs/r.jsonl" }
    const { trace: wrapped, projector } = wrapRunTrace(trace, "off", "prompt")
    expect(wrapped).toBe(trace)
    expect(projector).toBeUndefined()
  })

  test("shadow mode delegates records to both channels", () => {
    const innerRecords: string[] = []
    const trace = {
      record: (type: string) => { innerRecords.push(type) },
      runId: "r",
      file: "/tmp/.orcana/runs/r.jsonl",
    }
    const { trace: wrapped, projector } = wrapRunTrace(trace, "shadow", "hello")
    expect(projector).toBeDefined()
    expect(wrapped).not.toBe(trace)

    wrapped.record("agent_loop_started", {})
    wrapped.record("agent_loop_finished", { reason: "done" })
    expect(innerRecords).toEqual(["agent_loop_started", "agent_loop_finished"])
    expect(projector!.snapshot().nodes.find(n => n.kind === "root")?.status).toBe("done")
  })

  test("snapshot types are complete (WorkflowSnapshot contract)", () => {
    const projector = new WorkflowProjector("r", "p")
    projector.observe("agent_loop_started", {})
    projector.observe("round_started", { round: 0 })
    const snap: WorkflowSnapshot = projector.snapshot()
    expect(snap.metrics).toMatchObject({ rounds: 1, toolCalls: 0, toolFailures: 0, gateDecisions: 0, gateBlocks: 0, verifications: 0, planNodes: 0 })
    expect(snap.nodes[0]!.round).toBe(-1) // root
  })
})
