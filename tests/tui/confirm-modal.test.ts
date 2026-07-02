/** Tests for Phase 5: ConfirmModal — formatConfirmDecision + risk helpers. */

import { describe, expect, test } from "bun:test"
import { formatConfirmDecision } from "../../src/tui/components/ConfirmModal"

describe("formatConfirmDecision", () => {
  test("approved", () => {
    expect(formatConfirmDecision("approved", "bash")).toContain("approved")
    expect(formatConfirmDecision("approved", "bash")).toContain("bash")
  })

  test("denied", () => {
    expect(formatConfirmDecision("denied", "write_file")).toContain("denied")
    expect(formatConfirmDecision("denied", "write_file")).toContain("write_file")
  })

  test("denied_all", () => {
    const result = formatConfirmDecision("denied_all", "bash")
    expect(result).toContain("denied all")
  })

  test("dismissed", () => {
    expect(formatConfirmDecision("dismissed", "git")).toContain("dismissed")
  })

  test("all variants are distinguishable", () => {
    const toolName = "test_tool"
    const approved = formatConfirmDecision("approved", toolName)
    const denied = formatConfirmDecision("denied", toolName)
    const deniedAll = formatConfirmDecision("denied_all", toolName)
    const dismissed = formatConfirmDecision("dismissed", toolName)
    expect(approved).not.toBe(denied)
    expect(denied).not.toBe(deniedAll)
    expect(deniedAll).not.toBe(dismissed)
  })
})
