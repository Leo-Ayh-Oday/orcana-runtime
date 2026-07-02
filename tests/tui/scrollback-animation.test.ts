/** Tests for Visual Step 1: applyPendingAnimation with classified activities.
 *
 *  Verifies:
 *    1. Static lines pass through unchanged
 *    2. pendingAnim="spinner" → classified activity glyph + stable label
 *    3. pendingAnim="tail" → tail dots appended to text
 *    4. tick rotation changes glyph but not label
 *    5. No pending → identity
 */

import { describe, expect, test } from "bun:test"
import { applyPendingAnimation } from "../../src/tui/components/Scrollback"
import type { RenderedLine } from "../../src/tui/components/MessageItem"
import { C } from "../../src/tui/theme/theme"

function line(overrides: Partial<RenderedLine> = {}): RenderedLine {
  return { marker: "|", text: "hello", color: C.blue, ...overrides }
}

describe("applyPendingAnimation (Visual Step 1)", () => {
  test("static lines pass through unchanged", () => {
    const lines = [line({ text: "hello" }), line({ text: "world" })]
    expect(applyPendingAnimation(lines, 0, "", 0)).toEqual(lines)
  })

  test("empty lines array returns empty", () => {
    expect(applyPendingAnimation([], 5, "", 0)).toEqual([])
  })

  test("spinner generates classified activity (not random verb)", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const, pendingStatus: "working" })]
    const r = applyPendingAnimation(lines, 0, "working", 0)
    expect(r.length).toBe(1)
    // Glyph comes from glyph theme (ASCII or Unicode). Verify pattern: <glyph> working
    expect(r[0]!.text).toMatch(/^. working$/)
  })

  test("glyph rotates with tick", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r0 = applyPendingAnimation(lines, 0, "working", 0)[0]!.text
    const r1 = applyPendingAnimation(lines, 1, "working", 0)[0]!.text
    const r2 = applyPendingAnimation(lines, 2, "working", 0)[0]!.text
    // Labels are stable, glyphs differ
    expect(r0).not.toBe(r1)
    expect(r1).not.toBe(r2)
  })

  test("round shows in label when > 0", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r0 = applyPendingAnimation(lines, 0, "working", 3)[0]!.text
    expect(r0).toContain("r3")
  })

  test("round not shown when 0", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r0 = applyPendingAnimation(lines, 0, "working", 0)[0]!.text
    expect(r0).not.toContain("r0")
  })

  test("tail dots appended to text", () => {
    const lines = [line({ text: "streaming", pendingAnim: "tail" as const })]
    expect(applyPendingAnimation(lines, 0, "", 0)[0]!.text).toBe("streaming")
    expect(applyPendingAnimation(lines, 1, "", 0)[0]!.text).toBe("streaming.")
    expect(applyPendingAnimation(lines, 2, "", 0)[0]!.text).toBe("streaming..")
    expect(applyPendingAnimation(lines, 3, "", 0)[0]!.text).toBe("streaming...")
    expect(applyPendingAnimation(lines, 4, "", 0)[0]!.text).toBe("streaming")
  })

  test("no pending → identity", () => {
    const lines = [line({ text: "hello" })]
    expect(applyPendingAnimation(lines, 5, "", 0)).toBe(lines)
  })

  test("routing status → 'preparing context' label", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r = applyPendingAnimation(lines, 0, "routing context", 1)[0]!.text
    expect(r).toContain("preparing context")
    expect(r).toContain("r1")
  })

  test("verifying status → 'verifying' label", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r = applyPendingAnimation(lines, 0, "typecheck running", 0)[0]!.text
    expect(r).toContain("verifying")
  })

  test("blocked status → 'blocked' label", () => {
    const lines = [line({ text: "", pendingAnim: "spinner" as const })]
    const r = applyPendingAnimation(lines, 0, "gate blocked", 0)[0]!.text
    expect(r).toContain("blocked")
  })
})
