import { describe, expect, test } from "bun:test"
import {
  canTransition,
  assertTransition,
  LEGAL_TRANSITIONS,
  type RunStatus,
} from "../src/harness/index"

describe("Harness run lifecycle transitions", () => {
  test("legal happy path", () => {
    expect(canTransition("created", "initializing")).toBe(true)
    expect(canTransition("initializing", "running")).toBe(true)
    expect(canTransition("running", "completed")).toBe(true)
  })

  test("waiting ↔ resume path", () => {
    expect(canTransition("running", "waiting")).toBe(true)
    expect(canTransition("waiting", "resuming")).toBe(true)
    expect(canTransition("resuming", "running")).toBe(true)
  })

  test("pause path", () => {
    expect(canTransition("running", "pausing")).toBe(true)
    expect(canTransition("pausing", "paused")).toBe(true)
    expect(canTransition("paused", "resuming")).toBe(true)
  })

  test("terminal states never transition", () => {
    for (const terminal of ["completed", "failed", "cancelled", "restart_required"] as RunStatus[]) {
      expect(canTransition(terminal, "running")).toBe(false)
      expect(canTransition(terminal, "waiting")).toBe(false)
    }
  })

  test("illegal jumps are rejected", () => {
    expect(canTransition("created", "completed")).toBe(false)
    expect(canTransition("created", "running")).toBe(false)
    expect(canTransition("running", "initializing")).toBe(false)
    expect(canTransition("waiting", "completed")).toBe(false)
  })

  test("same-state transition is idempotent", () => {
    expect(canTransition("running", "running")).toBe(true)
  })

  test("assertTransition throws on illegal moves", () => {
    expect(() => assertTransition("completed", "running")).toThrow(/Illegal run transition/)
    expect(() => assertTransition("running", "running")).not.toThrow()
  })

  test("every status key appears in LEGAL_TRANSITIONS", () => {
    const statuses: RunStatus[] = [
      "created", "initializing", "running", "waiting", "pausing", "paused",
      "resuming", "blocked", "completed", "failed", "cancelled", "restart_required",
    ]
    for (const s of statuses) {
      expect(LEGAL_TRANSITIONS[s]).toBeDefined()
    }
  })
})
