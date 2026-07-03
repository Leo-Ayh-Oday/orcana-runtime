/** Tests for RuntimePanel — covers PR-5 acceptance points.
 *
 *  Points covered:
 *    1. ripplePhaseLabel: all 6 phases → correct labels
 *    2. ripplePhaseColor: all 6 phases → correct colors
 *    3. rippleWaveChar: animation frames for each phase
 *    4. isRuntimePanelEnabled: env var checking
 *    5. formatGateSummary: formatting gate summary
 *    6. formatEvidenceSummary: formatting evidence summary
 *    7. formatPatchSummary: formatting patch summary
 *    8. selectRuntimePanel: selector returns correct data
 *    9. Reducer: ripple.phase event updates state
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  ripplePhaseLabel,
  ripplePhaseColor,
  ripplePhaseShimmerColor,
  rippleWaveChar,
  isRuntimePanelEnabled,
  formatGateSummary,
  formatEvidenceSummary,
  formatPatchSummary,
} from "../../src/tui/components/RuntimePanel"
import { selectRuntimePanel } from "../../src/tui/state/selectors"
import { createInitialTuiState, reduceTuiEvent } from "../../src/tui/state/event-reducer"
import type { TuiRipplePhase } from "../../src/tui/state/types"
import { C, theme } from "../../src/tui/theme/theme"

// ── ripplePhaseLabel ──

describe("ripplePhaseLabel", () => {
  test("idle → 'idle'", () => {
    expect(ripplePhaseLabel("idle")).toBe("idle")
  })
  test("scan → 'scanning'", () => {
    expect(ripplePhaseLabel("scan")).toBe("scanning")
  })
  test("propagate → 'propagating'", () => {
    expect(ripplePhaseLabel("propagate")).toBe("propagating")
  })
  test("verify → 'verifying'", () => {
    expect(ripplePhaseLabel("verify")).toBe("verifying")
  })
  test("blocked → 'blocked'", () => {
    expect(ripplePhaseLabel("blocked")).toBe("blocked")
  })
  test("settled → 'settled'", () => {
    expect(ripplePhaseLabel("settled")).toBe("settled")
  })
})

// ── ripplePhaseColor (PR-4: 升级用 theme.* 语义色) ──

describe("ripplePhaseColor", () => {
  test("idle → textFaint", () => {
    expect(ripplePhaseColor("idle")).toBe(theme.textFaint)
  })
  test("scan → info", () => {
    expect(ripplePhaseColor("scan")).toBe(theme.info)
  })
  test("propagate → brand", () => {
    expect(ripplePhaseColor("propagate")).toBe(theme.brand)
  })
  test("verify → warning", () => {
    expect(ripplePhaseColor("verify")).toBe(theme.warning)
  })
  test("blocked → error", () => {
    expect(ripplePhaseColor("blocked")).toBe(theme.error)
  })
  test("settled → success", () => {
    expect(ripplePhaseColor("settled")).toBe(theme.success)
  })
  test("all phases return non-empty string", () => {
    const phases: TuiRipplePhase[] = ["idle", "scan", "propagate", "verify", "blocked", "settled"]
    for (const phase of phases) {
      expect(ripplePhaseColor(phase).length).toBeGreaterThan(0)
    }
  })
})

// ── ripplePhaseShimmerColor (PR-4: glimmer 扫光色) ──

describe("ripplePhaseShimmerColor (PR-4)", () => {
  test("propagate → brandShimmer（正向扫光）", () => {
    expect(ripplePhaseShimmerColor("propagate")).toBe(theme.brandShimmer)
  })
  test("verify → warningShimmer（反向扫光）", () => {
    expect(ripplePhaseShimmerColor("verify")).toBe(theme.warningShimmer)
  })
  test("settled → successShimmer", () => {
    expect(ripplePhaseShimmerColor("settled")).toBe(theme.successShimmer)
  })
  test("blocked → errorShimmer", () => {
    expect(ripplePhaseShimmerColor("blocked")).toBe(theme.errorShimmer)
  })
  test("shimmer 与 base 色不同（active 相位）", () => {
    expect(ripplePhaseShimmerColor("propagate")).not.toBe(ripplePhaseColor("propagate"))
    expect(ripplePhaseShimmerColor("verify")).not.toBe(ripplePhaseColor("verify"))
  })
})

// ── rippleWaveChar (PR-4: 走 glyph 主题双轨制，ASCII 模式默认) ──

describe("rippleWaveChar", () => {
  // ASCII 模式（默认）：idle→".", settled→"v"
  test("idle always returns '.' (ASCII)", () => {
    expect(rippleWaveChar("idle", 0)).toBe(".")
    expect(rippleWaveChar("idle", 10)).toBe(".")
    expect(rippleWaveChar("idle", 100)).toBe(".")
  })

  test("settled always returns 'v' (ASCII)", () => {
    expect(rippleWaveChar("settled", 0)).toBe("v")
    expect(rippleWaveChar("settled", 10)).toBe("v")
  })

  test("scan cycles through radar chars", () => {
    const frame0 = rippleWaveChar("scan", 0) // tick=0, frame=0
    const frame4 = rippleWaveChar("scan", 4) // tick=4, frame=2
    expect(frame0).not.toBe(frame4) // different frames
  })

  test("blocked cycles between '!' and ' '", () => {
    const frame0 = rippleWaveChar("blocked", 0) // frame=0 → "!"
    const frame4 = rippleWaveChar("blocked", 4) // frame=2 → "!"
    const frame2 = rippleWaveChar("blocked", 2) // frame=1 → " "
    expect(frame0).toBe("!")
    expect(frame2).toBe(" ")
    expect(frame4).toBe("!")
  })

  test("propagate returns 3-char string (ASCII: .../o../oo./ooo)", () => {
    const result = rippleWaveChar("propagate", 0)
    expect(result.length).toBe(3)
  })

  test("verify returns single char", () => {
    const result = rippleWaveChar("verify", 0)
    expect(result.length).toBe(1)
  })

  test("frame cycles (low-frame: every 2 ticks)", () => {
    // tick=0 and tick=1 should be same frame (frame=0)
    expect(rippleWaveChar("scan", 0)).toBe(rippleWaveChar("scan", 1))
    // tick=2 and tick=3 should be same frame (frame=1)
    expect(rippleWaveChar("scan", 2)).toBe(rippleWaveChar("scan", 3))
    // tick=0 and tick=2 should be different frames
    expect(rippleWaveChar("scan", 0)).not.toBe(rippleWaveChar("scan", 2))
  })

  // PR-4: Unicode 模式下用 ○●▁▃✓ 等
  test("Unicode 模式: idle → '·', settled → '✓'", () => {
    const prev = process.env.DEEPSEEK_TUI_UNICODE
    process.env.DEEPSEEK_TUI_UNICODE = "1"
    try {
      expect(rippleWaveChar("idle", 0)).toBe("·")
      expect(rippleWaveChar("settled", 0)).toBe("✓")
      expect(rippleWaveChar("propagate", 0)).toBe("○○○")
    } finally {
      process.env.DEEPSEEK_TUI_UNICODE = prev
    }
  })

  test("propagate 正向扩散: ... → o.. → oo. → ooo (ASCII)", () => {
    expect(rippleWaveChar("propagate", 0)).toBe("...")  // frame 0
    expect(rippleWaveChar("propagate", 2)).toBe("o..")  // frame 1
    expect(rippleWaveChar("propagate", 4)).toBe("oo.")  // frame 2
    expect(rippleWaveChar("propagate", 6)).toBe("ooo")  // frame 3
  })
})

// ── isRuntimePanelEnabled ──

describe("isRuntimePanelEnabled", () => {
  const originalEnv = process.env.DEEPSEEK_TUI_RUNTIME_PANEL

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DEEPSEEK_TUI_RUNTIME_PANEL
    } else {
      process.env.DEEPSEEK_TUI_RUNTIME_PANEL = originalEnv
    }
  })

  test("returns true when env not set", () => {
    delete process.env.DEEPSEEK_TUI_RUNTIME_PANEL
    expect(isRuntimePanelEnabled()).toBe(true)
  })

  test("returns false when env is 'off'", () => {
    process.env.DEEPSEEK_TUI_RUNTIME_PANEL = "off"
    expect(isRuntimePanelEnabled()).toBe(false)
  })

  test("returns false when env is '0'", () => {
    process.env.DEEPSEEK_TUI_RUNTIME_PANEL = "0"
    expect(isRuntimePanelEnabled()).toBe(false)
  })

  test("returns false when env is 'false'", () => {
    process.env.DEEPSEEK_TUI_RUNTIME_PANEL = "false"
    expect(isRuntimePanelEnabled()).toBe(false)
  })

  test("returns true when env is 'on'", () => {
    process.env.DEEPSEEK_TUI_RUNTIME_PANEL = "on"
    expect(isRuntimePanelEnabled()).toBe(true)
  })

  test("returns true when env is '1'", () => {
    process.env.DEEPSEEK_TUI_RUNTIME_PANEL = "1"
    expect(isRuntimePanelEnabled()).toBe(true)
  })
})

// ── formatGateSummary ──

describe("formatGateSummary", () => {
  test("empty gates → 'no gates'", () => {
    expect(formatGateSummary({ total: 0, pass: 0, block: 0, warn: 0, skip: 0 })).toBe("no gates")
  })

  test("all pass → '3 pass'", () => {
    expect(formatGateSummary({ total: 3, pass: 3, block: 0, warn: 0, skip: 0 })).toBe("3 pass")
  })

  test("mixed gates → '2 pass · 1 block · 1 skip'", () => {
    expect(formatGateSummary({ total: 4, pass: 2, block: 1, warn: 0, skip: 1 })).toBe("2 pass · 1 block · 1 skip")
  })

  test("with warn → includes warn", () => {
    expect(formatGateSummary({ total: 2, pass: 1, block: 0, warn: 1, skip: 0 })).toBe("1 pass · 1 warn")
  })

  test("all zero totals (edge case)", () => {
    expect(formatGateSummary({ total: 0, pass: 0, block: 0, warn: 0, skip: 0 })).toBe("no gates")
  })
})

// ── formatEvidenceSummary ──

describe("formatEvidenceSummary", () => {
  test("empty evidence → 'no evidence'", () => {
    expect(formatEvidenceSummary({ total: 0, passed: 0, failed: 0, blocked: 0, running: 0, skipped: 0 })).toBe("no evidence")
  })

  test("all passed → '3 passed'", () => {
    expect(formatEvidenceSummary({ total: 3, passed: 3, failed: 0, blocked: 0, running: 0, skipped: 0 })).toBe("3 passed")
  })

  test("mixed evidence → '2 passed · 1 failed · 1 running'", () => {
    expect(formatEvidenceSummary({ total: 4, passed: 2, failed: 1, blocked: 0, running: 1, skipped: 0 })).toBe("2 passed · 1 failed · 1 running")
  })

  test("with blocked and skipped", () => {
    expect(formatEvidenceSummary({ total: 3, passed: 1, failed: 0, blocked: 1, running: 0, skipped: 1 })).toBe("1 passed · 1 blocked · 1 skipped")
  })
})

// ── formatPatchSummary ──

describe("formatPatchSummary", () => {
  test("empty patches → 'no patches'", () => {
    expect(formatPatchSummary({ total: 0, proposed: 0, committed: 0, rolledBack: 0 })).toBe("no patches")
  })

  test("all committed → '3 committed'", () => {
    expect(formatPatchSummary({ total: 3, proposed: 0, committed: 3, rolledBack: 0 })).toBe("3 committed")
  })

  test("mixed patches → '1 proposed · 2 committed · 1 rolled back'", () => {
    expect(formatPatchSummary({ total: 4, proposed: 1, committed: 2, rolledBack: 1 })).toBe("1 proposed · 2 committed · 1 rolled back")
  })

  test("only proposed", () => {
    expect(formatPatchSummary({ total: 2, proposed: 2, committed: 0, rolledBack: 0 })).toBe("2 proposed")
  })
})

// ── selectRuntimePanel ──

describe("selectRuntimePanel", () => {
  test("returns idle phase for initial state", () => {
    const state = createInitialTuiState()
    const data = selectRuntimePanel(state)
    expect(data.ripplePhase).toBe("idle")
    expect(data.rippleFindings).toEqual([])
    expect(data.gateSummary.total).toBe(0)
    expect(data.evidenceSummary.total).toBe(0)
    expect(data.patchSummary.total).toBe(0)
    expect(data.activeTools).toBe(0)
  })

  test("reflects gates after gate.result events", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "gate.result", gate: "build", status: "pass" })
    state = reduceTuiEvent(state, { type: "gate.result", gate: "test", status: "block", reason: "fail" })

    const data = selectRuntimePanel(state)
    expect(data.gateSummary.total).toBe(2)
    expect(data.gateSummary.pass).toBe(1)
    expect(data.gateSummary.block).toBe(1)
  })

  test("reflects evidence after evidence.added events", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "evidence.added", kind: "test", status: "passed", summary: "tests pass" })
    state = reduceTuiEvent(state, { type: "evidence.added", kind: "lint", status: "failed", summary: "lint fail" })

    const data = selectRuntimePanel(state)
    expect(data.evidenceSummary.total).toBe(2)
    expect(data.evidenceSummary.passed).toBe(1)
    expect(data.evidenceSummary.failed).toBe(1)
  })

  test("reflects patches after patch events", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "patch.proposed", txId: "tx1", files: ["a.ts"] })
    state = reduceTuiEvent(state, { type: "patch.committed", txId: "tx1", files: ["a.ts"] })
    state = reduceTuiEvent(state, { type: "patch.proposed", txId: "tx2", files: ["b.ts"] })

    const data = selectRuntimePanel(state)
    expect(data.patchSummary.total).toBe(2)
    expect(data.patchSummary.committed).toBe(1)
    expect(data.patchSummary.proposed).toBe(1)
  })

  test("reflects active tools", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "tool.started", id: "t1", tool: "edit" })
    state = reduceTuiEvent(state, { type: "tool.started", id: "t2", tool: "run" })
    state = reduceTuiEvent(state, { type: "tool.finished", id: "t1", ok: true })

    const data = selectRuntimePanel(state)
    expect(data.activeTools).toBe(1) // t2 still running
  })
})

// ── Reducer: ripple.phase event ──

describe("ripple.phase reducer", () => {
  test("updates ripplePhase from idle to scan", () => {
    const state = createInitialTuiState()
    expect(state.ripplePhase).toBe("idle")

    const next = reduceTuiEvent(state, { type: "ripple.phase", phase: "scan" })
    expect(next.ripplePhase).toBe("scan")
  })

  test("updates through full lifecycle", () => {
    let state = createInitialTuiState()
    const phases: TuiRipplePhase[] = ["scan", "propagate", "verify", "settled"]

    for (const phase of phases) {
      state = reduceTuiEvent(state, { type: "ripple.phase", phase })
      expect(state.ripplePhase).toBe(phase)
    }
  })

  test("updates to blocked", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "ripple.phase", phase: "blocked" })
    expect(state.ripplePhase).toBe("blocked")
  })

  test("updates back to idle", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "ripple.phase", phase: "scan" })
    state = reduceTuiEvent(state, { type: "ripple.phase", phase: "idle" })
    expect(state.ripplePhase).toBe("idle")
  })

  test("does not modify other state fields", () => {
    const state = createInitialTuiState()
    const next = reduceTuiEvent(state, { type: "ripple.phase", phase: "scan" })
    expect(next.messages).toBe(state.messages)
    expect(next.gates).toBe(state.gates)
    expect(next.tokens).toEqual(state.tokens)
    expect(next.round).toBe(state.round)
  })
})
