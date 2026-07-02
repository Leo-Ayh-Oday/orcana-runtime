/** Tests for selectors — covers PR-1 acceptance point 8 (scrollOffset/height)
 *  and the remaining 6 selectors.
 *
 *  Selectors are pure: (state, ...opts) => viewData.
 */

import { describe, expect, test } from "bun:test"
import { createInitialTuiState, reduceTuiEvent } from "../../src/tui/state/event-reducer"
import type { TuiState } from "../../src/tui/state/types"
import {
  selectVisibleMessages,
  selectRecentTools,
  selectEvidenceSummary,
  selectGateSummary,
  selectHeaderStatus,
  selectRightRail,
} from "../../src/tui/state/selectors"

// ── Helpers ──

function buildState(build: (state: TuiState) => void): TuiState {
  const state = createInitialTuiState()
  build(state)
  return state
}

// ── selectVisibleMessages (acceptance point 8) ──

describe("selectors: selectVisibleMessages scrollOffset/height", () => {
  test("empty state: maxOffset=0, normalizedOffset=0, no hidden content", () => {
    const state = buildState(s => {
      s.messages = []
    })
    const result = selectVisibleMessages(state, { height: 10, scrollOffset: 0 })
    expect(result.messages).toEqual([])
    expect(result.maxOffset).toBe(0)
    expect(result.normalizedOffset).toBe(0)
    expect(result.hiddenAbove).toBe(false)
    expect(result.hiddenBelow).toBe(false)
  })

  test("content fits viewport: maxOffset=0, normalizedOffset=0", () => {
    const state = buildState(s => {
      s.messages = [
        { id: "m1", role: "user", text: "hello", createdAt: 0 },
        { id: "m2", role: "assistant", text: "hi there", createdAt: 1 },
      ]
    })
    // 2 messages, ~2 lines total (each message is 1 line by \n estimation)
    const result = selectVisibleMessages(state, { height: 10, scrollOffset: 0 })
    expect(result.maxOffset).toBe(0) // totalLines (2) - height (10) < 0 → 0
    expect(result.normalizedOffset).toBe(0)
    expect(result.hiddenAbove).toBe(false)
    expect(result.hiddenBelow).toBe(false)
  })

  test("content exceeds viewport: maxOffset = totalLines - height", () => {
    const state = buildState(s => {
      // 5 messages, each with 4 lines → 20 total lines
      s.messages = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        role: "user" as const,
        text: "line1\nline2\nline3\nline4",
        createdAt: i,
      }))
    })
    const result = selectVisibleMessages(state, { height: 10, scrollOffset: 0 })
    expect(result.maxOffset).toBe(10) // 20 - 10
    expect(result.normalizedOffset).toBe(0)
    expect(result.hiddenAbove).toBe(false)
    expect(result.hiddenBelow).toBe(true) // there's content below the viewport
  })

  test("scrollOffset > 0 shows hidden above", () => {
    const state = buildState(s => {
      s.messages = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        role: "user" as const,
        text: "line1\nline2\nline3\nline4",
        createdAt: i,
      }))
    })
    const result = selectVisibleMessages(state, { height: 10, scrollOffset: 5 })
    expect(result.maxOffset).toBe(10)
    expect(result.normalizedOffset).toBe(5)
    expect(result.hiddenAbove).toBe(true)
    expect(result.hiddenBelow).toBe(true) // 5 < 10, still content below
  })

  test("scrollOffset at max hides nothing below", () => {
    const state = buildState(s => {
      s.messages = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        role: "user" as const,
        text: "line1\nline2\nline3\nline4",
        createdAt: i,
      }))
    })
    const result = selectVisibleMessages(state, { height: 10, scrollOffset: 10 })
    expect(result.maxOffset).toBe(10)
    expect(result.normalizedOffset).toBe(10)
    expect(result.hiddenAbove).toBe(true)
    expect(result.hiddenBelow).toBe(false)
  })

  test("scrollOffset clamped to maxOffset", () => {
    const state = buildState(s => {
      s.messages = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        role: "user" as const,
        text: "line1\nline2\nline3\nline4",
        createdAt: i,
      }))
    })
    // scrollOffset way beyond maxOffset
    const result = selectVisibleMessages(state, { height: 10, scrollOffset: 1000 })
    expect(result.normalizedOffset).toBe(10) // clamped to maxOffset
    expect(result.hiddenAbove).toBe(true)
    expect(result.hiddenBelow).toBe(false)
  })

  test("negative scrollOffset normalized to 0", () => {
    const state = buildState(s => {
      s.messages = Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        role: "user" as const,
        text: "line1\nline2\nline3\nline4",
        createdAt: i,
      }))
    })
    const result = selectVisibleMessages(state, { height: 10, scrollOffset: -5 })
    expect(result.normalizedOffset).toBe(0)
    expect(result.hiddenAbove).toBe(false)
  })

  test("returns all messages (component handles line-level slicing)", () => {
    const state = buildState(s => {
      s.messages = [
        { id: "m1", role: "user", text: "a", createdAt: 0 },
        { id: "m2", role: "assistant", text: "b", createdAt: 1 },
        { id: "m3", role: "user", text: "c", createdAt: 2 },
      ]
    })
    const result = selectVisibleMessages(state, { height: 10, scrollOffset: 0 })
    expect(result.messages).toHaveLength(3)
    expect(result.messages).toBe(state.messages)
  })

  test("multi-line message: estimateMessageLines counts by \\n", () => {
    const state = buildState(s => {
      // 1 message with 10 lines → 10 total lines
      s.messages = [
        { id: "m1", role: "user", text: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10", createdAt: 0 },
      ]
    })
    const result = selectVisibleMessages(state, { height: 5, scrollOffset: 0 })
    expect(result.maxOffset).toBe(5) // 10 - 5
  })
})

// ── selectRecentTools ──

describe("selectors: selectRecentTools", () => {
  test("returns tools in chronological order (newest at end)", () => {
    const state = buildState(s => {
      s.tools = [
        { id: "t1", tool: "read_file", status: "passed" },
        { id: "t2", tool: "write_file", status: "failed" },
        { id: "t3", tool: "bash", status: "running" },
      ] as TuiState["tools"]
    })
    const result = selectRecentTools(state, 10)
    expect(result).toHaveLength(3)
    expect(result[0]!.id).toBe("t1")
    expect(result[2]!.id).toBe("t3") // newest at end
  })

  test("limit returns only the last N tools", () => {
    const state = buildState(s => {
      s.tools = Array.from({ length: 10 }, (_, i) => ({
        id: `t${i}`,
        tool: `tool_${i}`,
        status: "passed" as const,
      }))
    })
    const result = selectRecentTools(state, 3)
    expect(result).toHaveLength(3)
    expect(result[0]!.id).toBe("t7") // last 3 = t7, t8, t9
    expect(result[2]!.id).toBe("t9")
  })

  test("limit=0 returns empty array", () => {
    const state = buildState(s => {
      s.tools = [{ id: "t1", tool: "x", status: "passed" }] as TuiState["tools"]
    })
    expect(selectRecentTools(state, 0)).toEqual([])
  })

  test("negative limit returns empty array", () => {
    const state = buildState(s => {
      s.tools = [{ id: "t1", tool: "x", status: "passed" }] as TuiState["tools"]
    })
    expect(selectRecentTools(state, -5)).toEqual([])
  })

  test("limit larger than tools length returns all", () => {
    const state = buildState(s => {
      s.tools = [{ id: "t1", tool: "x", status: "passed" }] as TuiState["tools"]
    })
    const result = selectRecentTools(state, 100)
    expect(result).toHaveLength(1)
  })

  test("empty tools array returns empty array", () => {
    const state = buildState(() => {})
    expect(selectRecentTools(state, 10)).toEqual([])
  })
})

// ── selectEvidenceSummary ──

describe("selectors: selectEvidenceSummary", () => {
  test("empty evidence: all zeros", () => {
    const state = buildState(() => {})
    const result = selectEvidenceSummary(state)
    expect(result).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 })
  })

  test("counts each status correctly", () => {
    const state = buildState(s => {
      s.evidence = [
        { id: "e1", kind: "test", status: "passed", summary: "", createdAt: 0 },
        { id: "e2", kind: "test", status: "passed", summary: "", createdAt: 1 },
        { id: "e3", kind: "lint", status: "failed", summary: "", createdAt: 2 },
        { id: "e4", kind: "type", status: "blocked", summary: "", createdAt: 3 },
        { id: "e5", kind: "build", status: "running", summary: "", createdAt: 4 },
        { id: "e6", kind: "audit", status: "skipped", summary: "", createdAt: 5 },
      ] as TuiState["evidence"]
    })
    const result = selectEvidenceSummary(state)
    expect(result.total).toBe(6)
    expect(result.passed).toBe(2)
    expect(result.failed).toBe(1)
    // blocked and running both count as "skipped" (anything not passed/failed)
    expect(result.skipped).toBe(3)
  })
})

// ── selectGateSummary ──

describe("selectors: selectGateSummary", () => {
  test("empty gates: all zeros", () => {
    const state = buildState(() => {})
    const result = selectGateSummary(state)
    expect(result).toEqual({ total: 0, pass: 0, block: 0, warn: 0, skip: 0 })
  })

  test("counts each gate status correctly", () => {
    const state = buildState(s => {
      s.gates = [
        { id: "g1", gate: "lint", status: "pass", createdAt: 0 },
        { id: "g2", gate: "test", status: "pass", createdAt: 1 },
        { id: "g3", gate: "type", status: "block", createdAt: 2 },
        { id: "g4", gate: "audit", status: "warn", createdAt: 3 },
        { id: "g5", gate: "size", status: "skip", createdAt: 4 },
      ] as TuiState["gates"]
    })
    const result = selectGateSummary(state)
    expect(result.total).toBe(5)
    expect(result.pass).toBe(2)
    expect(result.block).toBe(1)
    expect(result.warn).toBe(1)
    expect(result.skip).toBe(1)
  })
})

// ── selectHeaderStatus ──

describe("selectors: selectHeaderStatus", () => {
  test("returns header fields from state", () => {
    const state = buildState(s => {
      s.status = "working"
      s.modelName = "deepseek-v4-pro"
      s.errorLine = ""
      s.done = false
      s.queueCount = 2
    })
    const result = selectHeaderStatus(state)
    expect(result).toEqual({
      status: "working",
      modelName: "deepseek-v4-pro",
      error: "",
      done: false,
      queueCount: 2,
    })
  })

  test("with error line populated", () => {
    const state = buildState(s => {
      s.errorLine = "Error: something failed"
      s.done = true
    })
    const result = selectHeaderStatus(state)
    expect(result.error).toBe("Error: something failed")
    expect(result.done).toBe(true)
  })

  test("default initial state returns expected values", () => {
    const state = createInitialTuiState()
    const result = selectHeaderStatus(state)
    expect(result.done).toBe(true)
    expect(result.queueCount).toBe(0)
    expect(result.error).toBe("")
  })
})

// ── selectRightRail ──

describe("selectors: selectRightRail", () => {
  test("returns dashboard fields from state", () => {
    const state = buildState(s => {
      s.round = 5
      s.tokens = {
        inputTokens: 50000,
        outputTokens: 0,
        contextMax: 128000,
        cacheHitRate: 80,
      }
      s.cacheHitHistory = [50, 60, 70, 80]
      s.rippleFindings = [
        { file: "src/a.ts", severity: "block", reason: "circular import" },
      ]
      s.dashToolHistory = [
        { name: "read_file", status: "done" },
        { name: "write_file", status: "running" },
      ]
    })
    const result = selectRightRail(state)
    expect(result.round).toBe(5)
    expect(result.contextTokens).toBe(50000)
    expect(result.contextMax).toBe(128000)
    expect(result.cacheHitRate).toBe(80)
    expect(result.cacheHits).toEqual([50, 60, 70, 80])
    expect(result.rippleFindings).toHaveLength(1)
    expect(result.toolHistory).toHaveLength(2)
  })

  test("taskProgress hidden during planning phase (returns zeros)", () => {
    const state = buildState(s => {
      s.task = {
        taskId: "t1",
        title: "Plan",
        phase: "planning",
        done: 3,
        total: 10,
        current: "analyzing",
      }
    })
    const result = selectRightRail(state)
    expect(result.taskProgress).toEqual({ done: 0, total: 0, current: "" })
  })

  test("taskProgress visible during building phase", () => {
    const state = buildState(s => {
      s.task = {
        taskId: "t1",
        title: "Build",
        phase: "building",
        done: 3,
        total: 10,
        current: "step 4",
      }
    })
    const result = selectRightRail(state)
    expect(result.taskProgress).toEqual({ done: 3, total: 10, current: "step 4" })
  })

  test("taskProgress zeros when no task assigned", () => {
    const state = createInitialTuiState()
    const result = selectRightRail(state)
    expect(result.taskProgress).toEqual({ done: 0, total: 0, current: "" })
  })

  test("taskProgress visible during complete phase", () => {
    const state = buildState(s => {
      s.task = {
        taskId: "t1",
        title: "Done",
        phase: "complete",
        done: 10,
        total: 10,
        current: "",
      }
    })
    const result = selectRightRail(state)
    expect(result.taskProgress).toEqual({ done: 10, total: 10, current: "" })
  })

  test("taskProgress handles missing done/total/current fields gracefully", () => {
    const state = buildState(s => {
      s.task = { phase: "building" } // partial task object
    })
    const result = selectRightRail(state)
    expect(result.taskProgress).toEqual({ done: 0, total: 0, current: "" })
  })

  test("thinkingChain defaults to undefined", () => {
    const state = createInitialTuiState()
    const result = selectRightRail(state)
    expect(result.thinkingChain).toBeUndefined()
  })

  test("cacheHitRate defaults to 0 when undefined in tokens", () => {
    const state = buildState(s => {
      s.tokens = { inputTokens: 0, outputTokens: 0, contextMax: 0 }
      // cacheHitRate not set
    })
    const result = selectRightRail(state)
    expect(result.cacheHitRate).toBe(0)
  })
})

// ── Integration: reducer + selectors ──

describe("selectors: integration with reducer", () => {
  test("replay events then query selectors yields consistent view", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "user.message", text: "hi" }, 1000)
    state = reduceTuiEvent(state, { type: "assistant.delta", text: "Hello!" }, 1001)
    state = reduceTuiEvent(state, { type: "assistant.final", text: "Hello!" }, 1002)
    state = reduceTuiEvent(state, {
      type: "tool.started",
      id: "t1",
      tool: "read_file",
      summary: "reading",
    }, 1003)
    state = reduceTuiEvent(state, {
      type: "tool.finished",
      id: "t1",
      ok: true,
      outputSummary: "content",
    }, 1004)
    state = reduceTuiEvent(state, {
      type: "gate.result",
      gate: "lint",
      status: "pass",
    }, 1005)

    // Header should reflect done=true (no ui.done dispatched, so default)
    // Actually we need to dispatch ui.done for the loop to be "done"
    state = reduceTuiEvent(state, { type: "ui.done", done: true }, 1006)

    const header = selectHeaderStatus(state)
    expect(header.done).toBe(true)

    const tools = selectRecentTools(state, 5)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.status).toBe("passed")

    const gates = selectGateSummary(state)
    expect(gates.pass).toBe(1)

    const visible = selectVisibleMessages(state, { height: 50, scrollOffset: 0 })
    // 3 messages: user, assistant (finalized), pending assistant removed
    // user.message creates 2 (user + pending), final keeps assistant non-pending
    expect(visible.messages.length).toBe(2)
    expect(visible.maxOffset).toBe(0) // fits in 50-line viewport
  })
})
