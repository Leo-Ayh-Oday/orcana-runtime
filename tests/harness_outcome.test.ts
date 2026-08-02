import { describe, expect, test } from "bun:test"
import { outcomeKind, type RunOutcome } from "../src/harness/index"

function completed(): Extract<RunOutcome, { kind: "completed" }> {
  return { kind: "completed", reportArtifactId: "art-1", evidenceIds: ["ev-1"] }
}
function waiting(): Extract<RunOutcome, { kind: "waiting" }> {
  return { kind: "waiting", interruptId: "it-1", checkpointId: "cp-1" }
}
function paused(): Extract<RunOutcome, { kind: "paused" }> {
  return { kind: "paused", checkpointId: "cp-1", reason: "user paused" }
}
function blocked(): Extract<RunOutcome, { kind: "blocked" }> {
  return { kind: "blocked", blocker: { gate: "policy:tool_risk", reason: "high risk", blockCount: 3 } }
}
function cancelled(): Extract<RunOutcome, { kind: "cancelled" }> {
  return { kind: "cancelled", reason: "user cancelled" }
}
function failed(): Extract<RunOutcome, { kind: "failed" }> {
  return { kind: "failed", failure: { kind: "provider", message: "stream error", retryable: true } }
}
function restart(): Extract<RunOutcome, { kind: "restart_required" }> {
  return { kind: "restart_required", files: ["src/agent/loop.ts"], verificationEvidenceIds: [] }
}

describe("Harness RunOutcome", () => {
  test("every outcome kind is discriminable by a pure helper", () => {
    expect(outcomeKind(completed())).toBe("completed")
    expect(outcomeKind(waiting())).toBe("waiting")
    expect(outcomeKind(paused())).toBe("paused")
    expect(outcomeKind(blocked())).toBe("blocked")
    expect(outcomeKind(cancelled())).toBe("cancelled")
    expect(outcomeKind(failed())).toBe("failed")
    expect(outcomeKind(restart())).toBe("restart_required")
  })

  test("waiting outcome references a checkpoint for resume", () => {
    const o = waiting()
    expect(o.kind).toBe("waiting")
    expect(o.checkpointId).toBeTruthy()
  })

  test("restart_required lists runtime files needing a process restart", () => {
    const o = restart()
    expect(o.files).toContain("src/agent/loop.ts")
  })

  test("blocked outcome carries the blocking gate", () => {
    const o = blocked()
    expect(o.blocker.gate).toBe("policy:tool_risk")
    expect(o.blocker.blockCount).toBe(3)
  })
})
