/** G4 acceptance: wording cannot bypass failure dedupe (PR-G4). */

import { describe, expect, test } from "bun:test"
import { classifyError, fingerprintFailure, ERROR_CATEGORIES } from "../../src/workflow/convergence/failure-signature"

describe("G4 failure signatures", () => {
  test("phrasing variants collapse into the same category", () => {
    expect(classifyError("transaction rolled back (nothing written): a.ts: hunk @1 did not match")).toBe("patch_conflict")
    expect(classifyError("patch rejected: hunk did not match the target file at line 3")).toBe("patch_conflict")
    expect(classifyError("apply failed: hunks did not match")).toBe("patch_conflict")
  })

  test("missing-target variants collapse into missing_target", () => {
    expect(classifyError("ENOENT: no such file or directory, open 'a.ts'")).toBe("missing_target")
    expect(classifyError("target file not found: missing.ts")).toBe("missing_target")
  })

  test("different categories produce different signatures", () => {
    const patch = { nodeId: "w:patch", status: "failed" as const, output: null, error: "hunk did not match", startedAt: 0, finishedAt: 1, durationMs: 1 }
    const missing = { ...patch, error: "no such file: a.ts" }
    expect(fingerprintFailure(patch)).toBe("w:patch|patch_conflict")
    expect(fingerprintFailure(missing)).toBe("w:patch|missing_target")
    expect(fingerprintFailure(patch)).not.toBe(fingerprintFailure(missing))
  })

  test("same category, different wording ⇒ same signature", () => {
    const a = { nodeId: "w:patch", status: "failed" as const, output: null, error: "transaction rolled back: hunk @1 did not match", startedAt: 0, finishedAt: 1, durationMs: 1 }
    const b = { nodeId: "w:patch", status: "failed" as const, output: null, error: "patch failed: hunk did not match", startedAt: 0, finishedAt: 1, durationMs: 1 }
    expect(fingerprintFailure(a)).toBe(fingerprintFailure(b))
  })

  test("empty / unknown errors fall back to unclassified", () => {
    expect(classifyError(undefined)).toBe("unclassified")
    expect(classifyError("something completely unexpected happened")).toBe("unclassified")
  })

  test("category whitelist is finite and exported", () => {
    expect(ERROR_CATEGORIES).toContain("patch_conflict")
    expect(ERROR_CATEGORIES).toContain("unclassified")
  })
})
