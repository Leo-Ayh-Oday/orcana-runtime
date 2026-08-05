/** G1: deterministic reducers + snapshot compiler bridge. */

import { describe, expect, test } from "bun:test"
import { dedupeValues, mergeDiagnostics } from "../../src/workflow/reducers/dedupe"
import { compileFromSnapshot } from "../../src/workflow/compiler/snapshot-compiler"
import { WorkflowProjector } from "../../src/workflow/telemetry/workflow-trace"

describe("G1 reducers", () => {
  test("reduce.dedupe: deep equality, keeps first occurrence", () => {
    const input = [{ a: 1 }, { a: 1 }, { a: 2 }, "x", "x", { b: 1, a: 1 }]
    expect(dedupeValues(input)).toEqual([{ a: 1 }, { a: 2 }, "x", { a: 1, b: 1 }])
  })

  test("reduce.merge_diagnostics: stable sort by (path, line)", () => {
    const merged = mergeDiagnostics([
      [{ path: "b.ts", line: 2 }, { path: "a.ts", line: 10 }],
      undefined,
      [{ path: "a.ts", line: 1 }],
    ])
    expect(merged).toEqual([
      { path: "a.ts", line: 1 },
      { path: "a.ts", line: 10 },
      { path: "b.ts", line: 2 },
    ])
  })
})

describe("G1 snapshot compiler bridge", () => {
  test("compiles read-only tool nodes from a G0 snapshot", () => {
    const projector = new WorkflowProjector("run-c", "prompt")
    projector.observe("agent_loop_started", {})
    projector.observe("round_started", { round: 0 })
    projector.observe("tool_call", { round: 0, id: "c1", tool: "read_file", input: { path: "a.ts" } })
    projector.observe("tool_call", { round: 0, id: "c2", tool: "git_status", input: {} })
    projector.observe("tool_result", { id: "c1", success: true })
    projector.observe("tool_result", { id: "c2", success: true })

    const spec = compileFromSnapshot(projector.snapshot())
    expect(spec.nodes).toHaveLength(2)
    expect(spec.nodes.map(n => n.handler).sort()).toEqual(["tool.git_status", "tool.read_file"])
    expect(spec.nodes.every(n => n.dependsOn.length === 0)).toBe(true)
  })

  test("write tools in the snapshot are rejected", () => {
    const projector = new WorkflowProjector("run-w", "p")
    projector.observe("agent_loop_started", {})
    projector.observe("round_started", { round: 0 })
    projector.observe("tool_call", { round: 0, id: "w1", tool: "apply_patch", input: {} })
    expect(() => compileFromSnapshot(projector.snapshot())).toThrow(/apply_patch/)
  })

  test("gate/verification/round nodes are skipped", () => {
    const projector = new WorkflowProjector("run-g", "p")
    projector.observe("agent_loop_started", {})
    projector.observe("round_started", { round: 0 })
    projector.observe("gate_decision", { round: 0, gate: "planning", decision: "pass" })
    projector.observe("verification_result", { round: 0, passed: true })
    projector.observe("tool_call", { round: 0, id: "c1", tool: "read_file", input: {} })
    projector.observe("tool_result", { id: "c1", success: true })

    const spec = compileFromSnapshot(projector.snapshot())
    expect(spec.nodes).toHaveLength(1)
    expect(spec.nodes[0]!.handler).toBe("tool.read_file")
  })
})
