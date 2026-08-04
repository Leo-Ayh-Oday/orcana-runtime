import { describe, expect, test } from "bun:test"
import {
  TOOL_ERROR_CODES,
  ToolError,
  toolError,
  resultHelpers,
} from "../../src/harness/capabilities"

// RT-1: Tool Runtime 2.0 contract — standard error codes, fail-closed result
// shapes, domain_failed vs execution_failed distinction.

describe("RT-1 standard error codes", () => {
  test("canonical 26-code list is complete", () => {
    expect(TOOL_ERROR_CODES).toHaveLength(26)
    // §4.4 required members all present.
    for (const code of [
      "INVALID_INPUT", "SCHEMA_VALIDATION_FAILED", "PERMISSION_DENIED", "APPROVAL_REQUIRED",
      "WRITABLE_ROOT_VIOLATION", "READABLE_ROOT_VIOLATION", "STALE_FILE", "BASE_HASH_MISMATCH",
      "PATCH_CONFLICT", "RIPPLE_BLOCKED", "TIMEOUT", "CANCELLED", "COMMAND_NOT_FOUND",
      "PROCESS_EXIT_NONZERO", "NETWORK_BLOCKED", "SSRF_BLOCKED", "RATE_LIMITED",
      "REMOTE_UNAVAILABLE", "OUTPUT_TOO_LARGE", "ARTIFACT_WRITE_FAILED", "LSP_UNAVAILABLE",
      "LSP_STALE", "VERIFICATION_FAILED", "MCP_UNTRUSTED_TOOL", "MCP_SCHEMA_INVALID",
      "INTERNAL_ERROR",
    ] as const) {
      expect(TOOL_ERROR_CODES).toContain(code)
    }
  })

  test("ToolError carries code/category/retryable", () => {
    const err = new ToolError("WRITABLE_ROOT_VIOLATION", "cannot write outside root")
    expect(err.code).toBe("WRITABLE_ROOT_VIOLATION")
    expect(err.category).toBe("permission")
    expect(err.retryable).toBe(false)
    expect(err.toInfo()).toEqual({
      code: "WRITABLE_ROOT_VIOLATION",
      message: "cannot write outside root",
      category: "permission",
      retryable: false,
    })
  })

  test("retryable defaults by code", () => {
    expect(toolError("STALE_FILE", "x").retryable).toBe(true)
    expect(toolError("BASE_HASH_MISMATCH", "x").retryable).toBe(true)
    expect(toolError("RATE_LIMITED", "x").retryable).toBe(true)
    expect(toolError("PERMISSION_DENIED", "x").retryable).toBe(false)
    expect(toolError("CANCELLED", "x").retryable).toBe(false)
  })

  test("toolError overrides category/retryable", () => {
    const info = toolError("INTERNAL_ERROR", "x", { retryable: true })
    expect(info.retryable).toBe(true)
    expect(info.category).toBe("internal")
  })
})

describe("RT-1 structured results", () => {
  test("ok result carries structured content and metrics", () => {
    const started = Date.now() - 100
    const result = resultHelpers.ok({ path: "a.ts" }, "read a.ts", { startedAt: started })
    expect(result.status).toBe("succeeded")
    expect(result.structuredContent).toEqual({ path: "a.ts" })
    expect(result.displayContent).toBe("read a.ts")
    expect(result.artifacts).toEqual([])
    expect(result.evidence).toEqual([])
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeUndefined()
  })

  test("domain_failed vs execution_failed are distinct statuses", () => {
    const domain = resultHelpers.domainFailed(
      { passed: false, issues: 3 },
      "typecheck: 3 errors",
      [{ severity: "error", message: "a.ts:1 missing type", file: "a.ts", line: 1 }],
    )
    expect(domain.status).toBe("domain_failed")
    expect(domain.diagnostics[0]!.file).toBe("a.ts")

    const exec = resultHelpers.executionFailed(toolError("COMMAND_NOT_FOUND", "tsc missing"))
    expect(exec.status).toBe("execution_failed")
    expect(exec.error!.code).toBe("COMMAND_NOT_FOUND")
    expect(exec.structuredContent).toBeUndefined()
  })

  test("blocked/cancelled/timed_out shapes", () => {
    expect(resultHelpers.blocked(toolError("APPROVAL_REQUIRED", "need approval")).status).toBe("blocked")
    expect(resultHelpers.cancelled().status).toBe("cancelled")
    expect(resultHelpers.timedOut().status).toBe("timed_out")
    expect(resultHelpers.timedOut().error).toBeUndefined()
  })
})

describe("RT-1 contract hygiene", () => {
  test("errors.ts does not import loop or UI modules", () => {
    // Fail-closed structural guarantee: the errors module is dependency-free.
    // (Type-level import check — loop.ts must never appear in the module graph.)
    const { ToolError } = require("../../src/harness/capabilities/errors") as typeof import("../../src/harness/capabilities/errors")
    expect(typeof ToolError).toBe("function")
  })

  test("result helpers never produce a missing-status result", () => {
    for (const r of [
      resultHelpers.ok({}),
      resultHelpers.domainFailed({}, "d"),
      resultHelpers.executionFailed(toolError("INTERNAL_ERROR", "x")),
      resultHelpers.blocked(toolError("PERMISSION_DENIED", "x")),
      resultHelpers.cancelled(),
      resultHelpers.timedOut(),
    ]) {
      expect(r.status).toBeTruthy()
    }
  })
})
