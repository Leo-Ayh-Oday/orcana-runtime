/** G0: snapshot serialization — round-trip + redaction guarantees. */

import { describe, expect, test } from "bun:test"
import { WorkflowProjector } from "../../src/workflow/telemetry/workflow-trace"
import { serializeSnapshot, deserializeSnapshot } from "../../src/workflow/telemetry/graph-snapshot"

describe("graph-snapshot (G0)", () => {
  function sampleProjector(): WorkflowProjector {
    const projector = new WorkflowProjector("run_serial", "audit task")
    projector.observe("agent_loop_started", { maxRounds: 5, toolCount: 20 })
    projector.observe("round_started", { round: 0 })
    projector.observe("tool_call", { round: 0, id: "call_x", tool: "read_file", input: { path: "secret-file.ts" } })
    projector.observe("gate_decision", { round: 0, gate: "planning", decision: "pass" })
    projector.observe("agent_loop_finished", { reason: "orchestrator_done" })
    return projector
  }

  test("serialize → deserialize round-trips the full snapshot", () => {
    const snap = sampleProjector().snapshot()
    const parsed = deserializeSnapshot(serializeSnapshot(snap))
    expect(parsed.runId).toBe(snap.runId)
    expect(parsed.schemaVersion).toBe(snap.schemaVersion)
    expect(parsed.decision).toBe(snap.decision)
    expect(parsed.nodes).toHaveLength(snap.nodes.length)
    expect(parsed.edges).toHaveLength(snap.edges.length)
    expect(parsed.metrics).toEqual(snap.metrics)
  })

  test("serialization is stable for equal graph structures (timestamps excluded)", () => {
    const a = sampleProjector().snapshot()
    const b = sampleProjector().snapshot()
    expect(a.nodes.map(n => ({ id: n.id, kind: n.kind, name: n.name, status: n.status, round: n.round, data: n.data })))
      .toEqual(b.nodes.map(n => ({ id: n.id, kind: n.kind, name: n.name, status: n.status, round: n.round, data: n.data })))
    expect(a.edges).toEqual(b.edges)
    expect(a.metrics).toEqual(b.metrics)
  })

  test("rejects invalid payloads", () => {
    expect(() => deserializeSnapshot("not json")).toThrow()
    expect(() => deserializeSnapshot('{"schemaVersion":"9.9"}')).toThrow()
    expect(() => deserializeSnapshot('[1,2]')).toThrow()
    expect(() => deserializeSnapshot('{"schemaVersion":"0.1"}')).toThrow() // missing runId/nodes
  })

  test("no sensitive material survives serialization", () => {
    const snap = sampleProjector().snapshot()
    // Secret-style keys in projected data are redacted at the write boundary.
    const projector = new WorkflowProjector("r", "p")
    projector.observe("agent_loop_started", {})
    projector.observe("round_started", { round: 0 })
    projector.observe("tool_call", { round: 0, id: "c1", tool: "x", input: { apiKey: "sk-live-secret", path: "/etc/passwd" } })
    projector.observe("gate_decision", { round: 0, gate: "g", decision: "block", authorization: "Bearer abc" })
    const raw = serializeSnapshot(projector.snapshot())
    expect(raw).not.toContain("sk-live-secret")
    expect(raw).not.toContain("Bearer")
    expect(raw).not.toContain("/etc/passwd")
    // The whole original snapshot (with secret keys) must never leak either.
    expect(JSON.stringify(snap)).not.toContain("secret-file.ts")
  })
})
