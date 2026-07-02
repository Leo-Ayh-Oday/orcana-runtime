import { describe, expect, test } from "bun:test"
import { createInitialTuiState, reduceTuiEvent } from "../src/tui/state/event-reducer"
import {
  selectEvidenceSummary,
  selectGateSummary,
  selectHeaderStatus,
  selectRecentTools,
  selectRightRail,
  selectVisibleMessages,
} from "../src/tui/state/selectors"

describe("TUI state selectors", () => {
  test("selectVisibleMessages returns scroll metadata without mutating messages", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "ui.event_message", kind: "tool", text: "one\ntwo\nthree" }, 100)
    state = reduceTuiEvent(state, { type: "ui.event_message", kind: "plan", text: "four" }, 200)

    const view = selectVisibleMessages(state, { height: 2, scrollOffset: 10 })

    expect(view.messages).toBe(state.messages)
    expect(view.maxOffset).toBe(2)
    expect(view.normalizedOffset).toBe(2)
    expect(view.hiddenAbove).toBe(true)
    expect(view.hiddenBelow).toBe(false)
  })

  test("selectRecentTools preserves chronological order", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "tool.started", id: "1", tool: "read_file" }, 100)
    state = reduceTuiEvent(state, { type: "tool.started", id: "2", tool: "typecheck" }, 200)
    state = reduceTuiEvent(state, { type: "tool.started", id: "3", tool: "build" }, 300)

    expect(selectRecentTools(state, 2).map(tool => tool.tool)).toEqual(["typecheck", "build"])
    expect(selectRecentTools(state, 0)).toEqual([])
  })

  test("evidence and gate summaries classify status buckets", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "evidence.added", kind: "test", status: "passed", summary: "ok" }, 100)
    state = reduceTuiEvent(state, { type: "evidence.added", kind: "build", status: "failed", summary: "bad" }, 200)
    state = reduceTuiEvent(state, { type: "evidence.added", kind: "lint", status: "skipped", summary: "skip" }, 300)
    state = reduceTuiEvent(state, { type: "gate.result", gate: "quality", status: "pass" }, 400)
    state = reduceTuiEvent(state, { type: "gate.result", gate: "ripple", status: "block" }, 500)
    state = reduceTuiEvent(state, { type: "gate.result", gate: "budget", status: "skip" }, 600)

    expect(selectEvidenceSummary(state)).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 })
    expect(selectGateSummary(state)).toEqual({ total: 3, pass: 1, block: 1, warn: 0, skip: 1 })
  })

  test("header and right rail selectors project dashboard data", () => {
    let state = createInitialTuiState()
    state = {
      ...state,
      status: "working",
      modelName: "deepseek-v4-pro",
      errorLine: "",
      done: false,
      queueCount: 1,
      task: { phase: "building", done: 2, total: 3, current: "wire selectors" },
      round: 4,
      tokens: { ...state.tokens, inputTokens: 900, contextMax: 1000, cacheHitRate: 80 },
      cacheHitHistory: [20, 80],
      dashToolHistory: [{ name: "typecheck", status: "done" }],
      rippleFindings: [{ file: "src/a.ts", severity: "warn", reason: "signature" }],
    }

    expect(selectHeaderStatus(state)).toEqual({
      status: "working",
      modelName: "deepseek-v4-pro",
      error: "",
      done: false,
      queueCount: 1,
    })
    expect(selectRightRail(state)).toMatchObject({
      round: 4,
      contextTokens: 900,
      contextMax: 1000,
      cacheHitRate: 80,
      taskProgress: { done: 2, total: 3, current: "wire selectors" },
    })
  })
})
