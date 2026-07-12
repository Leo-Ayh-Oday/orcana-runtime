/** Tests for TuiEvent reducer — covers PR-1 8 acceptance points (1-7 here).
 *
 *  Points covered:
 *    1. delta accumulation
 *    2. final clears streamingText
 *    3. tool started→finished
 *    4. orphan tool.finished
 *    5. gate.result ring buffer
 *    6. limit trimming
 *    7. no mutation
 *    (8. selector scrollOffset/height — in selectors.test.ts)
 */

import { describe, expect, test } from "bun:test"
import {
  createInitialTuiState,
  reduceTuiEvent,
  LIMITS,
} from "../../src/tui/state/event-reducer"
import type { TuiState } from "../../src/tui/state/types"

// ── Helpers ──

/** Apply a sequence of events to a fresh state, returning the final state. */
function replay(events: Array<{ event: Parameters<typeof reduceTuiEvent>[1]; now?: number }>): TuiState {
  let state = createInitialTuiState()
  for (const { event, now } of events) {
    state = reduceTuiEvent(state, event, now ?? 1000)
  }
  return state
}

// ── Tests ──

describe("event-reducer: delta accumulation", () => {
  test("assistant.delta accumulates into streamingText and pending message", () => {
    const now = 1000
    let state = createInitialTuiState()
    // user.message creates user + pending assistant messages
    state = reduceTuiEvent(state, { type: "user.message", text: "hello" }, now)
    // Dispatch deltas
    state = reduceTuiEvent(state, { type: "assistant.delta", text: "Hello " }, now + 1)
    state = reduceTuiEvent(state, { type: "assistant.delta", text: "world" }, now + 2)

    expect(state.streamingText).toBe("Hello world")
    // Find the pending assistant message
    const pending = state.messages.find(m => m.role === "assistant" && m.pending)
    expect(pending).toBeDefined()
    expect(pending!.text).toBe("Hello world")
  })

  test("assistant.delta without prior user.message creates a pending assistant message", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "assistant.delta", text: "orphan delta" }, 1000)

    expect(state.streamingText).toBe("orphan delta")
    const pending = state.messages.find(m => m.role === "assistant" && m.pending)
    expect(pending).toBeDefined()
    expect(pending!.text).toBe("orphan delta")
  })

  test("empty assistant.delta is a no-op", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "user.message", text: "hi" }, 1000)
    const beforeDelta = state
    state = reduceTuiEvent(state, { type: "assistant.delta", text: "" }, 1001)
    // streamingText stays empty, no new messages
    expect(state.streamingText).toBe("")
    expect(state.messages).toBe(beforeDelta.messages)
  })
})

describe("event-reducer: assistant.final clears streamingText", () => {
  test("assistant.final clears streamingText and marks message non-pending", () => {
    const now = 2000
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "user.message", text: "hi" }, now)
    state = reduceTuiEvent(state, { type: "assistant.delta", text: "streaming..." }, now + 1)

    expect(state.streamingText).toBe("streaming...")

    state = reduceTuiEvent(state, { type: "assistant.final", text: "Final answer" }, now + 2)

    expect(state.streamingText).toBe("")
    const pending = state.messages.find(m => m.role === "assistant" && m.pending)
    expect(pending).toBeUndefined()
    const assistant = state.messages.find(m => m.role === "assistant")
    expect(assistant).toBeDefined()
    expect(assistant!.text).toBe("Final answer")
  })

  test("assistant.final with empty text preserves accumulated deltas", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, { type: "user.message", text: "hi" }, 1000)
    state = reduceTuiEvent(state, { type: "assistant.delta", text: "accumulated" }, 1001)
    state = reduceTuiEvent(state, { type: "assistant.final", text: "" }, 1002)

    expect(state.streamingText).toBe("")
    const assistant = state.messages.find(m => m.role === "assistant")
    expect(assistant).toBeDefined()
    expect(assistant!.text).toBe("accumulated")
    expect(assistant!.pending).toBeFalsy()
  })
})

describe("event-reducer: tool started→finished", () => {
  test("tool.started creates running tool, tool.finished updates to passed", () => {
    const now = 3000
    let state = createInitialTuiState()

    state = reduceTuiEvent(state, {
      type: "tool.started",
      id: "tool-1",
      tool: "read_file",
      summary: "Reading file.ts",
    }, now)

    expect(state.tools).toHaveLength(1)
    expect(state.tools[0]!.status).toBe("running")
    expect(state.tools[0]!.tool).toBe("read_file")
    expect(state.tools[0]!.startedAt).toBe(now)
    // dashToolHistory gets a "running" entry
    expect(state.dashToolHistory).toHaveLength(1)
    expect(state.dashToolHistory[0]!.name).toBe("read_file")
    expect(state.dashToolHistory[0]!.status).toBe("running")

    state = reduceTuiEvent(state, {
      type: "tool.finished",
      id: "tool-1",
      ok: true,
      outputSummary: "file content...",
    }, now + 100)

    expect(state.tools).toHaveLength(1)
    expect(state.tools[0]!.status).toBe("passed")
    expect(state.tools[0]!.outputSummary).toBe("file content...")
    expect(state.tools[0]!.finishedAt).toBe(now + 100)
    expect(state.tools[0]!.durationMs).toBe(100)
    // dashToolHistory gets a "done" entry
    expect(state.dashToolHistory).toHaveLength(2)
    expect(state.dashToolHistory[1]!.status).toBe("done")
  })

  test("tool.finished with ok=false sets status to failed", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, {
      type: "tool.started", id: "t1", tool: "write_file", summary: "Writing",
    }, 1000)
    state = reduceTuiEvent(state, {
      type: "tool.finished", id: "t1", ok: false, outputSummary: "Permission denied",
    }, 1001)

    expect(state.tools[0]!.status).toBe("failed")
  })
})

describe("event-reducer: orphan tool.finished", () => {
  test("tool.finished without matching tool.started creates orphan entry", () => {
    const now = 4000
    let state = createInitialTuiState()

    state = reduceTuiEvent(state, {
      type: "tool.finished",
      id: "unknown-tool",
      ok: true,
      outputSummary: "orphan result",
    }, now)

    expect(state.tools).toHaveLength(1)
    expect(state.tools[0]!.status).toBe("orphan")
    expect(state.tools[0]!.id).toBe("unknown-tool")
    expect(state.tools[0]!.outputSummary).toBe("orphan result")
    expect(state.tools[0]!.finishedAt).toBe(now)
    // dashToolHistory should NOT have an entry (orphan has no tool name)
    expect(state.dashToolHistory).toHaveLength(0)
  })
})

describe("event-reducer: gate.result ring buffer", () => {
  test("gate.result respects ring buffer limit", () => {
    const now = 5000
    let state = createInitialTuiState()

    // Push LIMITS.gates + 50 gate events
    const total = LIMITS.gates + 50
    for (let i = 0; i < total; i++) {
      state = reduceTuiEvent(state, {
        type: "gate.result",
        gate: `gate-${i}`,
        status: "pass",
      }, now + i)
    }

    expect(state.gates).toHaveLength(LIMITS.gates)
    // Oldest 50 gates should be trimmed
    expect(state.gates[0]!.gate).toBe(`gate-${50}`)
    // Newest gate should be present
    expect(state.gates[state.gates.length - 1]!.gate).toBe(`gate-${total - 1}`)
  })
})

describe("event-reducer: limit trimming", () => {
  test("messages respect ring buffer limit", () => {
    const now = 6000
    let state = createInitialTuiState()

    // Push more than LIMITS.messages event messages (each unique → no dedup)
    const total = LIMITS.messages + 10
    for (let i = 0; i < total; i++) {
      state = reduceTuiEvent(state, {
        type: "ui.event_message",
        kind: "tool",
        text: `event ${i}`,
        minIntervalMs: 0, // No dedup interval
      }, now + i)
    }

    expect(state.messages).toHaveLength(LIMITS.messages)
  })

  test("tools respect ring buffer limit", () => {
    let state = createInitialTuiState()
    for (let i = 0; i < LIMITS.tools + 10; i++) {
      state = reduceTuiEvent(state, {
        type: "tool.started",
        id: `tool-${i}`,
        tool: `tool_${i}`,
        summary: "",
      }, 1000 + i)
    }
    expect(state.tools).toHaveLength(LIMITS.tools)
  })

  test("errors respect ring buffer limit", () => {
    let state = createInitialTuiState()
    for (let i = 0; i < LIMITS.errors + 10; i++) {
      state = reduceTuiEvent(state, {
        type: "error",
        message: `error ${i}`,
      }, 1000 + i)
    }
    expect(state.errors).toHaveLength(LIMITS.errors)
  })

  test("dashToolHistory respects ring buffer limit", () => {
    let state = createInitialTuiState()
    for (let i = 0; i < LIMITS.dashToolHistory + 10; i++) {
      state = reduceTuiEvent(state, {
        type: "tool.started",
        id: `t-${i}`,
        tool: `tool_${i}`,
        summary: "",
      }, 1000 + i)
    }
    expect(state.dashToolHistory).toHaveLength(LIMITS.dashToolHistory)
  })

  test("cacheHitHistory respects ring buffer limit", () => {
    let state = createInitialTuiState()
    for (let i = 0; i < LIMITS.cacheHitHistory + 10; i++) {
      state = reduceTuiEvent(state, {
        type: "token.updated",
        cacheHitRate: i * 0.5,
      }, 1000 + i)
    }
    expect(state.cacheHitHistory).toHaveLength(LIMITS.cacheHitHistory)
  })
})

describe("event-reducer: no mutation", () => {
  test("reducer does not mutate input state", () => {
    const now = 7000
    const state = createInitialTuiState()
    // Deep clone for comparison
    const stateCopy: TuiState = JSON.parse(JSON.stringify(state))

    // Apply various events (results discarded — just checking no mutation)
    reduceTuiEvent(state, { type: "user.message", text: "test" }, now)
    reduceTuiEvent(state, { type: "assistant.delta", text: "hello" }, now + 1)
    reduceTuiEvent(state, { type: "tool.started", id: "t1", tool: "test", summary: "test" }, now + 2)
    reduceTuiEvent(state, { type: "ui.event_message", kind: "tool", text: "event", minIntervalMs: 0 }, now + 3)

    // Original state should be unchanged
    expect(state).toEqual(stateCopy)
  })

  test("reducer does not mutate _nextId", () => {
    const state = createInitialTuiState()
    const originalNextId = state._nextId

    reduceTuiEvent(state, { type: "user.message", text: "test" }, 1000)
    reduceTuiEvent(state, { type: "error", message: "err" }, 1001)

    expect(state._nextId).toBe(originalNextId)
  })

  test("reducer does not mutate messages array", () => {
    const state = createInitialTuiState()
    const originalMessagesLength = state.messages.length

    const next = reduceTuiEvent(state, { type: "user.message", text: "test" }, 1000)

    // Original state's messages should be unchanged
    expect(state.messages).toHaveLength(originalMessagesLength)
    // New state should have additional messages
    expect(next.messages.length).toBeGreaterThan(originalMessagesLength)
  })
})

// ── Additional coverage: event deduplication ──

describe("event-reducer: ui.event_message deduplication", () => {
  test("replaceKey updates one progress row instead of appending every round", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, {
      type: "ui.event_message", kind: "activity", text: "round 7",
      replaceKey: "round-progress", minIntervalMs: 0,
    }, 1000)
    state = reduceTuiEvent(state, {
      type: "ui.event_message", kind: "activity", text: "round 8",
      replaceKey: "round-progress", minIntervalMs: 0,
    }, 1001)

    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]!.text).toBe("round 8")
  })

  test("same dedupeKey within minIntervalMs is suppressed", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, {
      type: "ui.event_message", kind: "tool", text: "tool start: read_file",
      dedupeKey: "tool-start:read_file", minIntervalMs: 1000,
    }, 1000)

    expect(state.messages).toHaveLength(1)

    // Same key, within interval → suppressed
    state = reduceTuiEvent(state, {
      type: "ui.event_message", kind: "tool", text: "tool start: read_file",
      dedupeKey: "tool-start:read_file", minIntervalMs: 1000,
    }, 1500)

    expect(state.messages).toHaveLength(1) // No new message

    // Same key, after interval → allowed
    state = reduceTuiEvent(state, {
      type: "ui.event_message", kind: "tool", text: "tool start: read_file",
      dedupeKey: "tool-start:read_file", minIntervalMs: 1000,
    }, 2100)

    expect(state.messages).toHaveLength(2) // New message added
  })

  test("different dedupeKey is not suppressed", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, {
      type: "ui.event_message", kind: "tool", text: "tool start: read_file",
      dedupeKey: "tool-start:read_file", minIntervalMs: 1000,
    }, 1000)
    state = reduceTuiEvent(state, {
      type: "ui.event_message", kind: "tool", text: "tool start: write_file",
      dedupeKey: "tool-start:write_file", minIntervalMs: 1000,
    }, 1001)

    expect(state.messages).toHaveLength(2)
  })
})

// ── Additional coverage: user.message resets run state ──

describe("event-reducer: user.message resets run state", () => {
  test("user.message resets streamingText, task, dash, round, cacheHitHistory", () => {
    let state = createInitialTuiState()
    // Populate run-specific state
    state = reduceTuiEvent(state, { type: "user.message", text: "first" }, 1000)
    state = reduceTuiEvent(state, { type: "assistant.delta", text: "streaming" }, 1001)
    state = reduceTuiEvent(state, {
      type: "token.updated", cacheHitRate: 80, activeContextPercent: 47, round: 3, inputTokens: 1000,
    }, 1002)
    state = reduceTuiEvent(state, {
      type: "task.assigned",
      task: { taskId: "t1", title: "Test", phase: "building", done: 1, total: 2, current: "step" },
    }, 1003)

    expect(state.streamingText).toBe("streaming")
    expect(state.task).toBeDefined()
    expect(state.round).toBe(3)
    expect(state.cacheHitHistory).toHaveLength(1)

    // New user message resets run state
    state = reduceTuiEvent(state, { type: "user.message", text: "second" }, 1004)

    expect(state.streamingText).toBe("")
    expect(state.task).toBeUndefined()
    expect(state.round).toBe(0)
    expect(state.cacheHitHistory).toHaveLength(0)
    expect(state.tokens.activeContextPercent).toBe(0)
    expect(state.dashToolHistory).toHaveLength(0)
    expect(state.status).toBe("starting...")
    expect(state.done).toBe(false)
  })
})

// ── Additional coverage: token.updated ──

describe("event-reducer: token.updated", () => {
  test("merges token fields and updates round + cacheHitHistory", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, {
      type: "token.updated",
      inputTokens: 500,
      outputTokens: 200,
      contextMax: 100000,
      cacheHitRate: 75,
      round: 2,
    }, 1000)

    expect(state.tokens.inputTokens).toBe(500)
    expect(state.tokens.outputTokens).toBe(200)
    expect(state.tokens.contextMax).toBe(100000)
    expect(state.tokens.cacheHitRate).toBe(75)
    expect(state.round).toBe(2)
    expect(state.cacheHitHistory).toEqual([75])
  })

  test("partial update preserves previous values", () => {
    let state = createInitialTuiState()
    state = reduceTuiEvent(state, {
      type: "token.updated",
      inputTokens: 500,
      contextMax: 100000,
    }, 1000)
    state = reduceTuiEvent(state, {
      type: "token.updated",
      outputTokens: 300,
    }, 1001)

    expect(state.tokens.inputTokens).toBe(500) // preserved
    expect(state.tokens.contextMax).toBe(100000) // preserved
    expect(state.tokens.outputTokens).toBe(300) // updated
  })
})
