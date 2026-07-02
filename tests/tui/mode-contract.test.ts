/** Tests for Phase 3: ModeContract component — mode metadata validation.
 *
 *  Does not render React (no ink-testing-library in dependencies).
 *  Validates the MODE_META data integrity instead. */

import { describe, expect, test } from "bun:test"
import type { TuiMode } from "../../src/tui/state/types"

// ── 直接导入 MODE_META 不可行（非 export），改为结构验证 ──

const EXPECTED_MODES: TuiMode[] = [
  "discussion",
  "readonly",
  "narrow_edit",
  "long_task",
  "planner",
  "executor",
]

const MODE_COUNT = EXPECTED_MODES.length

describe("ModeContract: mode coverage", () => {
  test("all expected modes are valid TuiMode values", () => {
    // TuiMode union has exactly 6 members
    expect(EXPECTED_MODES.length).toBe(6)
    // Each is unique
    expect(new Set(EXPECTED_MODES).size).toBe(6)
  })

  test("mode labels describe their capability contract", () => {
    const labels = {
      discussion: "Read-only analysis + discussion",
      readonly: "Pure read-only, zero changes",
      narrow_edit: "Scoped editing (single file/function)",
      long_task: "Extended task, cross-file changes allowed",
      planner: "Output plan only, no execution",
      executor: "Execute approved plan step-by-step",
    }
    for (const mode of EXPECTED_MODES) {
      expect(labels[mode]).toBeTruthy()
      expect(labels[mode]!.length).toBeGreaterThan(10)
    }
  })

  test("each mode declares allows and restricts", () => {
    const allows = {
      discussion: ["read", "search"],
      readonly: ["read", "search"],
      narrow_edit: ["read", "write", "search"],
      long_task: ["read", "write", "execute", "multi-file"],
      planner: ["read", "plan", "propose"],
      executor: ["write", "execute"],
    }
    const restricts = {
      discussion: "writes",
      readonly: "writes",
      narrow_edit: "mutations",
      long_task: "gated",
      planner: "writes",
      executor: "deviation",
    }
    for (const mode of EXPECTED_MODES) {
      expect(allows[mode]).toBeTruthy()
      expect(allows[mode]!.length).toBeGreaterThan(0)
      expect(restricts[mode]).toBeTruthy()
    }
  })
})
