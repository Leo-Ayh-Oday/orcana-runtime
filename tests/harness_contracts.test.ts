import { describe, expect, test } from "bun:test"
import {
  HARNESS_EVENT_SCHEMA_VERSION,
  HARNESS_EVENT_TYPES,
  HarnessError,
  SessionNotFoundError,
  RunNotFoundError,
  TERMINAL_RUN_STATUSES,
  isTerminalRunStatus,
  type RunStatus,
} from "../src/harness/index"

describe("Harness contracts", () => {
  test("event schema version is stable at 1", () => {
    expect(HARNESS_EVENT_SCHEMA_VERSION).toBe(1)
  })

  test("event type names form a stable protocol surface", () => {
    expect(HARNESS_EVENT_TYPES.runCreated).toBe("run.created")
    expect(HARNESS_EVENT_TYPES.runCompleted).toBe("run.completed")
    expect(HARNESS_EVENT_TYPES.toolCallRequested).toBe("tool.call.requested")
    expect(HARNESS_EVENT_TYPES.checkpointSaved).toBe("checkpoint.saved")
  })

  test("terminal run statuses are exactly the four non-recoverable states", () => {
    const expected: RunStatus[] = ["cancelled", "completed", "failed", "restart_required"]
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(expected.sort())
    for (const s of TERMINAL_RUN_STATUSES) expect(isTerminalRunStatus(s)).toBe(true)
    expect(isTerminalRunStatus("running")).toBe(false)
    expect(isTerminalRunStatus("waiting")).toBe(false)
  })

  test("HarnessError carries a typed kind and optional runId", () => {
    const err = new HarnessError("storage_failure", "disk full", "run-1")
    expect(err.name).toBe("HarnessError")
    expect(err.kind).toBe("storage_failure")
    expect(err.runId).toBe("run-1")
    expect(err.message).toBe("disk full")
  })

  test("typed error subclasses set their kind", () => {
    expect(new SessionNotFoundError("sess-1").kind).toBe("session_not_found")
    expect(new RunNotFoundError("run-1").runId).toBe("run-1")
  })
})
