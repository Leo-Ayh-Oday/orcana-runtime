import { describe, expect, test } from "bun:test"
import { extractRuntimeCounters } from "../../src/tui/format-runtime"
import { createInitialTuiState } from "../../src/tui/state/event-reducer"

describe("runtime context percentage", () => {
  test("uses active request context instead of cumulative billed input", () => {
    const state = createInitialTuiState()
    state.tokens = {
      inputTokens: 1_048_576,
      outputTokens: 5_000,
      contextMax: 1_048_576,
      activeContextPercent: 42,
    }

    expect(extractRuntimeCounters(state).ctxPct).toBe(42)
  })
})
