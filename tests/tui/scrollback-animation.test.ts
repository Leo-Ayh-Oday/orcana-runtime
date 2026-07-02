/** Tests for Phase 4: applyPendingAnimation — scrollback animation layer.
 *
 *  Verifies:
 *    1. Static lines pass through unchanged
 *    2. pendingAnim="spinner" → braille spinner + verb + status
 *    3. pendingAnim="tail" → tail dots appended to text
 *    4. Multiple pending lines in one viewport
 *    5. tick rotation produces different animations
 *    6. No pending → identity (no allocation overhead)
 */

import { describe, expect, test } from "bun:test"
import { applyPendingAnimation } from "../../src/tui/components/Scrollback"
import type { RenderedLine } from "../../src/tui/components/MessageItem"
import { C } from "../../src/tui/theme/theme"

function line(overrides: Partial<RenderedLine> = {}): RenderedLine {
  return {
    marker: "|",
    text: "hello",
    color: C.blue,
    ...overrides,
  }
}

describe("applyPendingAnimation", () => {
  test("static lines pass through unchanged", () => {
    const lines = [line({ text: "hello" }), line({ text: "world" })]
    const result = applyPendingAnimation(lines, 0)
    expect(result).toEqual(lines)
  })

  test("empty lines array returns empty", () => {
    expect(applyPendingAnimation([], 5)).toEqual([])
  })

  test("pendingAnim='spinner' generates braille spinner with verb", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const, pendingStatus: "working" })]
    const result = applyPendingAnimation(lines, 0)
    expect(result.length).toBe(1)
    // tick 0 → "⠋ thinking · working"
    expect(result[0]!.text).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (thinking|routing|reading|checking) · working$/)
  })

  test("spinner verb rotates with tick", () => {
    const verbs = ["thinking", "routing", "reading", "checking"]
    const lines = [line({ text: "", pendingAnim: "spinner" as const, pendingStatus: "" })]
    for (let tick = 0; tick < 4; tick++) {
      const result = applyPendingAnimation(lines, tick)
      expect(result[0]!.text).toContain(verbs[tick]!)
    }
  })

  test("spinner char rotates with tick", () => {
    const spinnerChars = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
    const lines = [line({ text: "", pendingAnim: "spinner" as const, pendingStatus: "" })]
    // Test 10 ticks to cover full spinner cycle
    for (let tick = 0; tick < 10; tick++) {
      const result = applyPendingAnimation(lines, tick)
      const expectedChar = spinnerChars[tick % 10]
      expect(result[0]!.text.startsWith(expectedChar!)).toBe(true)
    }
  })

  test("pendingAnim='tail' appends dots to text", () => {
    const lines = [line({ text: "streaming output", pendingAnim: "tail" as const })]
    const result = applyPendingAnimation(lines, 0)
    expect(result[0]!.text).toBe("streaming output") // tick 0 → ""

    const result1 = applyPendingAnimation(lines, 1)
    expect(result1[0]!.text).toBe("streaming output.") // tick 1 → "."

    const result2 = applyPendingAnimation(lines, 2)
    expect(result2[0]!.text).toBe("streaming output..") // tick 2 → ".."

    const result3 = applyPendingAnimation(lines, 3)
    expect(result3[0]!.text).toBe("streaming output...") // tick 3 → "..."
  })

  test("tail dots cycle every 4 ticks", () => {
    const lines = [line({ text: "x", pendingAnim: "tail" as const })]
    const tails = ["", ".", "..", "..."]
    for (let tick = 0; tick < 8; tick++) {
      const result = applyPendingAnimation(lines, tick)
      expect(result[0]!.text).toBe("x" + tails[tick % 4])
    }
  })

  test("multiple pending lines in one batch all animated", () => {
    const lines: RenderedLine[] = [
      line({ text: "", pendingAnim: "spinner", pendingStatus: "building" }),
      line({ text: "streaming", pendingAnim: "tail" }),
    ]
    const result = applyPendingAnimation(lines, 1)
    expect(result.length).toBe(2)
    expect(result[0]!.text).toContain("routing")
    expect(result[0]!.text).toContain("building")
    expect(result[1]!.text).toBe("streaming.")
  })

  test("no pending lines → returns same array reference (no allocation)", () => {
    const lines = [line({ text: "hello" })]
    const result = applyPendingAnimation(lines, 5)
    expect(result).toBe(lines) // identity check
  })

  test("non-pending lines with pendingAnim=undefined are unchanged", () => {
    const lines: RenderedLine[] = [
      { marker: ">", text: "user message", color: C.cyan },
      { marker: "|", text: "assistant message", color: C.blue },
    ]
    const result = applyPendingAnimation(lines, 3)
    expect(result).toEqual(lines)
  })
})
